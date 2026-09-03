import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runProcess } from './child-process/run-process'
import { removeTree } from './windows-transient-lock-removal'

/**
 * Node's rimraf hands every child back to the *retrying* entry point (`_rmchildren` -> `rimraf`),
 * so `maxRetries` is applied once per directory level and compounds: a leaf that keeps failing at
 * depth d costs roughly `retryDelay * 36 * 9^(d-1)`. A worktree's `node_modules/.pnpm/...` residue
 * is a dozen levels deep, so handing those options to a POSIX removal turns a 1 ms rejection into a
 * promise that never settles — wedging the serialized trash-deletion queue and the sweep behind it.
 *
 * `chflags uchg` is the one way to synthesize a permanently-failing leaf without root, so this is
 * macOS-only; the platform-shape ratchet in `windows-transient-lock-removal.test.ts` covers Linux.
 */
const CAN_LOCK_A_LEAF = process.platform === 'darwin'

let scratchDir = ''

async function chflags(flag: 'uchg' | 'nouchg', target: string): Promise<void> {
  await runProcess({ program: '/usr/bin/chflags', args: ['-R', flag, target], timeoutMs: 10_000 })
}

afterEach(async () => {
  if (!scratchDir) {
    return
  }
  await chflags('nouchg', scratchDir).catch(() => {})
  await rm(scratchDir, { recursive: true, force: true }).catch(() => {})
  scratchDir = ''
})

describe('recursive removal of a tree with a permanently locked leaf', () => {
  it.runIf(CAN_LOCK_A_LEAF)(
    'rejects promptly instead of compounding per level',
    async () => {
      scratchDir = await mkdtemp(join(tmpdir(), 'orca-removal-depth-'))
      const treeRoot = join(scratchDir, 'wt-1700000000000-abcdef01')
      const leafDir = join(treeRoot, 'node_modules', 'pkg')
      await mkdir(leafDir, { recursive: true })
      const leaf = join(leafDir, 'locked')
      await writeFile(leaf, 'locked\n', 'utf8')
      await chflags('uchg', leaf)

      // With `maxRetries` handed to a POSIX removal this rm is still running minutes later at this
      // depth, so the rejection itself — not the elapsed assertion — is what fails first.
      const startedAt = Date.now()
      await expect(removeTree(treeRoot)).rejects.toMatchObject({ code: 'EPERM' })

      expect(Date.now() - startedAt).toBeLessThan(10_000)
    },
    30_000
  )
})
