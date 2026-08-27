import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  REACT_COMMIT_CASCADE_BREADCRUMB,
  REACT_COMMIT_CASCADE_NOTICE_LIMIT,
  resetReactCommitCascadeTelemetryForTests
} from './react-commit-cascade-telemetry'
import {
  REACT_COMMIT_CASCADE_INSTALL_CHECK_MS,
  REACT_COMMIT_CASCADE_UNINSTALLED_BREADCRUMB,
  installReactCommitCascadeObserver,
  resetReactCommitCascadeObserverForTests
} from './react-commit-cascade-observer'
import type { ReactDevtoolsCommitHook } from './react-devtools-commit-hook-shim'

const recordBreadcrumb = vi.fn()
vi.mock('@/lib/crash-breadcrumb-recorder', () => ({
  recordRendererCrashBreadcrumb: (name: string, data?: unknown) => recordBreadcrumb(name, data)
}))

const CASCADING_ROOT = { pendingLanes: 2 }

function readHook(): ReactDevtoolsCommitHook {
  return (globalThis as { __REACT_DEVTOOLS_GLOBAL_HOOK__?: ReactDevtoolsCommitHook })
    .__REACT_DEVTOOLS_GLOBAL_HOOK__ as ReactDevtoolsCommitHook
}

beforeEach(() => {
  recordBreadcrumb.mockClear()
  resetReactCommitCascadeTelemetryForTests()
  resetReactCommitCascadeObserverForTests()
  // Why the delete: install wraps whatever is there, so a hook left over from
  // the previous test would stack a second counter onto the same callback.
  delete (globalThis as { __REACT_DEVTOOLS_GLOBAL_HOOK__?: unknown }).__REACT_DEVTOOLS_GLOBAL_HOOK__
  installReactCommitCascadeObserver()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('react devtools commit hook shim', () => {
  // Why asserted: without a pre-existing hook react-dom injects nothing, so a
  // packaged build only gets commit callbacks if the shim installs its own.
  it('exposes what react-dom requires to inject', () => {
    const hook = readHook()

    expect(hook.supportsFiber).toBe(true)
    expect(hook.isDisabled).toBe(false)
    expect(hook.inject?.({})).toBeGreaterThan(0)
    expect(typeof hook.onCommitFiberRoot).toBe('function')
  })

  // Why asserted: react-dom calls this once per DELETED FIBER, guarded only by
  // a typeof check. Defining it would put our shim on every unmount path.
  it('leaves the per-deleted-fiber callbacks undefined', () => {
    const hook = readHook() as Record<string, unknown>

    expect(hook.onCommitFiberUnmount).toBeUndefined()
    expect(hook.onPostCommitFiberRoot).toBeUndefined()
    expect(hook.setStrictMode).toBeUndefined()
  })
})

describe('installReactCommitCascadeObserver', () => {
  it('breadcrumbs once the commit callback reaches the notice limit', () => {
    const hook = readHook()
    for (let commit = 0; commit < REACT_COMMIT_CASCADE_NOTICE_LIMIT; commit += 1) {
      hook.onCommitFiberRoot?.(1, CASCADING_ROOT, undefined, false)
    }

    expect(recordBreadcrumb).toHaveBeenCalledTimes(1)
    expect(recordBreadcrumb.mock.calls[0]?.[0]).toBe(REACT_COMMIT_CASCADE_BREADCRUMB)
  })

  it('ignores a commit whose root reports no cascading lanes', () => {
    const hook = readHook()
    for (let commit = 0; commit < REACT_COMMIT_CASCADE_NOTICE_LIMIT * 2; commit += 1) {
      hook.onCommitFiberRoot?.(1, { pendingLanes: 0 }, undefined, false)
    }

    expect(recordBreadcrumb).not.toHaveBeenCalled()
  })

  // Why asserted: a future React that stops exposing pendingLanes must make the
  // diagnostic go quiet, not fire on a depth it can no longer evaluate.
  it('ends the cascade when pendingLanes is not readable', () => {
    const hook = readHook()
    for (let commit = 0; commit < REACT_COMMIT_CASCADE_NOTICE_LIMIT - 1; commit += 1) {
      hook.onCommitFiberRoot?.(1, CASCADING_ROOT, undefined, false)
    }

    hook.onCommitFiberRoot?.(1, { renamedLanes: 2 }, undefined, false)
    for (let commit = 0; commit < REACT_COMMIT_CASCADE_NOTICE_LIMIT - 1; commit += 1) {
      hook.onCommitFiberRoot?.(1, CASCADING_ROOT, undefined, false)
    }

    expect(recordBreadcrumb).not.toHaveBeenCalled()
  })

  it('chains onto an existing callback instead of replacing it', () => {
    const previous = vi.fn()
    const hook = readHook()
    hook.onCommitFiberRoot = previous
    resetReactCommitCascadeObserverForTests()
    installReactCommitCascadeObserver()

    hook.onCommitFiberRoot?.(7, CASCADING_ROOT, undefined, true)

    expect(previous).toHaveBeenCalledWith(7, CASCADING_ROOT, undefined, true)
  })

  // Why asserted: our throw would otherwise land in react-dom's own catch and
  // silently unhook DevTools and Fast Refresh from the rest of the chain.
  it('still calls the chained hook when our own work throws', () => {
    const previous = vi.fn()
    const hook = readHook()
    hook.onCommitFiberRoot = previous
    resetReactCommitCascadeObserverForTests()
    installReactCommitCascadeObserver()

    const hostile = {
      get pendingLanes(): number {
        throw new Error('hostile root')
      }
    }
    expect(() => hook.onCommitFiberRoot?.(1, hostile, undefined, false)).not.toThrow()
    expect(previous).toHaveBeenCalledTimes(1)
  })

  it('is idempotent, so a second install cannot double-count commits', () => {
    installReactCommitCascadeObserver()
    const hook = readHook()
    for (let commit = 0; commit < REACT_COMMIT_CASCADE_NOTICE_LIMIT - 1; commit += 1) {
      hook.onCommitFiberRoot?.(1, CASCADING_ROOT, undefined, false)
    }

    expect(recordBreadcrumb).not.toHaveBeenCalled()
  })
})

// Why: a reshuffled import or a bundler hoist disables the diagnostic with no
// test failure. This is what makes that visible in the field instead.
describe('install self-check', () => {
  it('breadcrumbs when no commit ever reached the hook', () => {
    vi.useFakeTimers()
    resetReactCommitCascadeObserverForTests()
    installReactCommitCascadeObserver()

    vi.advanceTimersByTime(REACT_COMMIT_CASCADE_INSTALL_CHECK_MS)

    expect(recordBreadcrumb).toHaveBeenCalledWith(
      REACT_COMMIT_CASCADE_UNINSTALLED_BREADCRUMB,
      undefined
    )
  })

  it('stays silent once any commit has been seen', () => {
    vi.useFakeTimers()
    resetReactCommitCascadeObserverForTests()
    installReactCommitCascadeObserver()
    readHook().onCommitFiberRoot?.(1, { pendingLanes: 0 }, undefined, false)

    vi.advanceTimersByTime(REACT_COMMIT_CASCADE_INSTALL_CHECK_MS)

    expect(recordBreadcrumb).not.toHaveBeenCalled()
  })
})
