import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
const script = join(repoRoot, 'config/scripts/typecheck-diagnostic-baseline.mjs')
const tsc = join(repoRoot, 'node_modules/typescript/bin/tsc')
let fixtureDir

afterEach(() => {
  if (fixtureDir) {
    rmSync(fixtureDir, { recursive: true, force: true })
  }
  fixtureDir = undefined
})

function createFixture(source) {
  fixtureDir = mkdtempSync(join(tmpdir(), 'orca-typecheck-baseline-'))
  writeFileSync(
    join(fixtureDir, 'tsconfig.json'),
    JSON.stringify({ compilerOptions: { strict: true, noEmit: true }, include: ['source.ts'] })
  )
  writeFileSync(join(fixtureDir, 'source.ts'), source)
  return {
    baseline: join(fixtureDir, 'baseline.json'),
    project: join(fixtureDir, 'tsconfig.json'),
    source: join(fixtureDir, 'source.ts')
  }
}

function runBaseline(paths, extraArgs = []) {
  return spawnSync(
    process.execPath,
    [script, '--project', paths.project, '--baseline', paths.baseline, '--tsc', tsc, ...extraArgs],
    { cwd: repoRoot, encoding: 'utf8' }
  )
}

describe('typecheck diagnostic baseline', () => {
  it('accepts only the exact recorded diagnostics', () => {
    const paths = createFixture("const value: number = 'bad'\n")
    expect(runBaseline(paths, ['--write']).status).toBe(0)
    expect(JSON.parse(readFileSync(paths.baseline, 'utf8')).diagnostics).toHaveLength(1)
    expect(runBaseline(paths).status).toBe(0)

    writeFileSync(paths.source, 'const value: number = 1\n')
    const stale = runBaseline(paths)
    expect(stale.status).toBe(1)
    expect(stale.stderr).toContain('Stale allowlist entries (1)')
  })

  it('rejects a diagnostic added after a clean baseline', () => {
    const paths = createFixture('const value: number = 1\n')
    expect(runBaseline(paths, ['--write']).status).toBe(0)

    writeFileSync(paths.source, "const value: number = 'bad'\n")
    const unexpected = runBaseline(paths)
    expect(unexpected.status).toBe(1)
    expect(unexpected.stderr).toContain('Unexpected diagnostics (1)')
  })
})
