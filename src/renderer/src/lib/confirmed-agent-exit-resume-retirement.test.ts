import { afterEach, describe, expect, it } from 'vitest'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import { useAppStore } from '@/store'
import { resumeSleepingAgentSessionsForWorktree } from './resume-sleeping-agent-session'
import {
  bindConfirmedAgentExitResumePane,
  retireConfirmedAgentExitResumeAuthority,
  retireConfirmedAgentExitResumeForPty,
  _resetConfirmedAgentExitResumeBindingsForTest
} from './confirmed-agent-exit-resume-retirement'

const initialState = useAppStore.getState()

afterEach(() => {
  _resetConfirmedAgentExitResumeBindingsForTest()
  useAppStore.setState(initialState, true)
})

function makeRecord(
  overrides: Partial<SleepingAgentSessionRecord> = {}
): SleepingAgentSessionRecord {
  return {
    paneKey: 'tab-1:leaf-1',
    tabId: 'tab-1',
    worktreeId: 'wt-1',
    agent: 'claude',
    providerSession: { key: 'session_id', id: 'sess-1' },
    prompt: 'finish the task',
    state: 'working',
    capturedAt: 1,
    updatedAt: 1,
    origin: 'live',
    ...overrides
  }
}

function seedOrphanRecord(record: SleepingAgentSessionRecord): void {
  useAppStore.setState({
    tabsByWorktree: {
      'wt-1': [
        {
          id: 'other-tab',
          ptyId: null,
          worktreeId: 'wt-1',
          title: 'shell',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 1
        }
      ]
    },
    sleepingAgentSessionsByPaneKey: { [record.paneKey]: record }
  } as never)
}

describe('confirmed agent-exit resume retirement', () => {
  it('retires only the confirmed session and keeps a sibling provider session', () => {
    const record = makeRecord()
    const duplicate = makeRecord({
      paneKey: 'tab-1:1',
      capturedAt: 2,
      updatedAt: 2
    })
    const sibling = makeRecord({
      paneKey: 'tab-1:leaf-2',
      providerSession: { key: 'session_id', id: 'sess-2' }
    })
    useAppStore.setState({
      tabsByWorktree: { 'wt-1': [] },
      sleepingAgentSessionsByPaneKey: {
        [record.paneKey]: record,
        [duplicate.paneKey]: duplicate,
        [sibling.paneKey]: sibling
      }
    } as never)

    retireConfirmedAgentExitResumeAuthority(useAppStore.getState(), record.paneKey)

    expect(useAppStore.getState().sleepingAgentSessionsByPaneKey[record.paneKey]).toBeUndefined()
    expect(useAppStore.getState().sleepingAgentSessionsByPaneKey[duplicate.paneKey]).toBeUndefined()
    expect(useAppStore.getState().sleepingAgentSessionsByPaneKey[sibling.paneKey]).toEqual(sibling)
  })

  it('retires a clean-exit record so the next launch does not resume it', () => {
    seedOrphanRecord(makeRecord())
    retireConfirmedAgentExitResumeAuthority(useAppStore.getState(), 'tab-1:leaf-1')
    expect(useAppStore.getState().sleepingAgentSessionsByPaneKey['tab-1:leaf-1']).toBeUndefined()
    expect(resumeSleepingAgentSessionsForWorktree('wt-1')).toBe(0)
  })

  it('still offers resume when a working record was never retired after a crash', () => {
    const record = makeRecord()
    seedOrphanRecord(record)

    expect(resumeSleepingAgentSessionsForWorktree('wt-1')).toBe(1)
  })

  it('does not retire an unverifiable remote record that never received a confirmed exit', () => {
    const record = makeRecord({ connectionId: 'ssh-conn-1' })
    seedOrphanRecord(record)

    expect(useAppStore.getState().sleepingAgentSessionsByPaneKey[record.paneKey]).toEqual(record)
    expect(resumeSleepingAgentSessionsForWorktree('wt-1')).toBe(1)
  })

  it('retires by PTY binding so a late confirmed-exit fact still finds the pane', () => {
    const record = makeRecord()
    seedOrphanRecord(record)
    bindConfirmedAgentExitResumePane('pty-late', record.paneKey)

    retireConfirmedAgentExitResumeForPty('pty-late')

    expect(useAppStore.getState().sleepingAgentSessionsByPaneKey[record.paneKey]).toBeUndefined()
    expect(resumeSleepingAgentSessionsForWorktree('wt-1')).toBe(0)
  })
})
