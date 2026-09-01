import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MOBILE_WEB_BRIDGE_OPERATIONS } from './bridge-operation-registry'

const REPO_ROOT = resolve(__dirname, '..', '..', '..')
const PAGE_DIR = join(REPO_ROOT, 'src', 'mobile-web', 'src')
const SHELL_DIR = join(REPO_ROOT, 'mobile', 'src', 'mobile-web')

const registered = new Set(
  Object.entries(MOBILE_WEB_BRIDGE_OPERATIONS).flatMap(([capability, operations]) =>
    operations.map((operation) => `${capability}.${operation}`)
  )
)

function sources(dir: string, keep: (name: string) => boolean): { name: string; text: string }[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith('.ts') && !name.includes('.test.') && keep(name))
    .map((name) => ({ name, text: readFileSync(join(dir, name), 'utf8') }))
}

describe('mobile web bridge operation registry census', () => {
  it('registers every capability and operation pair a page request client names', () => {
    const files = sources(PAGE_DIR, () => true)
    const named = new Set<string>()
    for (const { text } of files) {
      for (const match of text.matchAll(/\.request\(\s*'([A-Za-z]+)',\s*'([A-Za-z]+)'/g)) {
        named.add(`${match[1]}.${match[2]}`)
      }
    }

    expect(files.length).toBeGreaterThanOrEqual(40)
    expect(named.size).toBeGreaterThanOrEqual(150)
    expect([...named].filter((pair) => !registered.has(pair))).toEqual([])
  })

  // A bare `string` here is how `workspace.creationRetiredNames` shipped unregistered: the helper
  // erased the operation name before the compiler could check it against the registry.
  it('types every page request client operation parameter against the registry', () => {
    const files = sources(PAGE_DIR, (name) => name.endsWith('-request-client.ts'))
    const untyped = files
      .filter(({ text }) => /\boperation\??:\s*string\b/.test(text))
      .map(({ name }) => name)

    expect(files.map(({ name }) => name)).toContain('mobile-web-one-shot-request-client.ts')
    expect(files.length).toBeGreaterThanOrEqual(20)
    expect(untyped).toEqual([])
  })

  it('names every registered operation in a shell module outside the grant tables', () => {
    const files = sources(SHELL_DIR, (name) => !name.startsWith('mobile-web-production-'))
    const named = new Set<string>()
    for (const { text } of files) {
      for (const match of text.matchAll(/'([A-Za-z][A-Za-z0-9]*)'/g)) {
        named.add(match[1]!)
      }
    }
    const undispatched = [...registered].filter(
      (pair) => !named.has(pair.slice(pair.indexOf('.') + 1))
    )

    expect(files.length).toBeGreaterThanOrEqual(100)
    expect(undispatched).toEqual([])
  })
})
