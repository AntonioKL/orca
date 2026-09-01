import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Guard the one idiom that keeps re-killing Windows tooling.
 *
 * Node >= 20 refuses to spawn a `.cmd`/`.bat` without `shell: true` (the
 * CVE-2024-27980 mitigation), so `spawnSync('pnpm.cmd', …)` throws EINVAL
 * before the command runs at all. On Windows that reads as a broken toolchain
 * rather than a failing check, so the failure gets shrugged off — which is
 * exactly how `check:code-quality:changed` ran dead for months.
 *
 * `src/` has its own chokepoint (runProcess) and its own ratchet. `config/`
 * scripts are plain `.mjs` outside that module boundary, so they need this
 * narrower one: the shim idiom may not appear in a new script. The list only
 * shrinks. Resolve the real executable instead — `oxlint-cli-invocation.mjs`
 * and `windows-process-tree-gyp-rebuild.mjs` show the shape.
 */
const WINDOWS_SHIM_LITERAL = /['"][\w./\\-]*(?:pnpm|npm|npx|yarn|node-gyp|oxlint)\.(?:cmd|bat)['"]/i

/** Scripts that still carry the idiom, held as data so it reads as the list it is. */
const WINDOWS_SHIM_SPAWN_ALLOWLIST = [
  // Owns the pnpm invocation decision for every other script.
  'pnpm-cli-invocation.mjs',
  'pnpm-cli-invocation.test.mjs',
  // macOS-only build paths; the win32 branch is dead code there.
  'build-mac-local.mjs',
  // Benchmarks, repros and e2e drivers — developer-invoked, never a CI gate.
  'build-orcad-prebuilds.mjs',
  'ensure-native-runtime.test.mjs',
  'run-ai-vault-typing-bench.mjs',
  'run-ephemeral-vm-runtime-store-rollback-repro.mjs',
  'run-local-ssh-browser-routing-e2e.mjs',
  'run-multi-client-navigation-e2e.mjs',
  'run-multi-workspace-typing-bench.mjs',
  'run-nested-runtime-ssh-e2e.mjs',
  'run-ssh-client-hosted-browser-drop-reconnect-e2e.mjs',
  'run-ssh-codex-artifacts-repro-e2e.mjs',
  'run-ssh-docker-e2e.mjs',
  'run-ssh-docker-perf-e2e.mjs',
  'run-ssh-docker-terminal-parking-e2e.mjs',
  'run-ssh-docker-watcher-isolation-e2e.mjs',
  'run-ssh-staged-upload-reliability.mjs',
  'run-terminal-ibus-hangul-e2e.mjs',
  'run-terminal-scale-perf-e2e.mjs',
  // Routes npx.cmd through an explicit `cmd.exe /d /s /c`, which is the correct form.
  'verify-skill-update-roundtrip.mjs'
]

/** Drop comment-only lines so prose about the old idiom is not an offender. */
function codeText(contents) {
  return contents
    .split('\n')
    .filter((line) => !/^\s*(?:\/\/|\/\*|\*)/.test(line))
    .join('\n')
}

describe('windows cmd shim spawn boundary', () => {
  const scriptsDir = import.meta.dirname
  const scripts = readdirSync(scriptsDir).filter((name) => /\.[cm]?js$/.test(name))
  const offenders = scripts.filter((name) =>
    WINDOWS_SHIM_LITERAL.test(codeText(readFileSync(path.join(scriptsDir, name), 'utf8')))
  )

  it('scans a plausible number of scripts', () => {
    // A broken directory or extension filter would make the guard silently vacuous.
    expect(scripts.length).toBeGreaterThan(100)
  })

  it('has no unlisted script spawning a Windows .cmd shim', () => {
    const unlisted = offenders.filter((name) => !WINDOWS_SHIM_SPAWN_ALLOWLIST.includes(name))
    expect(
      unlisted,
      'Node cannot spawn a .cmd without a shell. Resolve the real executable — see oxlint-cli-invocation.mjs.'
    ).toEqual([])
  })

  it('has no stale allowlist entry', () => {
    const stale = WINDOWS_SHIM_SPAWN_ALLOWLIST.filter((name) => !offenders.includes(name))
    expect(stale, 'Script no longer names a .cmd shim — delete the line.').toEqual([])
  })
})
