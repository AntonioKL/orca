import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  WorktreeIndexWarmingOwnership,
  canReclaimIndexWarming
} from './worktree-index-warming-ownership'
let root: string
let prepared: string
const platform = process.platform
beforeEach(async () => {
  Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' })
  root = await mkdtemp(join(tmpdir(), 'orca-index-ownership-'))
  prepared = join(root, 'prepared')
})
afterEach(async () => {
  vi.restoreAllMocks()
  Object.defineProperty(process, 'platform', { configurable: true, value: platform })
  await rm(root, { recursive: true, force: true })
})
it('retains the pre-spawn window and clears ownership only after PID persistence', async () => {
  const owner = new WorktreeIndexWarmingOwnership(prepared)
  await owner.arm()
  expect(await canReclaimIndexWarming(prepared)).toBe(false)
  owner.recordPid(12345)
  await owner.release()
  await expect(readFile(`${prepared}.index-warming`)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await canReclaimIndexWarming(prepared)).toBe(true)
})
it('does not overwrite another ownership record', async () => {
  await writeFile(`${prepared}.index-warming`, '12345\n')
  await expect(new WorktreeIndexWarmingOwnership(prepared).arm()).rejects.toMatchObject({
    code: 'EEXIST'
  })
  expect(await readFile(`${prepared}.index-warming`, 'utf8')).toBe('12345\n')
})
it.each(['ESRCH', 'EPERM', undefined])(
  'only reclaims a recorded group on ESRCH (%s)',
  async (code) => {
    await writeFile(`${prepared}.index-warming`, '12345\n')
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
      if (code) {
        throw Object.assign(new Error('probe'), { code })
      }
      return true
    })
    expect(await canReclaimIndexWarming(prepared)).toBe(code === 'ESRCH')
    expect(kill).toHaveBeenCalledExactlyOnceWith(-12345, 0)
  }
)
it.each(['pending\n', '', '0\n', '-10\n', '1.5\n', '12345', '9'.repeat(40)])(
  'retains incomplete ownership %j',
  async (text) => {
    await writeFile(`${prepared}.index-warming`, text)
    const kill = vi.spyOn(process, 'kill')
    expect(await canReclaimIndexWarming(prepared)).toBe(false)
    expect(kill).not.toHaveBeenCalled()
  }
)
it('never uses a Mac lease as evidence for another execution host', async () => {
  const kill = vi.spyOn(process, 'kill')
  expect(await canReclaimIndexWarming(prepared, 'Ubuntu')).toBe(false)
  Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })
  expect(await canReclaimIndexWarming(prepared)).toBe(false)
  expect(kill).not.toHaveBeenCalled()
})
