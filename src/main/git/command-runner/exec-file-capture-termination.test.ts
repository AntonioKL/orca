import { expect, it, vi } from 'vitest'
const run = vi.hoisted(() => vi.fn())
vi.mock('../../../shared/child-process/run-process', () => ({ runProcess: run }))
import { execFileCaptureToTermination } from './exec-file-capture'
it.each([false, true])(
  'preserves unverifiable termination (%s) in capture errors',
  async (unverifiable) => {
    run.mockResolvedValue({
      code: null,
      signal: 'SIGTERM',
      stdout: '',
      stderr: '',
      timedOut: false,
      ...(unverifiable ? { terminationUnverifiable: true } : {})
    })
    const error = await execFileCaptureToTermination('git', ['update-index', '--refresh'], {
      cwd: '/repo'
    }).catch((error) => error)
    expect(error).toBeInstanceOf(Error)
    expect(error.terminationUnverifiable).toBe(unverifiable ? true : undefined)
  }
)
