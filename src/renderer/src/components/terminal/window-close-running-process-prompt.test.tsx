// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildPtyProcessInspectionWireResult,
  type PtyProcessInspectionEvidence
} from '../../../../shared/pty-process-inspection-evidence'
import type { AppState } from '@/store/types'

/**
 * The window-close guard is the one consumer of this evidence that acts FOR the
 * user: a degraded probe read as "nothing is running" skips the prompt entirely
 * and the window closes on live work. So every case is asserted on the dialog
 * text rendered into a real DOM and on whether confirmWindowClose() fired —
 * never on an intermediate boolean.
 */

const { getStateMock } = vi.hoisted(() => ({ getStateMock: vi.fn() }))

vi.mock('@/store', () => ({ useAppStore: { getState: getStateMock } }))
vi.mock('@/lib/shutdown-checkpoint-failure-toast', () => ({
  showShutdownCheckpointFailureToast: vi.fn()
}))

import { showShutdownCheckpointFailureToast } from '@/lib/shutdown-checkpoint-failure-toast'
import { readWindowCloseRequestPayload } from '../../../../shared/window-close-request'
import { useWindowCloseRunningProcessPrompt } from './window-close-running-process-prompt'
import { anyPtyBlocksWindowClose } from './window-close-running-process-evidence'
import { RUNNING_CLOSE_PROBE_TIMEOUT_MS } from './running-terminal-close-guard'

const PTY_ID = 'pty-local-1'
const SSH_PTY_ID = 'ssh:ssh-1@@pty-remote-1'
const LOCAL_WORKTREE_ID = 'repo-local::/home/dev/work'
const SSH_WORKTREE_ID = 'repo-ssh::/srv/work'
const SHELL = 'zsh'

/**
 * Owner resolution runs for real (`getConnectionIdFromState`: repo of the worktree,
 * then its `connectionId`). Stubbing `getConnectionId` would decide the very thing
 * the SSH cases are about, and would keep passing if the guard started asking the
 * store a different question.
 */
const REPOS = [
  { id: 'repo-local', connectionId: null },
  { id: 'repo-ssh', connectionId: 'ssh-1' }
] as unknown as AppState['repos']

function storeStateWithPtys(ptysByWorktreeId: Record<string, readonly string[]>): unknown {
  const tabsByWorktree: Record<string, { id: string }[]> = {}
  const ptyIdsByTabId: Record<string, readonly string[]> = {}
  for (const [worktreeId, ptyIds] of Object.entries(ptysByWorktreeId)) {
    const tabId = `tab-${worktreeId}`
    tabsByWorktree[worktreeId] = [{ id: tabId }]
    ptyIdsByTabId[tabId] = ptyIds
  }
  return {
    settings: { activeRuntimeEnvironmentId: null },
    tabsByWorktree,
    ptyIdsByTabId,
    repos: REPOS,
    worktreesByRepo: {},
    folderWorkspaces: [],
    projectGroups: []
  }
}
const WARNING = 'There are terminals with running processes.'

/**
 * What `LocalPtyProvider.inspectProcess` really publishes when the foreground
 * scan is degraded (`classifyLocalPtyChildProcesses`, "pty title matches the
 * shell while the foreground scan is degraded"): the legacy fields are the
 * stable-cache shell name and `hasChildProcesses: false`, byte-identical to a
 * genuinely idle shell. Composed through the real collapse builder so the
 * fixture cannot drift from the producer.
 */
type InspectionShape = {
  foregroundProcess: string | null
  hasChildProcesses: boolean
  unavailable?: true
  processEvidence?: PtyProcessInspectionEvidence
}

function degradedLocalInspection(): InspectionShape {
  return {
    ...buildPtyProcessInspectionWireResult(
      { verdict: 'unverifiable', reason: 'process table scan degraded' },
      {
        verdict: 'unverifiable',
        reason: 'pty title matches the shell while the foreground scan is degraded'
      }
    ),
    // The provider publishes its stable-cache legacy value, which for a pane
    // that never ran an agent is the shell name.
    foregroundProcess: SHELL
  }
}

