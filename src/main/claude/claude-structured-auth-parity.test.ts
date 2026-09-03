import { afterEach, describe, expect, it } from 'vitest'
import type { AgentSessionRecord } from '../../shared/agent-session-record'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import { beginClaudeAuthSwitch, endClaudeAuthSwitch } from '../claude-accounts/live-pty-gate'
import {
  CLAUDE_AUTH_ENV_CONFLICT_MESSAGE,
  CLAUDE_AUTH_SWITCH_IN_PROGRESS_MESSAGE
} from '../claude-accounts/environment'
import type { AgentSessionRecordStore } from '../runtime/agent-session-record-store'
import { createClaudeStructuredLaunchResolver } from './claude-structured-launch-resolution'
import { adapterFor, fakeClaude, identityFor } from './claude-structured-session-test-support'

const SESSION_ID = 'orca-session-auth'
const IDENTITY = { sessionId: SESSION_ID } as Parameters<
  ReturnType<typeof createClaudeStructuredLaunchResolver>
>[0]['identity']

function record(): AgentSessionRecord {
  return {
    sessionId: SESSION_ID,
    provider: 'claude',
    location: {
      executionHostId: LOCAL_EXECUTION_HOST_ID,
      wslDistro: null,
      workspaceId: 'workspace-1',
      workspaceKind: 'folder'
    },
    accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: '/home/work/.claude' },
    providerHandleChain: []
  } as unknown as AgentSessionRecord
}

function resolverFor(options: {
  stripAuthEnv?: boolean
  overlay?: Record<string, string>
}): ReturnType<typeof createClaudeStructuredLaunchResolver> {
  return createClaudeStructuredLaunchResolver({
    store: { getRecord: () => record() } as unknown as AgentSessionRecordStore,
    resolveWorkspacePath: async (id) => `/repos/${id}`,
    resolveCommand: () => '/usr/local/bin/claude',
    ...(options.stripAuthEnv === undefined
      ? {}
      : { resolveAuthPolicy: () => ({ stripAuthEnv: options.stripAuthEnv === true }) }),
    ...(options.overlay ? { resolveEnv: () => options.overlay as Record<string, string> } : {})
  })
}

function withAmbientAuth<T>(value: string, run: () => Promise<T>): Promise<T> {
  const restore = process.env.ANTHROPIC_API_KEY
  process.env.ANTHROPIC_API_KEY = value
  return run().finally(() => {
    if (restore === undefined) {
      delete process.env.ANTHROPIC_API_KEY
    } else {
      process.env.ANTHROPIC_API_KEY = restore
    }
  })
}

describe('claude structured auth parity with the terminal preflight', () => {
  afterEach(() => {
    endClaudeAuthSwitch()
  })

  // Task 1 — the terminal preflight refuses this at spawn-env.ts:25 and
  // runtime/spawn-preflight.ts:139; the structured path used to let the override win.
  it('refuses an explicit Anthropic auth override while a managed account is pinned', async () => {
    await expect(
      resolverFor({ stripAuthEnv: true, overlay: { ANTHROPIC_API_KEY: 'sk-ant-CONFIGURED' } })({
        identity: IDENTITY
      })
    ).rejects.toThrow(CLAUDE_AUTH_ENV_CONFLICT_MESSAGE)
  })

  it('refuses an auth-like ANTHROPIC_CUSTOM_HEADERS override while a managed account is pinned', async () => {
    await expect(
      resolverFor({
        stripAuthEnv: true,
        overlay: { ANTHROPIC_CUSTOM_HEADERS: 'Authorization: Bearer sk-ant-CONFIGURED' }
      })({ identity: IDENTITY })
    ).rejects.toThrow(CLAUDE_AUTH_ENV_CONFLICT_MESSAGE)
  })

  it('still admits a non-auth env overlay under a managed account', async () => {
    const launch = await resolverFor({
      stripAuthEnv: true,
      overlay: { ANTHROPIC_BASE_URL: 'https://gateway.example.test' }
    })({ identity: IDENTITY })

    expect(launch.env?.ANTHROPIC_BASE_URL).toBe('https://gateway.example.test')
  })

  // Task 2 — legacy computes stripAuthEnv at runtime-auth-preparation.ts:72, so a
  // system-auth user's own shell key is their sign-in and must survive.
  it('passes an ambient Anthropic key through when no managed account is active', async () => {
    await withAmbientAuth('sk-ant-SHELL', async () => {
      const launch = await resolverFor({ stripAuthEnv: false })({ identity: IDENTITY })

      expect(launch.env?.ANTHROPIC_API_KEY).toBe('sk-ant-SHELL')
    })
  })

  it('lets an explicit overlay override the ambient key when no managed account is active', async () => {
    await withAmbientAuth('sk-ant-SHELL', async () => {
      const launch = await resolverFor({
        stripAuthEnv: false,
        overlay: { ANTHROPIC_API_KEY: 'sk-ant-CONFIGURED' }
      })({ identity: IDENTITY })

      expect(launch.env?.ANTHROPIC_API_KEY).toBe('sk-ant-CONFIGURED')
    })
  })

  it('still strips the ambient Anthropic key when a managed account is pinned', async () => {
    await withAmbientAuth('sk-ant-SHELL', async () => {
      const launch = await resolverFor({ stripAuthEnv: true })({ identity: IDENTITY })

      expect(launch.env?.ANTHROPIC_API_KEY).toBeUndefined()
    })
  })

  // Task 3 — the terminal preflight guards this at four sites; the structured path had none.
  it('refuses launch resolution while a Claude account switch is in progress', async () => {
    beginClaudeAuthSwitch()

    await expect(resolverFor({ stripAuthEnv: true })({ identity: IDENTITY })).rejects.toThrow(
      CLAUDE_AUTH_SWITCH_IN_PROGRESS_MESSAGE
    )
  })

  it('refuses an acquire before it tears the previous session down', async () => {
    const claude = fakeClaude()
    const adapter = adapterFor(claude)
    beginClaudeAuthSwitch()

    await expect(
      adapter.acquire({ identity: identityFor(), fence: 7, spawnToken: 'spawn-9' })
    ).rejects.toThrow(CLAUDE_AUTH_SWITCH_IN_PROGRESS_MESSAGE)
    // Nothing was spawned, so the refusal must not have opened a connection.
    expect(claude.connections).toHaveLength(0)
  })
})
