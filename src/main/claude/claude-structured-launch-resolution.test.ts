import { describe, expect, it } from 'vitest'
import { delimiter, dirname } from 'node:path'
import type { AgentSessionRecord } from '../../shared/agent-session-record'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import type { AgentSessionRecordStore } from '../runtime/agent-session-record-store'
import {
  CLAUDE_DEFAULT_SETTING_SOURCES,
  CLAUDE_STRUCTURED_BASE_ARGS,
  claudeSessionIdForOrcaSession,
  createClaudeStructuredLaunchResolver
} from './claude-structured-launch-resolution'

const SESSION_ID = 'orca-session-1'
const IDENTITY = { sessionId: SESSION_ID } as Parameters<
  ReturnType<typeof createClaudeStructuredLaunchResolver>
>[0]['identity']

function record(overrides: Partial<AgentSessionRecord> = {}): AgentSessionRecord {
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
    providerHandleChain: [],
    ...overrides
  } as AgentSessionRecord
}

function resolverFor(
  value: AgentSessionRecord | null,
  resolveEnv?: () => Record<string, string>,
  platform: NodeJS.Platform = 'linux'
) {
  return createClaudeStructuredLaunchResolver({
    store: { getRecord: () => value } as unknown as AgentSessionRecordStore,
    resolveWorkspacePath: async (id) => `/repos/${id}`,
    resolveCommand: () => '/usr/local/bin/claude',
    ...(resolveEnv ? { resolveEnvironment: async () => resolveEnv() } : {}),
    platform
  })
}

describe('claude structured launch resolution', () => {
  it('pre-mints a stable provider id and pins interactive setting sources', async () => {
    const first = await resolverFor(record())({ identity: IDENTITY })
    const second = await resolverFor(record())({ identity: IDENTITY })

    expect(first.providerSessionId).toBe(claudeSessionIdForOrcaSession(SESSION_ID))
    expect(second.providerSessionId).toBe(first.providerSessionId)
    expect(first).toMatchObject({
      command: '/usr/local/bin/claude',
      cwd: '/repos/workspace-1',
      claudeConfigDir: '/home/work/.claude',
      resumeLeafUuid: null,
      resumed: false
    })
    expect(first.args).toContain('--session-id')
    expect(first.args).toContain(first.providerSessionId)
    expect(first.args).toContain('--permission-prompt-tool')
    expect(first.args).toContain('stdio')
    expect(first.args).toContain('--setting-sources')
    expect(first.args).toContain(CLAUDE_DEFAULT_SETTING_SOURCES.join(','))
    expect(CLAUDE_STRUCTURED_BASE_ARGS).toContain('--verbose')
  })

  it('resumes the session and leaf at the durable chain head', async () => {
    const launch = await resolverFor(
      record({
        providerHandleChain: [
          { handle: { provider: 'claude', sessionId: 'provider-old', leafUuid: 'leaf-old' } },
          {
            handle: {
              provider: 'claude',
              sessionId: 'provider-current',
              leafUuid: 'leaf-current'
            }
          }
        ] as AgentSessionRecord['providerHandleChain']
      })
    )({ identity: IDENTITY })

    expect(launch).toMatchObject({
      providerSessionId: 'provider-current',
      resumeLeafUuid: 'leaf-current',
      resumed: true
    })
    expect(launch.args.slice(-2)).toEqual(['--resume', 'provider-current'])
  })

  it('preserves launch arguments pinned when the session was created', async () => {
    const launch = await resolverFor(record({ launchArgs: ['--dangerously-skip-permissions'] }))({
      identity: IDENTITY
    })

    expect(launch.args[0]).toBe('--dangerously-skip-permissions')
    expect(launch.args.slice(-2)).toEqual(['--session-id', launch.providerSessionId])
  })

  it('uses the runtime environment instead of the scrubbed legacy launchEnv', async () => {
    const pinned = record()
    const resolver = resolverFor(pinned, () => ({
      ANTHROPIC_AUTH_TOKEN: 'rotated-token',
      ANTHROPIC_BASE_URL: 'https://gateway.example.test'
    }))

    expect((await resolver({ identity: IDENTITY })).env).toEqual({
      ANTHROPIC_AUTH_TOKEN: 'rotated-token',
      ANTHROPIC_BASE_URL: 'https://gateway.example.test'
    })
    expect((await resolver({ identity: IDENTITY })).env?.ANTHROPIC_AUTH_TOKEN).toBe('rotated-token')
  })

  it("pairs Claude's resolved binary with its sibling Node runtime", async () => {
    const resolver = createClaudeStructuredLaunchResolver({
      store: { getRecord: () => record() } as unknown as AgentSessionRecordStore,
      resolveWorkspacePath: async () => '/repos/workspace-1',
      resolveCommand: () => process.execPath,
      resolveEnvironment: async () => ({ PATH: `/usr/bin${delimiter}/opt/bin` })
    })

    const launch = await resolver({ identity: IDENTITY })
    expect(launch.env?.PATH?.split(delimiter)[0]).toBe(dirname(process.execPath))
  })

  it('refuses other hosts, WSL, providers, and account-home variables', async () => {
    await expect(
      resolverFor(record({ location: { ...record().location, executionHostId: 'ssh:build' } }))({
        identity: IDENTITY
      })
    ).rejects.toThrow(/local host/)
    await expect(
      resolverFor(record({ location: { ...record().location, wslDistro: 'Ubuntu' } }))({
        identity: IDENTITY
      })
    ).rejects.toThrow(/local host/)
    await expect(
      resolverFor(record({ provider: 'codex' } as Partial<AgentSessionRecord>))({
        identity: IDENTITY
      })
    ).rejects.toThrow(/codex session/)
    await expect(
      resolverFor(
        record({ accountHome: { variable: 'CODEX_HOME', path: '/tmp/codex' } }),
        undefined,
        'linux'
      )({
        identity: IDENTITY
      })
    ).rejects.toThrow(/CLAUDE_CONFIG_DIR/)
  })
})
