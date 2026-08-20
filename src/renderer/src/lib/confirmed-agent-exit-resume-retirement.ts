import { useAppStore } from '@/store'
import {
  agentProviderSessionsEqual,
  type SleepingAgentSessionRecord
} from '../../../shared/agent-session-resume'

type ResumeRetirementStore = {
  sleepingAgentSessionsByPaneKey?: Record<string, SleepingAgentSessionRecord>
  clearSleepingAgentSession?: (paneKey: string) => void
}

const paneKeyByPtyId = new Map<string, string>()
const unbindTimersByPtyId = new Map<string, ReturnType<typeof setTimeout>>()

/** Matches the side-effect handoff buffer so a late confirmed-exit fact still finds the pane. */
const UNBIND_GRACE_MS = 15_000

function clearUnbindTimer(ptyId: string): void {
  const timer = unbindTimersByPtyId.get(ptyId)
  if (!timer) {
    return
  }
  clearTimeout(timer)
  unbindTimersByPtyId.delete(ptyId)
}

export function bindConfirmedAgentExitResumePane(ptyId: string, paneKey: string): void {
  clearUnbindTimer(ptyId)
  paneKeyByPtyId.set(ptyId, paneKey)
}

export function scheduleUnbindConfirmedAgentExitResumePane(ptyId: string): void {
  if (!paneKeyByPtyId.has(ptyId)) {
    return
  }
  clearUnbindTimer(ptyId)
  const timer = setTimeout(() => {
    unbindTimersByPtyId.delete(ptyId)
    paneKeyByPtyId.delete(ptyId)
  }, UNBIND_GRACE_MS)
  timer.unref?.()
  unbindTimersByPtyId.set(ptyId, timer)
}

export function retireConfirmedAgentExitResumeRecord(
  state: ResumeRetirementStore,
  consumed: { paneKey: string; record: SleepingAgentSessionRecord }
): void {
  if (typeof state.clearSleepingAgentSession !== 'function') {
    return
  }
  const records = state.sleepingAgentSessionsByPaneKey ?? {}
  const duplicatePaneKeys: string[] = []
  for (const [paneKey, record] of Object.entries(records)) {
    if (
      paneKey !== consumed.paneKey &&
      record.worktreeId === consumed.record.worktreeId &&
      record.agent === consumed.record.agent &&
      agentProviderSessionsEqual(
        record.agent,
        record.providerSession,
        consumed.record.providerSession
      )
    ) {
      duplicatePaneKeys.push(paneKey)
    }
  }
  state.clearSleepingAgentSession(consumed.paneKey)
  for (const paneKey of duplicatePaneKeys) {
    state.clearSleepingAgentSession(paneKey)
  }
}

export function retireConfirmedAgentExitResumeAuthority(
  state: ResumeRetirementStore,
  paneKey: string
): void {
  const record = state.sleepingAgentSessionsByPaneKey?.[paneKey]
  if (!record) {
    return
  }
  retireConfirmedAgentExitResumeRecord(state, { paneKey, record })
}

export function retireConfirmedAgentExitResumeForPty(ptyId: string): void {
  const paneKey = paneKeyByPtyId.get(ptyId)
  if (!paneKey) {
    return
  }
  const state = useAppStore.getState()
  if (typeof state.clearSleepingAgentSession !== 'function') {
    return
  }
  retireConfirmedAgentExitResumeAuthority(state, paneKey)
}

export function _resetConfirmedAgentExitResumeBindingsForTest(): void {
  for (const timer of unbindTimersByPtyId.values()) {
    clearTimeout(timer)
  }
  unbindTimersByPtyId.clear()
  paneKeyByPtyId.clear()
}
