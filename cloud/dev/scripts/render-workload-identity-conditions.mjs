// Renders every Workload Identity provider `attribute_condition` exactly as
// Terraform would, so contract tests can pin the resulting strings without a
// plan. Understands only the HCL subset those expressions use.
//
// Each root is loaded on its own. Only the relay root ships here; the apps and foundation
// roots stay in the private repository with the services they own.
import { readFile } from 'node:fs/promises'

const TERRAFORM_ROOTS = {
  relay: {
    directory: 'infra/terraform',
    sources: [
      'infra/terraform/relay-shared.tf',
      'infra/terraform/relay-github-actions.tf',
      'infra/terraform/relay-staging-deploy-iam.tf',
      'infra/terraform/relay-asia-topology-iam.tf',
      'infra/terraform/relay-asia-proof-iam.tf'
    ]
  }
}

export const TERRAFORM_ROOT_NAMES = Object.keys(TERRAFORM_ROOTS)

const PROVIDER_RESOURCE = 'google_iam_workload_identity_pool_provider'

function repoFile(path) {
  return new URL(`../../${path}`, import.meta.url)
}

function skipTrivia(src, index) {
  let i = index
  for (;;) {
    while (i < src.length && /\s/.test(src[i])) i += 1
    if (src[i] === '#') {
      while (i < src.length && src[i] !== '\n') i += 1
      continue
    }
    return i
  }
}

// Returns the index just past the closing quote of the string starting at `i`.
function endOfString(src, i) {
  let cursor = i + 1
  while (src[cursor] !== '"') {
    if (src[cursor] === '\\') {
      cursor += 2
      continue
    }
    if (src[cursor] === '$' && src[cursor + 1] === '{') {
      cursor = endOfInterpolation(src, cursor + 2).next
      continue
    }
    cursor += 1
  }
  return cursor + 1
}

function endOfInterpolation(src, i) {
  let depth = 1
  let cursor = i
  while (depth > 0) {
    const char = src[cursor]
    if (char === undefined) throw new Error('unterminated interpolation')
    if (char === '"') {
      cursor = endOfString(src, cursor)
      continue
    }
    if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) break
    }
    cursor += 1
  }
  return { text: src.slice(i, cursor), next: cursor + 1 }
}

class ExpressionParser {
  constructor(source, scope) {
    this.source = source
    this.scope = scope
    this.index = 0
  }

  parse() {
    const value = this.parseTernary()
    this.index = skipTrivia(this.source, this.index)
    if (this.index !== this.source.length) {
      throw new Error(`trailing expression text: ${this.source.slice(this.index)}`)
    }
    return value
  }

  peek(token) {
    this.index = skipTrivia(this.source, this.index)
    return this.source.startsWith(token, this.index)
  }

  eat(token) {
    if (!this.peek(token)) return false
    this.index += token.length
    return true
  }

  expect(token) {
    if (!this.eat(token)) {
      throw new Error(`expected ${token} at ${this.source.slice(this.index, this.index + 40)}`)
    }
  }

  parseTernary() {
    const condition = this.parseOr()
    if (!this.eat('?')) return condition
    const consequent = this.parseTernary()
    this.expect(':')
    const alternate = this.parseTernary()
    return condition ? consequent : alternate
  }

  parseOr() {
    let left = this.parseAnd()
    while (this.eat('||')) left = Boolean(this.parseAnd()) || Boolean(left)
    return left
  }

  parseAnd() {
    let left = this.parseEquality()
    while (this.eat('&&')) left = Boolean(this.parseEquality()) && Boolean(left)
    return left
  }

  parseEquality() {
    let left = this.parseUnary()
    for (;;) {
      if (this.eat('==')) left = left === this.parseUnary()
      else if (this.eat('!=')) left = left !== this.parseUnary()
      else return left
    }
  }

  parseUnary() {
    if (this.eat('(')) {
      const value = this.parseTernary()
      this.expect(')')
      return value
    }
    if (this.peek('"')) return this.parseString()
    if (this.peek('[')) return this.parseList()
    const number = /^[0-9]+/.exec(this.source.slice(this.index))
    if (number) {
      this.index += number[0].length
      return Number(number[0])
    }
    return this.parseIdentifier()
  }

  parseString() {
    this.index = skipTrivia(this.source, this.index)
    const src = this.source
    let cursor = this.index + 1
    let rendered = ''
    while (src[cursor] !== '"') {
      if (src[cursor] === '\\') {
        rendered += src[cursor + 1]
        cursor += 2
        continue
      }
      if (src[cursor] === '$' && src[cursor + 1] === '{') {
        const { text, next } = endOfInterpolation(src, cursor + 2)
        rendered += String(evaluate(text, this.scope))
        cursor = next
        continue
      }
      rendered += src[cursor]
      cursor += 1
    }
    this.index = cursor + 1
    return rendered
  }

  parseList() {
    this.expect('[')
    if (this.eat('for')) {
      const name = this.readWord()
      this.expect('in')
      const collection = this.parseUnary()
      this.expect(':')
      const bodyStart = skipTrivia(this.source, this.index)
      const bodyParser = (item) => {
        const parser = new ExpressionParser(this.source, {
          ...this.scope,
          bindings: { ...this.scope.bindings, [name]: item }
        })
        parser.index = bodyStart
        return parser
      }
      // Parse once with a placeholder binding to find where the body ends,
      // because an empty collection would never parse it.
      const probe = bodyParser('')
      probe.parseTernary()
      this.index = probe.index
      this.expect(']')
      return collection.map((item) => bodyParser(item).parseTernary())
    }
    const items = []
    if (this.eat(']')) return items
    for (;;) {
      items.push(this.parseTernary())
      if (this.eat(',')) {
        if (this.eat(']')) return items
        continue
      }
      this.expect(']')
      return items
    }
  }