function observedIdleInspection(): InspectionShape {
  return buildPtyProcessInspectionWireResult(
    { verdict: 'observed', processName: SHELL },
    { verdict: 'exited' }
  )
}

function observedLiveInspection(): InspectionShape {
  return buildPtyProcessInspectionWireResult(
    { verdict: 'observed', processName: 'codex' },
    { verdict: 'live' }
  )
}

let root: Root | null = null
let container: HTMLDivElement | null = null
let confirmWindowClose: ReturnType<typeof vi.fn>
let proceed: ((isQuitting: boolean, localPtysSurviveQuit: boolean) => void) | null = null

function Harness(): React.ReactNode {
  const prompt = useWindowCloseRunningProcessPrompt()
  proceed = prompt.proceedToNativeWindowClose
  return prompt.windowCloseDialog
}

/**
 * Installs a PTY inspection that RESOLVES with a degraded answer — the shape the
 * bug actually has. A throwing controller would be a different boundary; the
 * local host answers, its probes just could not see.
 */
function installInspectProcess(
  inspectProcess: (ptyId: string) => Promise<InspectionShape>
): ReturnType<typeof vi.fn> {
  const inspectProcessMock = vi.fn(inspectProcess)
  ;(window as unknown as { api: unknown }).api = {
    pty: {
      inspectProcess: inspectProcessMock,
      // Why the double publishes both: `pty:hasChildProcesses` is the legacy
      // boolean route this guard used to take, and it is derived from the SAME
      // host answer. A double that omitted it would let the pre-fix predicate
      // look untestable instead of wrong.
      hasChildProcesses: vi.fn(
        async (ptyId: string) => (await inspectProcess(ptyId)).hasChildProcesses === true
      )
    },
    ui: { confirmWindowClose }
  }
  return inspectProcessMock
}

async function runWindowClose(): Promise<void> {
  await act(async () => {
    proceed!(false, false)
    await Promise.resolve()
    await Promise.resolve()
  })
}

/** Drives the quit branch through the same reader the preload uses, so the survival
 *  fact reaching the prompt is the one main's payload actually produces. */
async function runQuit(payload: {
  isQuitting: boolean
  localPtysSurviveQuit?: unknown
}): Promise<void> {
  const { isQuitting, localPtysSurviveQuit } = readWindowCloseRequestPayload(payload)
  await act(async () => {
    proceed!(isQuitting, localPtysSurviveQuit)
    await Promise.resolve()
    await Promise.resolve()
  })
}

function warningIsVisible(): boolean {
  return document.body.textContent?.includes(WARNING) === true
}

beforeEach(() => {
  vi.mocked(showShutdownCheckpointFailureToast).mockClear()
  confirmWindowClose = vi.fn()
  getStateMock.mockReturnValue(storeStateWithPtys({ [LOCAL_WORKTREE_ID]: [PTY_ID] }))
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root!.render(<Harness />)
  })
})

