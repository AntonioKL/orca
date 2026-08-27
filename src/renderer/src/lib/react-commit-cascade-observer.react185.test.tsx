/** @vitest-environment happy-dom */
import { act, useLayoutEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { create } from 'zustand'
import { withReactCommitCascadeWriteProbe } from '../store/react-commit-cascade-write-probe'
import {
  REACT_COMMIT_CASCADE_BREADCRUMB,
  REACT_COMMIT_CASCADE_NOTICE_LIMIT,
  resetReactCommitCascadeTelemetryForTests
} from './react-commit-cascade-telemetry'
import {
  installReactCommitCascadeObserver,
  resetReactCommitCascadeObserverForTests
} from './react-commit-cascade-observer'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const recordBreadcrumb = vi.fn()
vi.mock('@/lib/crash-breadcrumb-recorder', () => ({
  recordRendererCrashBreadcrumb: (name: string, data?: unknown) => recordBreadcrumb(name, data)
}))

/**
 * The devtools hook itself is installed by config/scripts/react-commit-cascade-observer-setup.ts,
 * which vitest evaluates before react-dom is imported above. Only the wrapping
 * happens here, which react-dom re-reads per commit.
 */

/** Enough to pass the notice limit while staying under React's own 50-commit bail. */
const CASCADE_TICKS = REACT_COMMIT_CASCADE_NOTICE_LIMIT + 5

type CascadeState = { ticks: number; bump: () => void }

const useCascadeStore = create<CascadeState>()(
  withReactCommitCascadeWriteProbe((set) => ({
    ticks: 0,
    bump: () => {
      set({ ticks: useCascadeStore.getState().ticks + 1 })
    }
  }))
)

/**
 * Layout effect, not passive: only the synchronous counter throws #185. A
 * useEffect loop leaves `pendingLanes: 0` at commit time (measured) because
 * passive effects flush after the callback, and React only console.errors it.
 */
function RunawayLayoutEffectPane(): React.JSX.Element {
  const ticks = useCascadeStore((state) => state.ticks)
  useLayoutEffect(() => {
    if (ticks < CASCADE_TICKS) {
      useCascadeStore.getState().bump()
    }
  })
  return <div>{ticks}</div>
}

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  recordBreadcrumb.mockClear()
  resetReactCommitCascadeTelemetryForTests()
  resetReactCommitCascadeObserverForTests()
  useCascadeStore.setState({ ticks: 0 })
  installReactCommitCascadeObserver()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  host.remove()
})

describe('react commit cascade observer', () => {
  it('counts a genuine synchronous cascade and names the store write driving it', () => {
    act(() => {
      root.render(<RunawayLayoutEffectPane />)
    })

    const cascadeCalls = recordBreadcrumb.mock.calls.filter(
      ([name]) => name === REACT_COMMIT_CASCADE_BREADCRUMB
    )
    expect(cascadeCalls).toHaveLength(1)

    const payload = (cascadeCalls[0]?.[1] ?? {}) as Record<string, unknown>
    expect(payload.commits).toBe(REACT_COMMIT_CASCADE_NOTICE_LIMIT)
    expect(payload.pendingLanes).toBeGreaterThan(0)
    expect(payload.storeWrites).toBeGreaterThan(0)
    // The middleware boundary is elided, so this is the code that called `set`.
    expect(String(payload.driverFrame)).toContain('bump')
    expect(payload.changedKeys).toBe('ticks')
    expect(payload.rendererSurface).toBe('main')
  })

  it('stays silent for a render that settles well below the notice limit', () => {
    useCascadeStore.setState({ ticks: CASCADE_TICKS })

    act(() => {
      root.render(<RunawayLayoutEffectPane />)
    })

    expect(recordBreadcrumb).not.toHaveBeenCalled()
  })
})
