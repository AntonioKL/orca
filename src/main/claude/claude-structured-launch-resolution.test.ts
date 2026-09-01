import { chmodSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { describe, expect, it } from 'vitest'
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

function makeExecutable(path: string): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, '')
  if (process.platform !== 'win32') {
    chmodSync(path, 0o755)
  }
}

function resolverFor(value: AgentSessionRecord | null, resolveEnv?: () => Record<string, string>) {
  return createClaudeStructuredLaunchResolver({
    store: { getRecord: () => value } as unknown as AgentSessionRecordStore,
    resolveWorkspacePath: async (id) => `/repos/${id}`,
    resolveCommand: () => '/usr/local/bin/claude',
    ...(resolveEnv ? { resolveEnv } : {})
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

  it('preserves durable Claude launch arguments before structured defaults', async () => {
    const launch = await resolverFor(
      record({ launchArgs: ['--model', 'claude-sonnet-4-5', '--dangerously-skip-permissions'] })
    )({ identity: IDENTITY })

    expect(launch.args.slice(0, 4)).toEqual([
      '--model',
      'claude-sonnet-4-5',
      '--dangerously-skip-permissions',
      '-p'
    ])
  })

  it('keeps the session launch environment pinned after account settings change', async () => {
    const resolver = resolverFor(record(), () => ({
      ANTHROPIC_AUTH_TOKEN: 'rotated-token',
      ANTHROPIC_BASE_URL: 'https://gateway.example.test'
    }))

    expect((await resolver({ identity: IDENTITY })).env).toMatchObject({
      ANTHROPIC_AUTH_TOKEN: 'rotated-token',
      ANTHROPIC_BASE_URL: 'https://gateway.example.test'
    })
    expect((await resolver({ identity: IDENTITY })).env?.ANTHROPIC_AUTH_TOKEN).toBe('rotated-token')
  })

  it('strips ambient Anthropic auth from the inherited env but keeps the rest of it', async () => {
    const restore = {
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN,
      CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN,
      ORCA_LAUNCH_RESOLUTION_MARKER: process.env.ORCA_LAUNCH_RESOLUTION_MARKER
    }
    process.env.ANTHROPIC_API_KEY = 'sk-ant-SHELL-LEAK'
    process.env.ANTHROPIC_AUTH_TOKEN = 'tok-SHELL-LEAK'
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'oauth-SHELL-LEAK'
    process.env.ORCA_LAUNCH_RESOLUTION_MARKER = 'inherited'
    try {
      const launch = await resolverFor(record())({ identity: IDENTITY })

      expect(launch.env?.ANTHROPIC_API_KEY).toBeUndefined()
      expect(launch.env?.ANTHROPIC_AUTH_TOKEN).toBeUndefined()
      expect(launch.env?.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined()
      // The inherited env is still the base — only auth is removed from it.
      expect(launch.env?.ORCA_LAUNCH_RESOLUTION_MARKER).toBe('inherited')
      expect(launch.env?.PATH ?? launch.env?.Path).toBeTruthy()
    } finally {
      for (const [key, value] of Object.entries(restore)) {
        if (value === undefined) {
          delete process.env[key]
        } else {
          process.env[key] = value
        }
      }
    }
  })

  it('lets an explicit Claude env overlay override the stripped ambient auth', async () => {
    const restore = process.env.ANTHROPIC_API_KEY
    process.env.ANTHROPIC_API_KEY = 'sk-ant-SHELL-LEAK'
    try {
      const launch = await resolverFor(record(), () => ({
        ANTHROPIC_API_KEY: 'sk-ant-CONFIGURED'
      }))({ identity: IDENTITY })

      expect(launch.env?.ANTHROPIC_API_KEY).toBe('sk-ant-CONFIGURED')
    } finally {
      if (restore === undefined) {
        delete process.env.ANTHROPIC_API_KEY
      } else {
        process.env.ANTHROPIC_API_KEY = restore
      }
    }
  })

  it('pairs a resolved Claude CLI with its sibling Node runtime', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-claude-launch-'))
    const binDir = join(root, 'bin')
    const claudeCommand = join(binDir, process.platform === 'win32' ? 'claude.cmd' : 'claude')
    const nodeCommand = join(binDir, process.platform === 'win32' ? 'node.cmd' : 'node')
    makeExecutable(claudeCommand)
    makeExecutable(nodeCommand)

    const launch = await createClaudeStructuredLaunchResolver({
      store: { getRecord: () => record() } as unknown as AgentSessionRecordStore,
      resolveWorkspacePath: async (id) => `/repos/${id}`,
      resolveCommand: () => claudeCommand,
      resolveEnv: () => ({
        PATH: '/usr/bin',
        CLAUDE_CONFIG_DIR: '/accounts/selected/home'
      })
    })({ identity: IDENTITY })

    expect((launch.env?.PATH ?? launch.env?.Path)?.split(delimiter)[0]).toBe(binDir)
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
      resolverFor(record({ accountHome: { variable: 'CODEX_HOME', path: '/tmp/codex' } }))({
        identity: IDENTITY
      })
    ).rejects.toThrow(/CLAUDE_CONFIG_DIR/)
  })
})
