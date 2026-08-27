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
    baseBaseline: join(fixtureDir, 'base-baseline.json'),
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
  it('loads PR-base baselines in desktop and mobile CI', () => {
    const desktopWorkflow = readFileSync(join(repoRoot, '.github/workflows/pr.yml'), 'utf8')
    const mobileWorkflow = readFileSync(join(repoRoot, '.github/workflows/mobile.yml'), 'utf8')

    expect(desktopWorkflow).toContain('$BASE_SHA:config/typecheck-e2e-diagnostics.json')
    expect(mobileWorkflow).toContain('$BASE_SHA:mobile/typecheck-test-diagnostics.json')
    expect(desktopWorkflow).toContain('TYPECHECK_BASELINE_BASE_PATH=')
    expect(mobileWorkflow).toContain('TYPECHECK_BASELINE_BASE_PATH=')
  })

  it('requires recorded diagnostics to remain present', () => {
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

  it('rejects another occurrence of an allowlisted diagnostic', () => {
    const paths = createFixture("const first: number = 'bad'\n")
    expect(runBaseline(paths, ['--write']).status).toBe(0)

    writeFileSync(paths.source, "const first: number = 'bad'\nconst second: number = 'also-bad'\n")
    const unexpected = runBaseline(paths)
    expect(unexpected.status).toBe(1)
    expect(unexpected.stderr).toContain('Unexpected diagnostics (1)')
  })

  it('does not drift when only diagnostic positions move', () => {
    const paths = createFixture("const value: number = 'bad'\n")
    expect(runBaseline(paths, ['--write']).status).toBe(0)

    writeFileSync(paths.source, "\nconst value: number = 'bad'\n")
    expect(runBaseline(paths).status).toBe(0)
  })

  it('refuses to regenerate a baseline that grows from the PR base', () => {
    const paths = createFixture("const first: number = 'bad'\n")
    expect(runBaseline(paths, ['--write']).status).toBe(0)
    writeFileSync(paths.baseBaseline, readFileSync(paths.baseline, 'utf8'))

    writeFileSync(paths.source, "const first: number = 'bad'\nconst second: boolean = 'also-bad'\n")
    const growth = runBaseline(paths, ['--write', '--base-baseline', paths.baseBaseline])
    expect(growth.status).toBe(1)
    expect(growth.stderr).toContain('Diagnostic baseline grew (1)')
    expect(JSON.parse(readFileSync(paths.baseline, 'utf8')).diagnostics).toHaveLength(1)
  })
})
