// A pane still mid-turn when Orca quit hydrates as `restoredUnconfirmed`, which every status
// surface renders as "not running" until the agent's next hook event — the whole of whatever
// tool call is in flight. The agent's own transcript already answers this: Chat settles its
// spinner from provider-authored lifecycle records, so read those rather than invent a second
// opinion about what a Claude transcript means.
import { recognizeAgentProcess } from '../../shared/agent-process-recognition'
import { isWslHookRelayConnectionId } from '../../shared/wsl-hook-relay-contract'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-types'
import type { NativeChatTurnLifecycle } from '../../shared/native-chat-types'
import {
  nativeChatLineDecoderForAgent,
  readNativeChatTranscriptTailFile
} from '../native-chat/transcript-tail-reader'
import { nativeChatTurnLifecycleDecoderForAgent } from '../native-chat/transcript-turn-lifecycle'

/** How far back to look for the newest turn boundary. Confirmation needs to *find* the record
 *  that opened the turn, so a turn with more tool calls than this keeps today's behaviour and
 *  waits for a hook — the safe direction, since the alternative (reading absence as evidence)
 *  would confirm idle panes and hold a wake lock over them. */
const LIFECYCLE_SCAN_LIMIT = 150

/** Ceiling for the whole pass, honoured by both steps that touch the filesystem: translating a
 *  guest path probes a distro's 9P mount, and the tail read goes through the same two-slot gate.
 *  Without it a wedged mount would hold slots Chat needs and never let this pass settle. Expiry
 *  reads as no evidence, the same answer as an unreadable transcript. */
const PASS_DEADLINE_MS = 30_000

/** Oldest an open boundary may be and still read as a running turn. Measured over 414 real
 *  transcripts: of 26 that end on an open boundary, the live ones are under an hour old and the
 *  other 23 are 25h to 733h — sessions abandoned mid-turn that never wrote a terminal record.
 *  Twelve hours clears any plausible tool call while refusing those. Deliberately not the 30min
 *  status-staleness window: this timestamp is when the turn *opened*, so that bound would refuse
 *  most genuinely long turns, which are the ones this feature exists for. */
const OPEN_BOUNDARY_MAX_AGE_MS = 12 * 60 * 60 * 1000

export type RestoredClaudeTurnConfirmationDeps = {
  getStatusSnapshot: () => readonly AgentStatusIpcPayload[]
  isLocalExecutionHost: (worktreeId: string | undefined) => boolean
  /** PTY bound to this pane now, else the one it was bound to when last persisted — a pane
   *  whose surviving daemon session has not been reattached yet still has the latter. */
  getBoundPtyIdForPaneKey: (paneKey: string) => string | undefined
  getPersistedPtyIdForPaneKey: (paneKey: string) => string | undefined
  /** The pane's foreground process name, resolved through wrappers, or null when unreadable.
   *  Must be the confirming read: the cheap one reports Claude's wrapper, named after its
   *  version, which no agent recognizer can match. */
  readForegroundProcess: (ptyId: string) => Promise<string | null>
  /** Rewrites a guest-side path (WSL) into one this host can open; null when unreadable. This
   *  is the step that probes a distro's 9P mount, so it must honour the pass signal. */
  toReadableTranscriptPath: (path: string, signal?: AbortSignal) => Promise<string | null>
  confirm: (paneKey: string) => boolean
  /** Cancels in-flight transcript reads; defaults to this pass's own deadline. */
  signal?: AbortSignal
  now?: () => number
  /** Newest turn boundary in a transcript's tail; defaults to the shared gated reader. */
  readTurnLifecycle?: (
    path: string,
    signal?: AbortSignal
  ) => Promise<NativeChatTurnLifecycle | undefined>
}

