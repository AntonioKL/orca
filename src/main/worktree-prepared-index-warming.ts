import { gitExecFileAsync } from './git/runner'
import { WorktreeIndexWarmingOwnership } from './worktree-index-warming-ownership'

// Age past whole-second index timestamps before refreshing the prepared stat cache.
const INDEX_TIMESTAMP_AGE_MS = 1_100
const INDEX_REFRESH_TIMEOUT_MS = 15_000
let warmingDisabled = false

export function supportsPreparedIndexWarming(wslDistro?: string): boolean {
  return process.platform === 'darwin' && !wslDistro
}

export function disablePreparedIndexWarming(): void {
  warmingDisabled = true
}

export type PreparedIndexWarming = {
  start(): void
  stop(): Promise<boolean>
}

export function createPreparedIndexWarming(
  preparedPath: string,
  wslDistro?: string
): PreparedIndexWarming {
  const controller = new AbortController()
  const ownership = new WorktreeIndexWarmingOwnership(preparedPath)
  let timer: NodeJS.Timeout | undefined
  let started = false
  let pending: Promise<boolean> = Promise.resolve(true)
  return {
    start() {
      if (
        started ||
        controller.signal.aborted ||
        warmingDisabled ||
        !supportsPreparedIndexWarming(wslDistro)
      ) {
        return
      }
      started = true
      timer = setTimeout(() => {
        timer = undefined
        if (warmingDisabled) {
          return
        }
        pending = (async () => {
          try {
            await ownership.arm()
          } catch {
            disablePreparedIndexWarming()
            return false
          }
          let terminationUnverifiable = false
          try {
            if (!controller.signal.aborted) {
              await gitExecFileAsync(['update-index', '--refresh'], {
                cwd: preparedPath,
                signal: controller.signal,
                timeout: INDEX_REFRESH_TIMEOUT_MS,
                terminationBarrier: true,
                admissionTier: 'background',
                onChildSpawned: (pid) => ownership.recordPid(pid)
              })
            }
          } catch (error) {
            if (
              error &&
              typeof error === 'object' &&
              'terminationUnverifiable' in error &&
              error.terminationUnverifiable === true
            ) {
              // Bound stranded preparations if an optional child cannot be verified as exited.
              terminationUnverifiable = true
              disablePreparedIndexWarming()
              console.warn(
                `[worktree-create] index warming termination unverifiable; retaining ${preparedPath} and disabling warming`
              )
            }
          }
          if (terminationUnverifiable) {
            return false
          }
          let released: boolean
          try {
            released = await ownership.release()
          } catch {
            disablePreparedIndexWarming()
            return false
          }
          if (!released) {
            disablePreparedIndexWarming()
            console.warn(
              `[worktree-create] index warming process group live or unverifiable after Git exit; retaining ${preparedPath} and disabling warming`
            )
          }
          return released
        })()
      }, INDEX_TIMESTAMP_AGE_MS)
      timer.unref()
    },
    stop() {
      clearTimeout(timer)
      timer = undefined
      controller.abort()
      return pending
    }
  }
}

export function resetPreparedIndexWarmingForTests(): void {
  warmingDisabled = false
}
