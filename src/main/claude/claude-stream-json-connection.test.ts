import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { spawnProcess, type SpawnedProcess } from '../../shared/child-process/run-process'
import type { ProcessSpec } from '../../shared/child-process/process-spec'
import {
  openClaudeStreamJsonConnection,
  type ClaudeControlRequest,
  type ClaudeStreamJsonConnection,
  type ClaudeStreamJsonLaunch
} from './claude-stream-json-connection'
import { claudeAuthDiagnostic } from './claude-structured-init-proof'
import { CLAUDE_STRUCTURED_BASE_OPTIONS } from './claude-structured-launch-resolution'

// These drive the real SDK against the scripted fake CLI, so every assertion is
// about the environment, argv and frames a real child actually saw.
const FAKE_CLI = join(__dirname, '__fixtures__', 'claude-agent-sdk-scripted-cli.mjs')
const SESSION_ID = '5348c19f-6a54-4c2e-9c68-9c2b1a3d4e5f'
const HOLD_OPEN = { delayMs: 10_000 }

type ScriptedCliReport = {
  argv: string[]
  controlRequests: { request_id: string; request: { subtype: string } }[]
  controlResponses: { response: { request_id: string; response?: unknown } }[]
  userMessages: Record<string, unknown>[]
}

const scratchDirs: string[] = []
const openConnections: ClaudeStreamJsonConnection[] = []