  readWord() {
    this.index = skipTrivia(this.source, this.index)
    const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(this.source.slice(this.index))
    if (!match) throw new Error(`expected identifier at ${this.source.slice(this.index, this.index + 40)}`)
    this.index += match[0].length
    return match[0]
  }

  parseIdentifier() {
    const word = this.readWord()
    if (word === 'join') {
      this.expect('(')
      const separator = this.parseTernary()
      this.expect(',')
      const parts = this.parseTernary()
      this.eat(',')
      this.expect(')')
      return parts.join(separator)
    }
    if (word === 'concat') {
      this.expect('(')
      const lists = []
      for (;;) {
        lists.push(this.parseTernary())
        if (this.eat(',')) {
          if (this.eat(')')) break
          continue
        }
        this.expect(')')
        break
      }
      return lists.flat()
    }
    if (word === 'local') {
      this.expect('.')
      return resolveLocal(this.readWord(), this.scope)
    }
    if (word === 'var') {
      this.expect('.')
      const name = this.readWord()
      if (!(name in this.scope.variables)) throw new Error(`unknown variable ${name}`)
      return this.scope.variables[name]
    }
    if (word in this.scope.bindings) return this.scope.bindings[word]
    if (word === 'true') return true
    if (word === 'false') return false
    throw new Error(`unsupported identifier ${word}`)
  }
}

function evaluate(source, scope) {
  return new ExpressionParser(source, scope).parse()
}

function resolveLocal(name, scope) {
  if (scope.resolved.has(name)) return scope.resolved.get(name)
  if (!scope.locals.has(name)) throw new Error(`unknown local ${name}`)
  if (scope.resolving.has(name)) throw new Error(`local cycle at ${name}`)
  scope.resolving.add(name)
  const value = evaluate(scope.locals.get(name), { ...scope, bindings: {} })
  scope.resolving.delete(name)
  scope.resolved.set(name, value)
  return value
}

function collectLocals(source, locals) {
  const blockPattern = /^locals \{$/gm
  let match
  while ((match = blockPattern.exec(source)) !== null) {
    const end = source.indexOf('\n}\n', match.index)
    const body = source.slice(match.index + match[0].length, end)
    let name = null
    let buffer = []
    const flush = () => {
      if (name) locals.set(name, buffer.join('\n'))
    }
    for (const line of body.split('\n')) {
      const assignment = /^ {2}([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
      if (assignment) {
        flush()
        name = assignment[1]
        buffer = [assignment[2]]
        continue
      }
      if (name && line.trim() !== '' && !line.trim().startsWith('#')) buffer.push(line)
    }
    flush()
  }
}

function collectProviderFields(source, fields) {
  const pattern = new RegExp(`resource "${PROVIDER_RESOURCE}" "([A-Za-z_0-9]+)" \\{`, 'g')
  let match
  while ((match = pattern.exec(source)) !== null) {
    const end = source.indexOf('\n}\n', match.index)
    const body = source.slice(match.index, end)
    const conditionStart = body.indexOf('  attribute_condition = ')
    const conditionEnd = body.indexOf('\n\n  oidc {', conditionStart)
    const countStart = body.indexOf('  count = ')
    fields.set(match[1], {
      count: body.slice(countStart + '  count = '.length, body.indexOf('\n', countStart)),
      condition: body.slice(conditionStart + '  attribute_condition = '.length, conditionEnd)
    })
  }
}

function collectVariableDefaults(source, variables) {
  const pattern = /variable "([A-Za-z_0-9]+)" \{([\s\S]*?)\n\}/g
  let match
  while ((match = pattern.exec(source)) !== null) {
    const fallback = /\n\s*default\s*=\s*"([^"]*)"/.exec(match[2])
    if (fallback) variables[match[1]] = fallback[1]
  }
}

function collectTfvars(source, variables) {
  for (const line of source.split('\n')) {
    const assignment = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*"([^"]*)"\s*$/.exec(line)
    if (assignment) variables[assignment[1]] = assignment[2]
  }
}

async function loadScope(root, environment) {
  const { directory, sources } = TERRAFORM_ROOTS[root] ?? {}
  if (!sources) throw new Error(`unknown terraform root ${root}`)
  const locals = new Map()
  const providers = new Map()
  for (const path of sources) {
    const source = await readFile(repoFile(path), 'utf8')
    collectLocals(source, locals)
    collectProviderFields(source, providers)
  }
  const variables = {}
  collectVariableDefaults(await readFile(repoFile(`${directory}/variables.tf`), 'utf8'), variables)
  collectTfvars(
    await readFile(repoFile(`${directory}/environments/${environment}.tfvars`), 'utf8'),
    variables
  )
  return {
    providers,
    scope: { locals, variables, bindings: {}, resolved: new Map(), resolving: new Set() }
  }
}

// Rendered `attribute_condition` per provider that the given root creates in the environment.
export async function renderRootAttributeConditions(root, environment) {
  const { providers, scope } = await loadScope(root, environment)
  const rendered = {}
  for (const [name, fields] of providers) {
    if (evaluate(fields.count, scope) === 0) continue
    rendered[name] = evaluate(fields.condition, scope)
  }
  return rendered
}

// Every root's rendered conditions, keyed by root and then by provider.
export async function renderAttributeConditions(environment) {
  const rendered = {}
  for (const root of TERRAFORM_ROOT_NAMES) {
    rendered[root] = await renderRootAttributeConditions(root, environment)
  }
  return rendered
}

export async function readTerraformLocal(name, environment, root = 'relay') {
  const { scope } = await loadScope(root, environment)
  return resolveLocal(name, scope)
}