afterEach(() => {
  act(() => {
    root?.unmount()
  })
  container?.remove()
  root = null
  container = null
  proceed = null
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

describe('window close with a degraded local process read', () => {
  it('shows the running-processes warning instead of closing the window', async () => {
    installInspectProcess(async () => degradedLocalInspection())

    await runWindowClose()

    expect(warningIsVisible()).toBe(true)
    expect(confirmWindowClose).not.toHaveBeenCalled()
  })

  it('still closes silently when the probe positively observed an idle shell', async () => {
    installInspectProcess(async () => observedIdleInspection())

    await runWindowClose()

    expect(warningIsVisible()).toBe(false)
    expect(confirmWindowClose).toHaveBeenCalledTimes(1)
  })

  it('shows the warning for an observed live process', async () => {
    installInspectProcess(async () => observedLiveInspection())

    await runWindowClose()

    expect(warningIsVisible()).toBe(true)
    expect(confirmWindowClose).not.toHaveBeenCalled()
  })

  it('asks when the host could not route the pane at all', async () => {
    // `pty:inspectProcess` answers exactly this for an id it cannot route, and
    // `inspectPtyProviderProcessForRenderer` answers it on terminal_gone. The
    // legacy fields it carries are the idle collapse, so without an `unavailable`
    // fence the evidence read fabricates `exited` from nothing anyone observed.
    installInspectProcess(async () => ({
      foregroundProcess: null,
      hasChildProcesses: false,
      unavailable: true as const
    }))

    await runWindowClose()

    expect(warningIsVisible()).toBe(true)
    expect(confirmWindowClose).not.toHaveBeenCalled()
  })

  it('asks when the inspection raises instead of leaving the window stuck', async () => {
    installInspectProcess(async () => {
      throw new Error('inspect failed')
    })

    await runWindowClose()

    expect(warningIsVisible()).toBe(true)
    expect(confirmWindowClose).not.toHaveBeenCalled()
  })

  /** Two overlapping close attempts: main re-sends `window:close-requested` on every one
   *  (main-window-close-lifecycle.ts), the coordinator's `closeInFlight` is released before
   *  the handler runs, and Terminal's re-entrancy ref only trips on dirty editors — so both
   *  probes are live at once and the older one must not get to decide. */
  function installDeferredInspections(): ((value: InspectionShape) => void)[] {
    const settle: ((value: InspectionShape) => void)[] = []
    installInspectProcess(() => new Promise<InspectionShape>((resolve) => settle.push(resolve)))
    return settle
  }

  function clickCancel(): void {
    const cancel = [...document.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === 'Cancel'
    )
    expect(cancel).toBeDefined()
    act(() => {
      cancel!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
  }

  it('does not close the window on a stale probe after the user cancelled a newer one', async () => {
    const settle = installDeferredInspections()

    act(() => proceed!(false, false))
    act(() => proceed!(false, false))
    await act(async () => {
      await Promise.resolve()
    })
    expect(settle).toHaveLength(2)

    // The newer attempt answers first and finds live work, so the warning goes up.
    await act(async () => {
      settle[1]!(observedLiveInspection())
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(warningIsVisible()).toBe(true)

    // The user chooses to keep the window.
    clickCancel()
    expect(warningIsVisible()).toBe(false)

    // The older probe finally settles, reporting a table it read before the dialog existed.
    await act(async () => {
      settle[0]!(observedIdleInspection())
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(confirmWindowClose).not.toHaveBeenCalled()
    expect(warningIsVisible()).toBe(false)
  })

  it('does not reopen a dismissed warning when a stale probe reports live work', async () => {
    const settle = installDeferredInspections()

    act(() => proceed!(false, false))
    act(() => proceed!(false, false))
    await act(async () => {
      await Promise.resolve()
    })

    await act(async () => {
      settle[1]!(observedLiveInspection())
      await Promise.resolve()
      await Promise.resolve()
    })
    clickCancel()
    expect(warningIsVisible()).toBe(false)

    await act(async () => {
      settle[0]!(observedLiveInspection())
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(warningIsVisible()).toBe(false)
    expect(confirmWindowClose).not.toHaveBeenCalled()
  })

  /** The newest attempt is not automatically the user's newest intent. Cancel is,
   *  and a probe that was already outstanding when they pressed it still belongs to
   *  a close they have since called off. */
  it('does not close the window on a probe the user cancelled out from under', async () => {
    const settle = installDeferredInspections()

    act(() => proceed!(false, false))
    await act(async () => {
      await Promise.resolve()
    })
    await act(async () => {
      settle[0]!(observedLiveInspection())
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(warningIsVisible()).toBe(true)

    // A second attempt lands while the warning is still asking — the traffic
    // lights stay clickable under it — so its probe is the newest one.
    act(() => proceed!(false, false))
    await act(async () => {
      await Promise.resolve()
    })

    clickCancel()
    expect(warningIsVisible()).toBe(false)

    await act(async () => {
      settle[1]!(observedIdleInspection())
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(confirmWindowClose).not.toHaveBeenCalled()
  })

  /** Keeps the newest-attempt fence pinned on its own. Both cancel cases above are
   *  also satisfied by the dismissal fence, so without a case that never cancels,
   *  deleting the per-attempt bump leaves every test green. */
  it('does not let an older idle probe close the window while the newer one is still asking', async () => {
    const settle = installDeferredInspections()

    act(() => proceed!(false, false))
    act(() => proceed!(false, false))
    await act(async () => {
      await Promise.resolve()
    })

    await act(async () => {
      settle[1]!(observedLiveInspection())
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(warningIsVisible()).toBe(true)

    await act(async () => {
      settle[0]!(observedIdleInspection())
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(confirmWindowClose).not.toHaveBeenCalled()
    expect(warningIsVisible(), 'the warning must stay up until the user answers it').toBe(true)
  })

  /** The close paths that never probe end an attempt just as surely as the ones that do.
   *  A quit whose local shells main reports will survive arrives on the same re-sent
   *  `window:close-requested` and skips the probe entirely, and its shutdown checkpoint
   *  can veto it — which leaves the window open with the earlier attempt's probe still
   *  outstanding. `vetoNextCloses` is the real producer: `confirmNativeWindowClose`
   *  reads `window.dispatchEvent`'s own return. */
  function vetoNextCloses(): () => void {
    const veto = (event: Event): void => event.preventDefault()
    window.addEventListener('beforeunload', veto)
    return () => window.removeEventListener('beforeunload', veto)
  }

  it('does not reopen the warning on a probe left over from before a vetoed direct close', async () => {
    const settle = installDeferredInspections()

    act(() => proceed!(false, false))
    await act(async () => {
      await Promise.resolve()
    })
    expect(settle).toHaveLength(1)

    // The user hits Cmd+Q while the first probe is still out. A quit main vouches
    // for never probes, and the dirty-file checkpoint vetoes it, so the window stays open.
    const stopVetoing = vetoNextCloses()
    try {
      act(() => proceed!(true, true))
      expect(confirmWindowClose).not.toHaveBeenCalled()
      expect(vi.mocked(showShutdownCheckpointFailureToast)).toHaveBeenCalledTimes(1)

      // The abandoned probe answers, for a close request that has already returned.
      await act(async () => {
        settle[0]!(observedLiveInspection())
        await Promise.resolve()
        await Promise.resolve()
      })
    } finally {
      stopVetoing()
    }

    expect(warningIsVisible(), 'a settled close attempt must not raise a dialog').toBe(false)
  })

  it('does not re-run a vetoed direct close from a probe that answers idle behind it', async () => {
    const settle = installDeferredInspections()

    act(() => proceed!(false, false))
    await act(async () => {
      await Promise.resolve()
    })

    const stopVetoing = vetoNextCloses()
    try {
      act(() => proceed!(true, true))
      expect(vi.mocked(showShutdownCheckpointFailureToast)).toHaveBeenCalledTimes(1)

      // Why the toast count and not `confirmWindowClose`: the veto is a standing
      // dirty-file guard, so a re-run is refused too and the close call alone cannot
      // tell a fenced probe from a re-vetoed one. The duplicate failure toast is the
      // observable — a second shutdown report for a close the user never asked for.
      await act(async () => {
        settle[0]!(observedIdleInspection())
        await Promise.resolve()
        await Promise.resolve()
      })
    } finally {
      stopVetoing()
    }

    expect(
      vi.mocked(showShutdownCheckpointFailureToast),
      'the stale probe must not drive the close sequence a second time'
    ).toHaveBeenCalledTimes(1)
    expect(confirmWindowClose).not.toHaveBeenCalled()
  })

  it('still closes the window directly on a quit that no checkpoint vetoes', async () => {
    installInspectProcess(async () => observedLiveInspection())

    act(() => proceed!(true, true))

    expect(confirmWindowClose).toHaveBeenCalledTimes(1)
    expect(vi.mocked(showShutdownCheckpointFailureToast)).not.toHaveBeenCalled()
  })

  it('reads a malformed foreign evidence payload as unverifiable, not as idle', async () => {
    installInspectProcess(async () => ({
      foregroundProcess: SHELL,
      hasChildProcesses: false,
      processEvidence: {
        foreground: { verdict: 'bogus' },
        children: { verdict: 'bogus' }
      } as unknown as PtyProcessInspectionEvidence
    }))

    await runWindowClose()

    expect(warningIsVisible()).toBe(true)
    expect(confirmWindowClose).not.toHaveBeenCalled()
  })
})

/**
 * Terminal.tsx is the only caller, and the guard is bypassable there with every
 * suite, `tsc` and oxlint still green. Mounting a 2800-line component to prove
 * the wiring costs far more than it returns, so pin it as source text the same
 * way initial-terminal-wiring.test.ts does.
 */
describe('Terminal.tsx routes the native window-close request through the guard', () => {
  const source = readFileSync(
    join(process.cwd(), 'src/renderer/src/components/Terminal.tsx'),
    'utf8'
  )

  it('registers a handler that probes before closing', () => {
    // Anchored on the effect's indent so a comment or a hoisted helper of the
    // same name cannot stand in for the registered handler.
    const start = source.indexOf(
      '    setWindowCloseRequestHandler(({ isQuitting, localPtysSurviveQuit }) => {'
    )
    const end = source.indexOf('    return () => setWindowCloseRequestHandler(null)', start)
    expect(start).toBeGreaterThanOrEqual(0)
    expect(end).toBeGreaterThan(start)
    // Both arguments, from the payload: dropping the survival fact here restores the
    // unconditional quit bypass with the whole probe still sitting behind it.
    expect(source.slice(start, end)).toContain(
      'proceedToNativeWindowClose(isQuitting, localPtysSurviveQuit)'
    )
  })

  it('keeps the intentional-restart bypass the only unprobed close', () => {
    // Why a count: swapping the handler's call for a direct confirmWindowClose()
    // restores the silent close this file exists to prevent, and nothing else in
    // the tree observes it.
    expect(
      source.split('window.api.ui.confirmWindowClose(').length - 1,
      'Terminal.tsx may only close the window unprobed for an intentional app restart'
    ).toBe(1)
  })

  /**
   * The dirty-editor branch defers the close instead of taking it, so the survival
   * fact has a second call site: it is stashed on the pending record and spent when
   * the save/discard flow finishes. Only the direct call above was pinned, which
   * left this one free to drop the fact and silently restore the unconditional quit
   * bypass for every window that happened to have unsaved work.
   */
  it('carries the survival fact through the deferred dirty-editor close as well', () => {
    const start = source.indexOf(
      '    setWindowCloseRequestHandler(({ isQuitting, localPtysSurviveQuit }) => {'
    )
    const end = source.indexOf('    return () => setWindowCloseRequestHandler(null)', start)
    expect(start).toBeGreaterThanOrEqual(0)
    // Stashed with the request. Anchored on the queue call itself, not the bare
    // object literal: the handler's own destructuring pattern is the same text, so
    // a looser match is satisfied by the signature and pins nothing.
    expect(source.slice(start, end)).toContain(
      'dirtyFiles.map((file) => file.id),\n          { isQuitting, localPtysSurviveQuit }'
    )
    // Spent on the replay: both fields off the pending record, not a re-derived default.
    expect(source).toContain('pendingWindowClose.isQuitting')
    expect(source).toContain('pendingWindowClose.localPtysSurviveQuit')
  })
})

/**
 * A local inspect is an IPC round trip into a process-table scan, and this path has
 * no backstop anywhere: main arms its renderer-ack timer only when `isQuitting`,
 * and that is precisely the branch that never probes. An unbounded wait therefore
 * leaves the window neither closed nor prompting — the same silent death the guard
 * exists to remove, arriving through a stall instead of a wrong verdict.
 */
describe('a probe that never answers cannot hang the window close', () => {
  it('blocks once the deadline passes instead of waiting forever', async () => {
    installInspectProcess(() => new Promise(() => {}))

    await expect(
      anyPtyBlocksWindowClose({ activeRuntimeEnvironmentId: null }, [PTY_ID], 20)
    ).resolves.toBe(true)
  })

  it('still returns the real answer when the probe beats the deadline', async () => {
    installInspectProcess(async () => observedIdleInspection())

    await expect(
      anyPtyBlocksWindowClose({ activeRuntimeEnvironmentId: null }, [PTY_ID], 20_000)
    ).resolves.toBe(false)
  })

  it('bounds the window-close probe with the same deadline as the tab and pane close paths', async () => {
    vi.useFakeTimers()
    try {
      installInspectProcess(() => new Promise(() => {}))
      await act(async () => {
        proceed!(false, false)
        await Promise.resolve()
      })
      // Why assert the not-yet state first: without it a bound of 0 would pass.
      expect(warningIsVisible()).toBe(false)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(RUNNING_CLOSE_PROBE_TIMEOUT_MS)
      })
      expect(warningIsVisible()).toBe(true)
      expect(confirmWindowClose).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})

/**
 * A direct-SSH pane's shell runs on the remote box but dies with the window, and
 * the guard used to select local worktrees before probing — so every SSH pane was
 * dropped unprobed and the window closed over live remote work with no warning.
 * `inspectProcess` dispatches on the PTY id, so the SSH provider answers these
 * (`pty.inspectProcess` over the mux); the verdict vocabulary is unchanged.
 */
describe('window close with a direct-SSH terminal', () => {
  beforeEach(() => {
    getStateMock.mockReturnValue(storeStateWithPtys({ [SSH_WORKTREE_ID]: [SSH_PTY_ID] }))
  })

  it('asks the execution host and shows the warning for live remote work', async () => {
    const inspectProcess = installInspectProcess(async () => observedLiveInspection())

    await runWindowClose()

    expect(inspectProcess).toHaveBeenCalledExactlyOnceWith(SSH_PTY_ID)
    expect(warningIsVisible()).toBe(true)
    expect(confirmWindowClose).not.toHaveBeenCalled()
  })

  it('closes only after the execution host positively observed the shell exited', async () => {
    const inspectProcess = installInspectProcess(async () => observedIdleInspection())

    await runWindowClose()

    expect(inspectProcess).toHaveBeenCalledExactlyOnceWith(SSH_PTY_ID)
    expect(warningIsVisible()).toBe(false)
    expect(confirmWindowClose).toHaveBeenCalledTimes(1)
  })

  it('asks when the owning host could not route the pane', async () => {
    installInspectProcess(async () => ({
      foregroundProcess: null,
      hasChildProcesses: false,
      unavailable: true as const
    }))

    await runWindowClose()

    expect(warningIsVisible()).toBe(true)
    expect(confirmWindowClose).not.toHaveBeenCalled()
  })

  /** The compatibility floor: this reuses the existing `pty.inspectProcess` request
   *  rather than adding a field or an opcode, so a relay that predates it answers
   *  method-not-found. That is `unverifiable`, never an observed absence. */
  it('asks when a relay too old to answer the request rejects it', async () => {
    installInspectProcess(async () => {
      throw new Error('Method not found: pty.inspectProcess')
    })

    await runWindowClose()

    expect(warningIsVisible()).toBe(true)
    expect(confirmWindowClose).not.toHaveBeenCalled()
  })

  it('asks after losing contact with the execution host', async () => {
    installInspectProcess(async () => {
      throw Object.assign(new Error('SSH connection lost, reconnecting...'), {
        code: 'CONNECTION_LOST'
      })
    })

    await runWindowClose()

    expect(warningIsVisible()).toBe(true)
    expect(confirmWindowClose).not.toHaveBeenCalled()
  })

  it('asks once the deadline passes when the execution host never answers', async () => {
    vi.useFakeTimers()
    try {
      installInspectProcess(() => new Promise<InspectionShape>(() => {}))
      await act(async () => {
        proceed!(false, false)
        await Promise.resolve()
      })
      // Why assert the not-yet state first: without it a bound of 0 would pass.
      expect(warningIsVisible()).toBe(false)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(RUNNING_CLOSE_PROBE_TIMEOUT_MS)
      })
      expect(warningIsVisible()).toBe(true)
      expect(confirmWindowClose).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  /** Both hosts in one window. Without this, a guard that swapped one owner filter
   *  for its complement — probing only SSH panes — passes every case above. */
  it('probes local and SSH panes alike and warns on whichever is busy', async () => {
    getStateMock.mockReturnValue(
      storeStateWithPtys({
        [LOCAL_WORKTREE_ID]: [PTY_ID],
        [SSH_WORKTREE_ID]: [SSH_PTY_ID]
      })
    )
    const inspectProcess = installInspectProcess(async (ptyId) =>
      ptyId === SSH_PTY_ID ? observedLiveInspection() : observedIdleInspection()
    )

    await runWindowClose()

    expect(inspectProcess.mock.calls.map(([ptyId]) => ptyId).sort()).toEqual(
      [PTY_ID, SSH_PTY_ID].sort()
    )
    expect(warningIsVisible()).toBe(true)
    expect(confirmWindowClose).not.toHaveBeenCalled()
  })

  /** The warning now speaks for remote panes too, so copy that still scoped itself
   *  to local terminals would be wrong about what it is protecting. */
  it('does not scope the warning to local terminals', async () => {
    installInspectProcess(async () => observedLiveInspection())

    await runWindowClose()

    const dialogText = document.body.textContent ?? ''
    expect(dialogText).toContain(WARNING)
    expect(dialogText).not.toContain('local terminal')
  })
})

/**
 * Quit used to skip the confirmation unconditionally. That is only safe while the
 * daemon owns the shells — quit calls `killAllPty()` (a no-op against the daemon
 * adapter) and `disconnectDaemon()`, so the daemon keeps its children. Without an
 * adapter the same children are this process's and die with it, measured in an
 * isolated node-pty probe: a foreground worker died on a bare parent exit while a
 * detached-fork control survived. So the bypass is now conditional on main saying
 * the work survives, and nothing else.
 */
describe('quit with local terminals', () => {
  const UNRESOLVED_WORKTREE_ID = 'repo-unhydrated::/home/dev/pending'

  it('warns about a live local process when the daemon does not own the PTYs', async () => {
    installInspectProcess(async () => observedLiveInspection())

    await runQuit({ isQuitting: true, localPtysSurviveQuit: false })

    expect(warningIsVisible()).toBe(true)
    expect(confirmWindowClose).not.toHaveBeenCalled()
  })

  it('closes silently while the daemon owns the PTYs, without probing at all', async () => {
    const inspectProcess = installInspectProcess(async () => observedLiveInspection())

    await runQuit({ isQuitting: true, localPtysSurviveQuit: true })

    expect(warningIsVisible()).toBe(false)
    expect(confirmWindowClose).toHaveBeenCalledTimes(1)
    // The quit must not get slower for work that is being handed over, not ended.
    expect(inspectProcess).not.toHaveBeenCalled()
  })

  it('still closes silently with no daemon when the local shell is observed idle', async () => {
    installInspectProcess(async () => observedIdleInspection())

    await runQuit({ isQuitting: true, localPtysSurviveQuit: false })

    expect(warningIsVisible()).toBe(false)
    expect(confirmWindowClose).toHaveBeenCalledTimes(1)
  })

  it('warns when the local read was degraded, because "could not tell" is not "idle"', async () => {
    installInspectProcess(async () => degradedLocalInspection())

    await runQuit({ isQuitting: true, localPtysSurviveQuit: false })

    expect(warningIsVisible()).toBe(true)
    expect(confirmWindowClose).not.toHaveBeenCalled()
  })

  /** A payload with no survival field at all — an older main, or a close request built
   *  before the daemon wiring existed. Read through the real preload reader, so the
   *  absence arrives exactly as it would on the wire. */
  it('warns when the payload never said whether the PTYs survive', async () => {
    installInspectProcess(async () => observedLiveInspection())

    await runQuit({ isQuitting: true })

    expect(warningIsVisible()).toBe(true)
    expect(confirmWindowClose).not.toHaveBeenCalled()
  })

  /** The daemon fact answers a quit and nothing else: an X-close ends the renderer
   *  either way, and the guard #17044/#17077 settled must keep running there. */
  it('still probes an ordinary window close even while the daemon owns the PTYs', async () => {
    const inspectProcess = installInspectProcess(async () => observedLiveInspection())

    await act(async () => {
      proceed!(false, true)
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(inspectProcess).toHaveBeenCalledWith(PTY_ID)
    expect(warningIsVisible()).toBe(true)
    expect(confirmWindowClose).not.toHaveBeenCalled()
  })

  /** SSH panes are the one thing a quit genuinely does not end: shutdown marks the
   *  lease `detached` rather than `terminated` and the remote shell is nohup-detached.
   *  Probing them would only make the quit slower over work that keeps running. */
  it('does not probe or warn about a direct-SSH pane on quit', async () => {
    getStateMock.mockReturnValue(storeStateWithPtys({ [SSH_WORKTREE_ID]: [SSH_PTY_ID] }))
    const inspectProcess = installInspectProcess(async () => observedLiveInspection())

    await runQuit({ isQuitting: true, localPtysSurviveQuit: false })

    expect(inspectProcess).not.toHaveBeenCalled()
    expect(warningIsVisible()).toBe(false)
    expect(confirmWindowClose).toHaveBeenCalledTimes(1)
  })

  it('warns about the local pane of a mixed window while leaving the SSH pane alone', async () => {
    getStateMock.mockReturnValue(
      storeStateWithPtys({
        [LOCAL_WORKTREE_ID]: [PTY_ID],
        [SSH_WORKTREE_ID]: [SSH_PTY_ID]
      })
    )
    const inspectProcess = installInspectProcess(async () => observedLiveInspection())

    await runQuit({ isQuitting: true, localPtysSurviveQuit: false })

    expect(inspectProcess.mock.calls.map(([ptyId]) => ptyId)).toEqual([PTY_ID])
    expect(warningIsVisible()).toBe(true)
  })

  /** The owner read answers `undefined` while the backing repo has not hydrated — the
   *  exact case the old `!== null` filter mistook for remote. An unresolved host is not
   *  evidence that the work survives, so the pane stays in the probe. */
  it('probes a pane whose owning host has not resolved yet rather than assuming it survives', async () => {
    getStateMock.mockReturnValue(storeStateWithPtys({ [UNRESOLVED_WORKTREE_ID]: [PTY_ID] }))
    const inspectProcess = installInspectProcess(async () => observedLiveInspection())

    await runQuit({ isQuitting: true, localPtysSurviveQuit: false })

    expect(inspectProcess).toHaveBeenCalledWith(PTY_ID)
    expect(warningIsVisible()).toBe(true)
    expect(confirmWindowClose).not.toHaveBeenCalled()
  })
})