afterEach(async () => {
  for (const connection of openConnections.splice(0)) {
    await connection.close()
  }
  for (const dir of scratchDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
  spawned.splice(0)
  spawnedChildren.splice(0)
  vi.unstubAllEnvs()
})

function scriptScenario(
  steps: Record<string, unknown>[],
  controlResponses: Record<string, unknown> = {}
) {
  const dir = mkdtempSync(join(tmpdir(), 'claude-sdk-connection-'))
  scratchDirs.push(dir)
  const scenarioPath = join(dir, 'scenario.json')
  const reportPath = join(dir, 'report.json')
  writeFileSync(scenarioPath, JSON.stringify({ steps, controlResponses }))
  return {
    cwd: dir,
    env: {
      PATH: process.env.PATH ?? '',
      ORCA_SDK_CONTRACT_SCENARIO_PATH: scenarioPath,
      ORCA_SDK_CONTRACT_REPORT_PATH: reportPath
    },
    readReport: () => JSON.parse(readFileSync(reportPath, 'utf8')) as ScriptedCliReport
  }
}

function launchFor(
  scenario: { cwd: string; env: Record<string, string> },
  env: Record<string, string> = {}
): ClaudeStreamJsonLaunch {
  return {
    pathToClaudeCodeExecutable: FAKE_CLI,
    options: { ...CLAUDE_STRUCTURED_BASE_OPTIONS, sessionId: SESSION_ID },
    cwd: scenario.cwd,
    env: { ...scenario.env, ...env }
  }
}

/** The derived child environment, captured where Orca actually hands it to the OS. */
const spawned: ProcessSpec[] = []
/** The retained child, so a test can end it the way a crashing CLI would. */
const spawnedChildren: SpawnedProcess[] = []

async function open(
  launch: ClaudeStreamJsonLaunch,
  handlers: Parameters<typeof openClaudeStreamJsonConnection>[1] = {}
): Promise<ClaudeStreamJsonConnection> {
  const connection = await openClaudeStreamJsonConnection(launch, handlers, (spec) => {
    spawned.push(spec)
    const child = spawnProcess(spec)
    spawnedChildren.push(child)
    return child
  })
  openConnections.push(connection)
  return connection
}

function childEnv(): Record<string, string | undefined> {
  return (spawned.at(-1)?.env ?? {}) as Record<string, string | undefined>
}

async function until<T>(read: () => T | null | undefined, label: string): Promise<T> {
  for (let attempt = 0; attempt < 400; attempt++) {
    const value = read()
    if (value !== null && value !== undefined) {
      return value
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`timed out waiting for ${label}`)
}

function readReportSafely(scenario: { readReport: () => ScriptedCliReport }) {
  try {
    return scenario.readReport()
  } catch {
    return null
  }
}

describe('Claude stream-json connection', () => {
  it('hands the child a derived environment, the resolved CLI path, and keeps the pid', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-SHELL-LEAK')
    vi.stubEnv('CLAUDE_CODE_CHILD_SESSION', '1')
    vi.stubEnv('NODE_OPTIONS', '--require=/tmp/inject.js')
    // An inherited value wins over the SDK's default, so clear it to pin the default.
    vi.stubEnv('CLAUDE_CODE_ENTRYPOINT', undefined)
    vi.stubEnv('ORCA_CONNECTION_MARKER', 'inherited')
    const scenario = scriptScenario([HOLD_OPEN])
    const connection = await open(
      launchFor(scenario, {
        CLAUDE_CONFIG_DIR: '/accounts/managed/home',
        ANTHROPIC_AUTH_TOKEN: 'configured-token',
        ORCA_AGENT_SESSION_SPAWN_TOKEN: 'spawn-9'
      })
    )

    // Ownership proof: the pid is a real live process, not a value the SDK reported.
    expect(connection.pid).toEqual(expect.any(Number))
    expect(() => process.kill(connection.pid as number, 0)).not.toThrow()
    const env = childEnv()
    // The managed home is pinned verbatim: the CLI keys credential lookup on the literal string.
    expect(env.CLAUDE_CONFIG_DIR).toBe('/accounts/managed/home')
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('configured-token')
    expect(env.ORCA_AGENT_SESSION_SPAWN_TOKEN).toBe('spawn-9')
    expect(env.ORCA_CONNECTION_MARKER).toBe('inherited')
    expect(env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(env.CLAUDE_CODE_CHILD_SESSION).toBeUndefined()
    // Two SDK mutations of the child env, pinned so a bump cannot change them unseen.
    expect(env.CLAUDE_CODE_ENTRYPOINT).toBe('sdk-ts')
    expect(env.NODE_OPTIONS).toBeUndefined()
    // The bundled binary is excluded from the install, so the resolved path is mandatory.
    const report = await until(() => readReportSafely(scenario), 'the scripted CLI report')
    expect(report.argv[0]).toBe(FAKE_CLI)
    // The .mjs fixture makes the SDK run it under node; a real CLI path is the program
    // itself. Either way the resolved path is what Orca's spawner is asked to execute.
    expect([spawned.at(-1)?.program, ...(spawned.at(-1)?.args ?? [])]).toContain(FAKE_CLI)
    expect(report.argv).toContain('--replay-user-messages')
    expect(report.argv).toContain(`--session-id=${SESSION_ID}`)
  })

  it('leaves the default CLI home unpinned so macOS Keychain OAuth keeps working', async () => {
    const scenario = scriptScenario([HOLD_OPEN])
    await open(launchFor(scenario))

    await until(() => readReportSafely(scenario), 'the scripted CLI report')
    expect(childEnv().CLAUDE_CONFIG_DIR).toBeUndefined()
  })

  it('settles a send only once the frame reached the child, and replays reach onMessage', async () => {
    const replay = {
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      parent_tool_use_id: null,
      isReplay: true,
      session_id: SESSION_ID,
      uuid: 'uuid-replay-1'
    }
    const scenario = scriptScenario([{ awaitUserMessage: true }, { emit: replay }, HOLD_OPEN])
    const messages: Record<string, unknown>[] = []
    const connection = await open(launchFor(scenario), {
      onMessage: (message) => messages.push(message)
    })

    await connection.send({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      parent_tool_use_id: null,
      session_id: SESSION_ID
    })
    const report = await until(() => readReportSafely(scenario), 'the scripted CLI report')
    expect(report.userMessages).toHaveLength(1)

    await until(() => messages.find((message) => message.uuid === 'uuid-replay-1'), 'the replay')
    // The replay is delivered verbatim, so the dispatch acknowledgement still binds on it.
    expect(messages.find((message) => message.uuid === 'uuid-replay-1')).toEqual(replay)
  })

  it('rejects a send the SDK pulled but could not write to a terminated child', async () => {
    const scenario = scriptScenario([{ awaitUserMessage: true }, HOLD_OPEN])
    const connection = await open(launchFor(scenario))
    const child = spawnedChildren.at(-1)

    // Same tick as the send, so the liveness guard still passes and the frame
    // reaches the SDK's input pump: its `transport.write` is what fails, which is
    // the window a child crashing mid-send actually opens.
    child?.kill('SIGKILL')
    const sent = connection.send({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      parent_tool_use_id: null,
      session_id: SESSION_ID
    })

    await expect(sent).rejects.toThrow()
    expect(readReportSafely(scenario)?.userMessages ?? []).toHaveLength(0)
  })

  it('delivers an unmodeled frame verbatim so the provider-fallback row survives', async () => {
    const unknown = {
      type: 'frame_kind_from_the_future',
      session_id: SESSION_ID,
      uuid: 'uuid-unknown-1',
      payload: { nested: { flags: ['a', 'b'] } }
    }
    const scenario = scriptScenario([{ emit: unknown }, HOLD_OPEN])
    const messages: Record<string, unknown>[] = []
    await open(launchFor(scenario), { onMessage: (message) => messages.push(message) })

    await until(() => messages.find((message) => message.uuid === 'uuid-unknown-1'), 'the frame')
    expect(messages.find((message) => message.uuid === 'uuid-unknown-1')).toEqual(unknown)
  })

  it('routes an inbound permission request and writes the answer back on its own id', async () => {
    const scenario = scriptScenario([
      {
        emit: {
          type: 'control_request',
          request_id: 'perm-421',
          request: {
            subtype: 'can_use_tool',
            tool_name: 'Bash',
            input: { command: 'ls' },
            tool_use_id: 'toolu_1',
            permission_suggestions: [{ type: 'addRules' }]
          }
        }
      },
      HOLD_OPEN
    ])
    let inbound: ClaudeControlRequest | null = null
    const connection = await open(launchFor(scenario), {
      onControlRequest: (request) => {
        inbound = request
      }
    })

    await until(() => inbound, 'the inbound permission request')
    expect(inbound).toEqual({
      type: 'control_request',
      request_id: 'perm-421',
      request: {
        subtype: 'can_use_tool',
        tool_name: 'Bash',
        input: { command: 'ls' },
        tool_use_id: 'toolu_1',
        permission_suggestions: [{ type: 'addRules' }]
      }
    })

    await connection.respond('perm-421', { behavior: 'deny', message: 'No', toolUseID: 'toolu_1' })
    const written = await until(
      () =>
        readReportSafely(scenario)?.controlResponses.find(
          (frame) => frame.response.request_id === 'perm-421'
        ),
      'the permission answer'
    )
    expect(written.response.response).toMatchObject({ behavior: 'deny', message: 'No' })
  })

  it('maps Orca control requests onto the SDK and times out with the init proof message', async () => {
    const scenario = scriptScenario([HOLD_OPEN], {
      initialize: { models: [{ value: 'sonnet' }], account: { tokenSource: 'oauth' } },
      get_settings: { env: { ANTHROPIC_BASE_URL: 'https://settings.example.test' } }
    })
    const connection = await open(launchFor(scenario))

    await expect(
      connection.request('initialize', { supportedDialogKinds: [] })
    ).resolves.toMatchObject({ models: [{ value: 'sonnet' }] })
    await expect(connection.request('get_settings')).resolves.toEqual({
      env: { ANTHROPIC_BASE_URL: 'https://settings.example.test' }
    })
    await expect(connection.request('set_model', { model: 'opus' })).resolves.toEqual({})
    const requests = await until(
      () =>
        readReportSafely(scenario)?.controlRequests.find(
          (frame) => frame.request.subtype === 'set_model'
        ),
      'the set_model control request'
    )
    expect(requests.request.subtype).toBe('set_model')
  })

  it('feeds the auth diagnostic from the settings the running child reports', async () => {
    for (const key of ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY']) {
      vi.stubEnv(key, undefined)
    }
    const scenario = scriptScenario([HOLD_OPEN], {
      get_settings: {
        env: {
          ANTHROPIC_BASE_URL: 'https://settings.example.test',
          ANTHROPIC_AUTH_TOKEN: 'secret'
        }
      }
    })
    const connection = await open(launchFor(scenario))
    const init = { providerSessionId: SESSION_ID, uuid: null, message: {} }

    // With no ambient auth, every true below can only have come from the CLI's settings.
    expect(claudeAuthDiagnostic(init, null)).toMatchObject({
      baseUrlConfigured: false,
      authTokenConfigured: false
    })
    const diagnostic = claudeAuthDiagnostic(init, await connection.request('get_settings'))
    expect(diagnostic).toMatchObject({
      baseUrlConfigured: true,
      authTokenConfigured: true,
      apiKeyConfigured: false
    })
    expect(JSON.stringify(diagnostic)).not.toContain('secret')
  })

  it('reports an unauthenticated start through the init deadline instead of hanging', async () => {
    // The scripted CLI never answers, which is the shape of a silently unauthenticated CLI.
    const scenario = scriptScenario([HOLD_OPEN])
    const connection = await open({
      ...launchFor(scenario),
      env: { ...launchFor(scenario).env, ORCA_SDK_CONTRACT_IGNORE_CONTROL_REQUESTS: '1' }
    })

    await expect(
      connection.request('initialize', { supportedDialogKinds: [] }, { timeoutMs: 200 })
    ).rejects.toThrow('claude initialize request timed out')
  })

  it('reports an exit only after the child is gone and surfaces its stderr tail', async () => {
    const scenario = scriptScenario([{ stderr: 'claude: not signed in\n' }, { delayMs: 50 }])
    let exit: Error | null = null
    const connection = await open(launchFor(scenario), {
      onExit: (error) => {
        exit = error
      }
    })

    await until(() => exit, 'the exit error')
    expect((exit as unknown as Error).message).toContain('claude: not signed in')
    expect(connection.closed).toBe(true)
    await expect(connection.close()).resolves.toBe(true)
  })

  it('proves the exit of a child that ignores a graceful shutdown', async () => {
    const scenario = scriptScenario([HOLD_OPEN])
    const connection = await open({
      ...launchFor(scenario),
      env: { ...launchFor(scenario).env, ORCA_SDK_CONTRACT_IGNORE_SIGTERM: '1' }
    })

    await expect(connection.close()).resolves.toBe(true)
  }, 20_000)
})
