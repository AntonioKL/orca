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

/**
 * The window-close guard is the one consumer of this evidence that acts FOR the
 * user: a degraded probe read as "nothing is running" skips the prompt entirely
 * and the window closes on live work. So every case is asserted on the dialog
 * text rendered into a real DOM and on whether confirmWindowClose() fired —
 * never on an intermediate boolean.
 */

const { getStateMock } = vi.hoisted(() => ({ getStateMock: vi.fn() }))

vi.mock('@/store', () => ({ useAppStore: { getState: getStateMock } }))
vi.mock('@/lib/connection-context', () => ({ getConnectionId: () => null }))
vi.mock('@/lib/shutdown-checkpoint-failure-toast', () => ({
  showShutdownCheckpointFailureToast: vi.fn()
}))

import { useWindowCloseRunningProcessPrompt } from './window-close-running-process-prompt'

const PTY_ID = 'pty-local-1'
const SHELL = 'zsh'
const WARNING = 'There are local terminals with running processes.'

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
let proceed: ((isQuitting: boolean) => void) | null = null

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
function installInspectProcess(inspectProcess: () => Promise<InspectionShape>): void {
  ;(window as unknown as { api: unknown }).api = {
    pty: {
      inspectProcess: vi.fn(inspectProcess),
      // Why the double publishes both: `pty:hasChildProcesses` is the legacy
      // boolean route this guard used to take, and it is derived from the SAME
      // host answer. A double that omitted it would let the pre-fix predicate
      // look untestable instead of wrong.
      hasChildProcesses: vi.fn(async () => (await inspectProcess()).hasChildProcesses === true)
    },
    ui: { confirmWindowClose }
  }
}

async function runWindowClose(): Promise<void> {
  await act(async () => {
    proceed!(false)
    await Promise.resolve()
    await Promise.resolve()
  })
}

function warningIsVisible(): boolean {
  return document.body.textContent?.includes(WARNING) === true
}

beforeEach(() => {
  confirmWindowClose = vi.fn()
  getStateMock.mockReturnValue({
    settings: { activeRuntimeEnvironmentId: null },
    tabsByWorktree: { 'wt-1': [{ id: 'tab-1' }] },
    ptyIdsByTabId: { 'tab-1': [PTY_ID] }
  })
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
    const start = source.indexOf('    setWindowCloseRequestHandler(({ isQuitting }) => {')
    const end = source.indexOf('    return () => setWindowCloseRequestHandler(null)', start)
    expect(start).toBeGreaterThanOrEqual(0)
    expect(end).toBeGreaterThan(start)
    expect(source.slice(start, end)).toContain('proceedToNativeWindowClose(isQuitting)')
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
})
