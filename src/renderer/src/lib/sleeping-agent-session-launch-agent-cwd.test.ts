import { afterEach, describe, expect, it } from 'vitest'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import type { TerminalTab } from '../../../shared/terminal-tab-types'
import { useAppStore } from '@/store'
import { resumeSleepingAgentSessionsForWorktree } from './resume-sleeping-agent-session'

const initialAppStoreState = useAppStore.getState()

const WORKTREE_ID = 'wt-1'
const AGENT_SUBDIRECTORY = '/repo/wt-1/packages/api'

afterEach(() => {
  useAppStore.setState(initialAppStoreState, true)
})

function seedWorktreeWithSleepingRecord(
  overrides: Partial<SleepingAgentSessionRecord> & Pick<SleepingAgentSessionRecord, 'agent'>
): SleepingAgentSessionRecord {
  const record: SleepingAgentSessionRecord = {
    paneKey: 'tab-1:leaf-1',
    tabId: 'tab-1',
    worktreeId: WORKTREE_ID,
    providerSession: { key: 'session_id', id: 'session-1' },
    prompt: '',
    state: 'working',
    capturedAt: 1,
    updatedAt: 1,
    origin: 'worktree-sleep',
    ...overrides
  }
  const tab: TerminalTab = {
    id: 'tab-1',
    ptyId: null,
    worktreeId: WORKTREE_ID,
    title: 'shell',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  }
  useAppStore.setState({
    tabsByWorktree: { [WORKTREE_ID]: [tab] },
    sleepingAgentSessionsByPaneKey: { [record.paneKey]: record }
  })
  return record
}

function resumeAndReadLaunch(): { startupCwd: string | undefined; command: string } {
  expect(resumeSleepingAgentSessionsForWorktree(WORKTREE_ID)).toBe(1)
  const state = useAppStore.getState()
  const resumedTab = state.tabsByWorktree[WORKTREE_ID]?.find((tab) => tab.id !== 'tab-1')
  expect(resumedTab).toBeDefined()
  return {
    startupCwd: resumedTab!.startupCwd,
    command: state.pendingStartupByTabId[resumedTab!.id]?.command ?? ''
  }
}

describe('resuming a sleeping agent session in the directory the agent reported (STA-5804)', () => {
  it('roots a Claude resume at the agent-reported subdirectory, not the pane worktree', () => {
    seedWorktreeWithSleepingRecord({ agent: 'claude', agentCwd: AGENT_SUBDIRECTORY })

    const launch = resumeAndReadLaunch()

    expect(launch.startupCwd).toBe(AGENT_SUBDIRECTORY)
    expect(launch.command).toContain("'--resume' 'session-1'")
  })

  it('roots a Codex resume at the agent-reported subdirectory too', () => {
    seedWorktreeWithSleepingRecord({ agent: 'codex', agentCwd: AGENT_SUBDIRECTORY })

    const launch = resumeAndReadLaunch()

    expect(launch.startupCwd).toBe(AGENT_SUBDIRECTORY)
    expect(launch.command).toContain("'resume' 'session-1'")
  })

  it('keeps the configured permission-bypass defaults when the directory is known', () => {
    useAppStore.setState({
      settings: {
        ...useAppStore.getState().settings,
        agentDefaultArgs: { claude: '--dangerously-skip-permissions' }
      } as never
    })
    seedWorktreeWithSleepingRecord({ agent: 'claude', agentCwd: AGENT_SUBDIRECTORY })

    const launch = resumeAndReadLaunch()

    expect(launch.startupCwd).toBe(AGENT_SUBDIRECTORY)
    expect(launch.command).toContain("'--dangerously-skip-permissions'")
  })

  it('does not invent a directory for a record that never captured one', () => {
    seedWorktreeWithSleepingRecord({ agent: 'claude' })

    const launch = resumeAndReadLaunch()

    expect(launch.startupCwd).toBeUndefined()
  })

  it('drops the permission bypass when the directory is unknown (legacy record)', () => {
    useAppStore.setState({
      settings: {
        ...useAppStore.getState().settings,
        agentDefaultArgs: { claude: '--dangerously-skip-permissions' }
      } as never
    })
    // A record written before STA-5804: no agentCwd field at all.
    seedWorktreeWithSleepingRecord({ agent: 'claude' })

    const launch = resumeAndReadLaunch()

    expect(launch.command).not.toContain("'--dangerously-skip-permissions'")
    expect(launch.command).toContain("'--resume' 'session-1'")
  })

  it('drops the Codex approval bypass when the directory is unknown', () => {
    useAppStore.setState({
      settings: {
        ...useAppStore.getState().settings,
        agentDefaultArgs: { codex: '--dangerously-bypass-approvals-and-sandbox' }
      } as never
    })
    seedWorktreeWithSleepingRecord({ agent: 'codex' })

    const launch = resumeAndReadLaunch()

    expect(launch.command).not.toContain("'--dangerously-bypass-approvals-and-sandbox'")
    expect(launch.command).toContain("'resume' 'session-1'")
  })

  it('strips the bypass from the persisted launch config args too', () => {
    seedWorktreeWithSleepingRecord({
      agent: 'claude',
      launchConfig: {
        agentArgs: '--dangerously-skip-permissions --model opus',
        agentEnv: {}
      }
    })

    expect(resumeSleepingAgentSessionsForWorktree(WORKTREE_ID)).toBe(1)
    const state = useAppStore.getState()
    const resumedTab = state.tabsByWorktree[WORKTREE_ID]?.find((tab) => tab.id !== 'tab-1')
    const startup = state.pendingStartupByTabId[resumedTab!.id]
    expect(startup?.command).not.toContain("'--dangerously-skip-permissions'")
    expect(startup?.command).toContain("'--model' 'opus'")
    // The runtime spawn path re-derives the command from this override; it must agree.
    expect(startup?.agentArgsOverride).toBe('--model opus')
  })
})