/** The one rule for "outside evidence may confirm this row", shared by the caller below and the
 *  fence in `server.ts` so the two can never drift.
 *
 *  Working Claude only: a transcript proves a turn is open, not which side of a permission
 *  prompt it sits on, so a `waiting` row answered while Orca was down would come back amber.
 *  This half of local ownership — no *remote* relay binding — travels with the row: a row whose
 *  hooks arrived over an SSH relay is a remote pane's verdict, and local process tables and
 *  transcripts may not decide it (ssh-execution-boundary.md). A WSL relay id is not that; the
 *  pane is local on a local repo and the contract requires treating it as such
 *  (wsl-hook-relay-contract.ts), which is also what the renderer's applicator does. The other
 *  half, a local execution host, needs the workspace store and so is enforced by callers; both
 *  this module's pass and any future caller of `confirmRestoredWorkingTurn` must apply it. */
export function isRestoredWorkingClaudeTurn(row: {
  restoredUnconfirmed?: boolean
  providerSessionOnly?: boolean
  connectionId?: string | null
  state?: string
  agentType?: string | null
}): boolean {
  return (
    row.restoredUnconfirmed === true &&
    row.providerSessionOnly !== true &&
    (row.connectionId === null || isWslHookRelayConnectionId(row.connectionId)) &&
    row.state === 'working' &&
    row.agentType === 'claude'
  )
}

/** Newest provider-authored turn boundary in a Claude transcript, read through the same gated,
 *  short-read-safe tail reader Chat uses. */
export async function readClaudeTurnLifecycle(
  filePath: string,
  signal?: AbortSignal
): Promise<NativeChatTurnLifecycle | undefined> {
  const decode = nativeChatLineDecoderForAgent('claude')
  const decodeLifecycle = nativeChatTurnLifecycleDecoderForAgent('claude')
  if (!decode || !decodeLifecycle) {
    return undefined
  }
  const { lifecycle } = await readNativeChatTranscriptTailFile(
    filePath,
    LIFECYCLE_SCAN_LIMIT,
    decode,
    true,
    undefined,
    decodeLifecycle,
    signal
  )
  return lifecycle
}

/** A pane whose evidence held, with the PTY that evidence describes. */
type ConfirmableTurn = { paneKey: string; ptyId: string }

/** The pane moved to a different PTY, so evidence gathered from `inspected` is void. An unbound
 *  pane is not a move: reattach may still land on the same id, and a PTY that actually exited
 *  clears the row outright, which the confirm path then declines. */
function isReboundAway(current: string | undefined, inspected: string): boolean {
  return current !== undefined && current !== inspected
}

/** Confirm restored `working` Claude rows whose agent is provably still mid-turn: Claude is the
 *  pane's foreground process on this machine AND its transcript's newest boundary opened a
 *  generation that never ended. An agent killed mid-tool leaves the same open-looking transcript
 *  behind while its shell keeps the PTY alive, so neither proof counts alone.
 *
 *  Two residuals, each correcting when the agent next reports. The foreground proves *a* Claude
 *  runs in the pane, not that it is this row's session, so a session killed mid-tool and replaced
 *  before startup can be confirmed; no cheaper signal separates "tool running 45 minutes" from
 *  "killed 45 minutes ago", since neither appends to the transcript while a tool runs. And a turn
 *  parked on a permission prompt whose request fired while Orca was down reads identically to one
 *  mid-tool — Claude writes the `tool_use` record either way — so it comes back spinning rather
 *  than idle; `hasChildProcesses` cannot separate them because older daemons derive it from the
 *  foreground name. Both leave an open turn behind, so the agent does still have a report to
 *  make; a pane merely sitting idle is never confirmed, which is why absence of a boundary is
 *  not treated as evidence. */
