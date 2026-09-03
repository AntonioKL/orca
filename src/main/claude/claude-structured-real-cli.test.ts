import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AgentSessionJournalIdentity } from '../../shared/agent-session-journal-types'
import { resolveClaudeCommand } from '../codex-cli/command'
import { resolveSessionFilePath } from '../native-chat/session-file-resolver'
import { getSpawnArgsForWindows } from '../win32-utils'
import { CLAUDE_STRUCTURED_BASE_OPTIONS } from './claude-structured-launch-resolution'
import {
  ClaudeStructuredSessionAdapter,
  type ClaudeStructuredSessionEvent
} from './claude-structured-session-adapter'

const command = resolveClaudeCommand()
const versionLaunch = getSpawnArgsForWindows(command, ['--version'])
const realClaudeAvailable =
  spawnSync(versionLaunch.spawnCmd, versionLaunch.spawnArgs, {
    stdio: 'ignore',
    windowsHide: true,
    timeout: 5_000
  }).status === 0
const authStatusLaunch = getSpawnArgsForWindows(command, ['auth', 'status', '--json'])
const realClaudeAuthenticated = (() => {
  if (!realClaudeAvailable) {
    return false
  }
  const result = spawnSync(authStatusLaunch.spawnCmd, authStatusLaunch.spawnArgs, {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 5_000
  })
  return result.status === 0 && /"loggedIn"\s*:\s*true/.test(result.stdout)
})()

function realAdapter(
  providerSessionId: string,
  claudeConfigDir: string,
  events: ClaudeStructuredSessionEvent[] = []
): ClaudeStructuredSessionAdapter {
  return new ClaudeStructuredSessionAdapter({
    resolveLaunch: async () => ({
      pathToClaudeCodeExecutable: command,
      options: { ...CLAUDE_STRUCTURED_BASE_OPTIONS, sessionId: providerSessionId },
      cwd: process.cwd(),
      claudeConfigDir,
      providerSessionId,
      resumeLeafUuid: null,
      resumed: false
    }),
    onEvent: (event) => events.push(event),
    readProcessStartTime: async () => 1,
    now: () => 2,
    initTimeoutMs: 5_000
  })
}

function identity(providerSessionId: string): AgentSessionJournalIdentity {
  return {
    sessionId: 'real-cli-handshake',
    workspaceId: 'real-cli-workspace',
    hostId: 'local',
    agent: 'claude',
    providerHandle: { kind: 'claude', sessionId: providerSessionId, leafUuid: null }
  }
}

/** The CLI flushes its transcript on its own schedule; poll rather than race it. */
async function waitForResolvedTranscript(
  providerSessionId: string,
  claudeProjectsDir: string,
  timeoutMs = 15_000
): Promise<string | null> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const resolved = await resolveSessionFilePath('claude', providerSessionId, {
      claudeProjectsDir
    })
    if (resolved || Date.now() >= deadline) {
      return resolved
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
}

describe.skipIf(!realClaudeAvailable)('Claude structured real CLI handshake', () => {
  it.skipIf(!realClaudeAuthenticated)(
    'proves a pre-minted session before the first user message',
    async () => {
      const providerSessionId = randomUUID()
      const claudeConfigDir = process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), '.claude')
      const events: ClaudeStructuredSessionEvent[] = []
      const adapter = realAdapter(providerSessionId, claudeConfigDir, events)

      try {
        const acquisition = await adapter.acquire({
          identity: identity(providerSessionId),
          fence: 1,
          spawnToken: 'real-cli'
        })
        const observedSubtypes = events.flatMap((event) =>
          event.type === 'message' ? [event.message.subtype] : []
        )

        expect(acquisition.link.handle).toMatchObject({
          provider: 'claude',
          sessionId: providerSessionId,
          // Init/SessionStart UUIDs are protocol frames, not resumable
          // main-transcript leaves; no cursor exists before the first user turn.
          leafUuid: null
        })
        expect(observedSubtypes).toContain('hook_started')
      } finally {
        await adapter.closeAll()
      }
    },
    10_000
  )

  // Mobile native chat never reads the structured journal — it reads the CLI's own
  // transcript through native-chat/session-file-resolver.ts, which is also how
  // structured-claude-runtime-adapter.ts recovers a leaf. So the SDK-spawned CLI has
  // to keep writing that transcript under the pinned account home; if it ever moved,
  // mobile chat and TUI resume would both go dark with no wire-level error.
  // The turn is what creates the file: an init-only handshake writes nothing.
  it.skipIf(!realClaudeAuthenticated)(
    'writes its transcript where the mobile session-file resolver looks for it',
    async () => {
      const providerSessionId = randomUUID()
      const claudeConfigDir = process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), '.claude')
      const adapter = realAdapter(providerSessionId, claudeConfigDir)
      const projectsDir = join(claudeConfigDir, 'projects')

      let transcriptPath: string | null = null
      try {
        await adapter.acquire({
          identity: identity(providerSessionId),
          fence: 1,
          spawnToken: 'real-cli-transcript'
        })
        await adapter.dispatch({
          sessionId: 'real-cli-handshake',
          clientMessageId: 'real-cli-transcript-1',
          body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'hi' }] },
          fence: 1
        })
        transcriptPath = await waitForResolvedTranscript(providerSessionId, projectsDir)
      } finally {
        await adapter.closeAll()
      }

      expect(transcriptPath).not.toBeNull()
      expect(basename(transcriptPath ?? '')).toBe(`${providerSessionId}.jsonl`)
      // `<pinned account home>/projects/<project slug>/<provider session id>.jsonl`
      expect(relative(projectsDir, transcriptPath ?? '').split(/[\\/]/)).toHaveLength(2)
    },
    45_000
  )

  it('turns a real silent unauthenticated startup into sign-in guidance', async () => {
    const claudeConfigDir = await mkdtemp(join(tmpdir(), 'orca-claude-no-auth-'))
    const providerSessionId = randomUUID()
    const adapter = realAdapter(providerSessionId, claudeConfigDir)

    try {
      await expect(
        adapter.acquire({
          identity: identity(providerSessionId),
          fence: 1,
          spawnToken: 'real-cli-no-auth'
        })
      ).rejects.toThrow(/not signed in.*Claude CLI.*CLAUDE_CONFIG_DIR/s)
    } finally {
      await adapter.closeAll()
      await rm(claudeConfigDir, { recursive: true, force: true })
    }
  }, 10_000)
})
