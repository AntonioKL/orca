import { describe, expect, it } from 'vitest'
import {
  stripYoloTuiAgentLaunchArgs,
  stripYoloTuiAgentLaunchEnv
} from './tui-agent-launch-defaults'

describe('stripping permission-bypass launch defaults', () => {
  it('removes the agent bypass flag and keeps every other argument', () => {
    expect(
      stripYoloTuiAgentLaunchArgs('claude', '--dangerously-skip-permissions --model opus')
    ).toBe('--model opus')
    expect(
      stripYoloTuiAgentLaunchArgs('codex', '--dangerously-bypass-approvals-and-sandbox -m gpt-5.4')
    ).toBe('-m gpt-5.4')
  })

  it('removes a multi-token bypass form whole', () => {
    expect(stripYoloTuiAgentLaunchArgs('grok', '--permission-mode bypassPermissions --fast')).toBe(
      '--fast'
    )
  })

  it('leaves a non-bypass argument that merely shares a prefix', () => {
    expect(stripYoloTuiAgentLaunchArgs('claude', '--dangerously-skip-permissions-not-really')).toBe(
      '--dangerously-skip-permissions-not-really'
    )
  })

  it('is a no-op for an agent with no bypass flag', () => {
    expect(stripYoloTuiAgentLaunchArgs('opencode', '--session abc')).toBe('--session abc')
  })

  // Reachability note: no agent in RESUMABLE_TUI_AGENTS currently has an env-based bypass
  // profile, so the resume path's env strip is inert today. The helper is the generic
  // counterpart of the args strip and is exercised here on the one agent that has one.
  it('removes only env names the agent bypass profile sets to that exact value', () => {
    expect(stripYoloTuiAgentLaunchEnv('goose', { GOOSE_MODE: 'auto', OTHER: 'keep' })).toEqual({
      OTHER: 'keep'
    })
    expect(stripYoloTuiAgentLaunchEnv('goose', { GOOSE_MODE: 'approve' })).toEqual({
      GOOSE_MODE: 'approve'
    })
    expect(stripYoloTuiAgentLaunchEnv('claude', { ANTHROPIC_MODEL: 'opus' })).toEqual({
      ANTHROPIC_MODEL: 'opus'
    })
  })
})
