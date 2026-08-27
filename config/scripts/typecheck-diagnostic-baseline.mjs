import { spawnSync } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))

function parseArgs(argv) {
  const options = { write: false }
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (value === '--write') {
      options.write = true
      continue
    }
    const next = argv[index + 1]
    if (!next) {
      throw new Error(`Missing value for ${value}`)
    }
    if (value === '--project') {
      options.project = next
    } else if (value === '--baseline') {
      options.baseline = next
    } else if (value === '--tsc') {
      options.tsc = next
    } else {
      throw new Error(`Unknown option: ${value}`)
    }
    index += 1
  }
  if (!options.project || !options.baseline) {
    throw new Error('Usage: --project <tsconfig> --baseline <json> [--tsc <binary>] [--write]')
  }
  return options
}

function sortDiagnostics(diagnostics) {
  return diagnostics.sort((left, right) =>
    JSON.stringify(left).localeCompare(JSON.stringify(right), 'en')
  )
}

function parseDiagnostics(output) {
  const diagnostics = []
  let current = null
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^(.*?)\((\d+),(\d+)\): error TS(\d+): (.*)$/)
    if (match) {
      current = {
        file: match[1].replaceAll('\\', '/'),
        line: Number(match[2]),
        column: Number(match[3]),
        code: Number(match[4]),
        message: match[5]
      }
      diagnostics.push(current)
      continue
    }
    const configMatch = line.match(/^error TS(\d+): (.*)$/)
    if (configMatch) {
      current = {
        file: null,
        line: null,
        column: null,
        code: Number(configMatch[1]),
        message: configMatch[2]
      }
      diagnostics.push(current)
      continue
    }
    if (current && line.trim().length > 0) {
      current.message += `\n${line.trimEnd()}`
    }
  }
  return sortDiagnostics(diagnostics)
}

function collectDiagnostics(projectPath, tscPath) {
  const result = spawnSync(
    process.execPath,
    [tscPath, '--pretty', 'false', '--noEmit', '-p', projectPath],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024
    }
  )
  if (result.error) {
    throw result.error
  }
  if (result.signal) {
    throw new Error(`TypeScript exited with signal ${result.signal}`)
  }
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  const diagnostics = parseDiagnostics(output)
  if (result.status !== 0 && diagnostics.length === 0) {
    throw new Error(`TypeScript exited ${result.status} without parseable diagnostics:\n${output}`)
  }
  return diagnostics
}

function diagnosticCounts(diagnostics) {
  const counts = new Map()
  for (const diagnostic of diagnostics) {
    const key = JSON.stringify(diagnostic)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return counts
}

function subtractDiagnostics(left, right) {
  const remaining = diagnosticCounts(right)
  return left.filter((diagnostic) => {
    const key = JSON.stringify(diagnostic)
    const count = remaining.get(key) ?? 0
    if (count === 0) {
      return true
    }
    remaining.set(key, count - 1)
    return false
  })
}

function formatDiagnostic(diagnostic) {
  const location = diagnostic.file
    ? `${diagnostic.file}:${diagnostic.line}:${diagnostic.column}`
    : '<config>'
  return `${location} TS${diagnostic.code}: ${diagnostic.message}`
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const projectPath = resolve(repoRoot, options.project)
  const baselinePath = resolve(repoRoot, options.baseline)
  const tscPath = resolve(repoRoot, options.tsc ?? 'node_modules/typescript/bin/tsc')
  const diagnostics = collectDiagnostics(projectPath, tscPath)

  if (options.write) {
    const baseline = { version: 1, diagnostics }
    await writeFile(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`)
    console.log(`Wrote ${diagnostics.length} diagnostics to ${relative(repoRoot, baselinePath)}`)
    return
  }

  const baseline = JSON.parse(await readFile(baselinePath, 'utf8'))
  if (baseline.version !== 1 || !Array.isArray(baseline.diagnostics)) {
    throw new Error(`Invalid diagnostic baseline: ${relative(repoRoot, baselinePath)}`)
  }
  const unexpected = subtractDiagnostics(diagnostics, baseline.diagnostics)
  const stale = subtractDiagnostics(baseline.diagnostics, diagnostics)
  if (unexpected.length === 0 && stale.length === 0) {
    console.log(`${options.project}: ${diagnostics.length} known diagnostics, no drift`)
    return
  }
  if (unexpected.length > 0) {
    console.error(`Unexpected diagnostics (${unexpected.length}):`)
    for (const diagnostic of unexpected) {
      console.error(formatDiagnostic(diagnostic))
    }
  }
  if (stale.length > 0) {
    console.error(`Stale allowlist entries (${stale.length}); remove fixed diagnostics:`)
    for (const diagnostic of stale) {
      console.error(formatDiagnostic(diagnostic))
    }
  }
  process.exitCode = 1
}

await main()
