import { cpSync, copyFileSync, existsSync, mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runProcessSync } from '../../src/shared/child-process/run-process.ts'
import { removeTreeSync } from '../../src/shared/windows-transient-lock-removal.ts'

/**
 * Run the command that actually consumes the patch hashes.
 *
 * A hash comparison is not this check. `@vscode/windows-process-tree@0.8.0` shipped
 * twice with a hand-computed `sha256(patchBytes)` in the lockfile, and two separate
 * reviews "verified" it by recomputing the same number the same wrong way. pnpm
 * hashes the **LF-normalized** content, so a CRLF patch makes the raw digest a value
 * pnpm will never produce, and `--frozen-lockfile` dies with
 * ERR_PNPM_LOCKFILE_CONFIG_MISMATCH on every runner. An independent check that
 * repeats the original assumption is not independent; only the installer is.
 *
 * `--lockfile-only --ignore-scripts` keeps it to the resolution pnpm rejects on,
 * with no node_modules and no native builds.
 */
const PROJECT_DIR = resolve(import.meta.dirname, '../..')

/** runProcessSync wants an absolute program on Windows, where pnpm is a `.cmd` shim. */
function resolvePnpmProgram() {
  const names = process.platform === 'win32' ? ['pnpm.exe', 'pnpm.cmd'] : ['pnpm']
  for (const dir of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
    for (const name of names) {
      const candidate = join(dir, name)
      if (existsSync(candidate)) {
        return candidate
      }
    }
  }
  return null
}

describe('patched dependencies', () => {
  it('installs with --frozen-lockfile, which is what validates every patch hash', () => {
    const pnpm = resolvePnpmProgram()
    expect(pnpm, 'pnpm must be on PATH; it is the only thing that can check this').not.toBeNull()

    // A copy, because a --frozen-lockfile run still rewrites parts of the
    // lockfile this repo does not track, and the real one must not move.
    const scratch = mkdtempSync(join(tmpdir(), 'orca-frozen-install-'))
    try {
      for (const file of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml']) {
        copyFileSync(join(PROJECT_DIR, file), join(scratch, file))
      }
      mkdirSync(join(scratch, 'config'), { recursive: true })
      cpSync(join(PROJECT_DIR, 'config', 'patches'), join(scratch, 'config', 'patches'), {
        recursive: true
      })

      const result = runProcessSync({
        program: pnpm,
        args: ['install', '--frozen-lockfile', '--lockfile-only', '--ignore-scripts'],
        cwd: scratch,
        timeoutMs: 300_000
      })

      expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(0)
    } finally {
      removeTreeSync(scratch)
    }
  })
})