export async function confirmRestoredWorkingClaudeTurns(
  deps: RestoredClaudeTurnConfirmationDeps
): Promise<number> {
  const readTurnLifecycle = deps.readTurnLifecycle ?? readClaudeTurnLifecycle
  const signal = deps.signal ?? AbortSignal.timeout(PASS_DEADLINE_MS)
  const now = deps.now ?? Date.now
  // Why memoized and concurrent, like the sibling sweep: the confirming foreground read is a
  // process-table scan, and startup must not serialize one per restored pane.
  const foregroundByPtyId = new Map<string, Promise<string | null>>()
  const readForeground = (ptyId: string): Promise<string | null> => {
    let pending = foregroundByPtyId.get(ptyId)
    if (!pending) {
      pending = deps.readForegroundProcess(ptyId)
      foregroundByPtyId.set(ptyId, pending)
    }
    return pending
  }

  const verdicts = await Promise.all(
    deps.getStatusSnapshot().map(async (row): Promise<ConfirmableTurn | null> => {
      // Why the whole body is guarded: `Promise.all` rejects on the first throw, so a single
      // pane with an unresolvable workspace record would strand every other pane's confirmation
      // for the rest of the session — the host and binding lookups below can throw too.
      try {
        const transcriptPath = row.providerSession?.transcriptPath
        if (!transcriptPath || !isRestoredWorkingClaudeTurn(row)) {
          return null
        }
        const { paneKey, worktreeId } = row
        // Why local only: a remote pane's agent and its transcript both live on the execution
        // host, where absence here is a failure to read, never a verdict (ssh-execution-boundary).
        if (!deps.isLocalExecutionHost(worktreeId)) {
          return null
        }
        const ptyId =
          deps.getBoundPtyIdForPaneKey(paneKey) ?? deps.getPersistedPtyIdForPaneKey(paneKey)
        if (!ptyId) {
          return null
        }
        const foreground = await readForeground(ptyId)
        // Why re-read the binding, and why against `ptyId` rather than what was bound at probe
        // time: reattach runs concurrently with this pass, so a pane that was unbound when it was
        // inspected normally binds to the very id inspected — that is the case this exists for,
        // not a rebind. Only a bind to a *different* PTY voids the evidence.
        if (
          isReboundAway(deps.getBoundPtyIdForPaneKey(paneKey), ptyId) ||
          recognizeAgentProcess(foreground)?.agent !== row.agentType
        ) {
          return null
        }
        const readablePath = await deps.toReadableTranscriptPath(transcriptPath, signal)
        if (readablePath === null) {
          return null
        }
        // Why an explicit open boundary, rather than reading absence as evidence: a pane that is
        // merely quiet emits no hook to correct a wrong guess, so a spinner invented here would
        // sit there until the row goes stale. A turn busier than the scan window therefore keeps
        // today's behaviour and waits.
        const lifecycle = await readTurnLifecycle(readablePath, signal)
        // Why the age bound: the foreground proves *a* Claude, not this row's session, so a pane
        // whose old session died and was replaced would otherwise confirm off the dead session's
        // transcript. An abandoned mid-turn transcript stays open forever; a real one is minutes
        // to hours old.
        const openedAt = lifecycle?.state === 'working' ? lifecycle.timestamp : null
        const open = openedAt !== null && now() - openedAt <= OPEN_BOUNDARY_MAX_AGE_MS
        return open ? { paneKey, ptyId } : null
      } catch {
        // Why per pane: one failed inspection or unreadable transcript must not strand the rest.
        return null
      }
    })
  )

  let confirmed = 0
  for (const verdict of verdicts) {
    if (verdict === null) {
      continue
    }
    // Why re-checked here and not only at probe time: the transcript read can take seconds, and
    // every other pane's inspection runs before this loop. A pane moved to a different PTY in
    // that window is a different session, so its evidence is void.
    if (isReboundAway(deps.getBoundPtyIdForPaneKey(verdict.paneKey), verdict.ptyId)) {
      continue
    }
    // Why serialized: `confirm` re-reads and rewrites server state.
    if (deps.confirm(verdict.paneKey)) {
      confirmed += 1
    }
  }
  return confirmed
}
