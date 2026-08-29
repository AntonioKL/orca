import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentHookServer, _internals } from './server'
import { buildBody, PANE } from './server.test-fixtures'

// Why these exact bodies: measured against omp 17.0.5 with Orca's managed extension side-loaded
// via `-e` alongside an unmanaged copy auto-discovered from the agent's extensions dir. Both post
// the same pane key to /hook/omp from the same process; the managed copy always carries a
// `launchToken` key (empty string when ORCA_AGENT_LAUNCH_TOKEN is unset), the unmanaged copy omits
// the key entirely, and the unmanaged `agent_end` lands *first*.
const LAUNCH_TOKEN = 'launch-token-abc'

vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: () => ({ nth_repo_added: 2 })
}))

beforeEach(() => {
  _internals.resetCachesForTests()
})

afterEach(() => {
  vi.restoreAllMocks()
})

type Post = { hookEventName: string; launchToken?: string }

// Why structural: the server's enriched payload type is module-private; the assertions only
// read the route and the projected state.
type StatusEvent = { source?: string; payload: { state?: string } }

function states(events: StatusEvent[]): (string | undefined)[] {
  return events.map((event) => event.payload.state)
}

async function runOmpPosts(server: AgentHookServer, posts: Post[]): Promise<StatusEvent[]> {
  const seen: StatusEvent[] = []
  server.setListener((payload) => {
    seen.push(payload)
  })
  const env = server.buildPtyEnv()
  for (const post of posts) {
    await fetch(`http://127.0.0.1:${env.ORCA_AGENT_HOOK_PORT}/hook/omp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Orca-Agent-Hook-Token': env.ORCA_AGENT_HOOK_TOKEN
      },
      body: JSON.stringify(
        buildBody(
          { hook_event_name: post.hookEventName },
          post.launchToken === undefined ? {} : { launchToken: post.launchToken }
        )
      )
    })
  }
  return seen
}

describe('unmanaged OMP status extension', () => {
  it('drops the unmanaged copy’s agent_end once a tokened poster owns the pane', async () => {
    const server = new AgentHookServer()
    await server.start({ env: 'production' })
    try {
      const seen = await runOmpPosts(server, [
        { hookEventName: 'agent_start', launchToken: LAUNCH_TOKEN },
        { hookEventName: 'agent_end' },
        { hookEventName: 'agent_end', launchToken: LAUNCH_TOKEN }
      ])
      expect(states(seen)).toEqual(['working', 'done'])
    } finally {
      await server.stop()
    }
  })

  it('reports the unmanaged extension once per pane and source', async () => {
    const server = new AgentHookServer()
    await server.start({ env: 'production' })
    const reports: string[] = []
    server.setUnmanagedStatusExtensionListener((report) => {
      reports.push(`${report.source}:${report.paneKey}`)
    })
    try {
      await runOmpPosts(server, [
        { hookEventName: 'agent_start', launchToken: LAUNCH_TOKEN },
        { hookEventName: 'agent_end' },
        { hookEventName: 'agent_end' }
      ])
      expect(reports).toEqual([`omp:${PANE}`])
    } finally {
      await server.stop()
    }
  })

  it('fails open when no post ever carries a launch token', async () => {
    const server = new AgentHookServer()
    await server.start({ env: 'production' })
    try {
      // Why: a bare shell gets no ORCA_AGENT_LAUNCH_TOKEN, so the managed extension itself posts
      // `launchToken: ''`. Gating that would strand the pane on 'working' with no user recovery.
      const seen = await runOmpPosts(server, [
        { hookEventName: 'agent_start', launchToken: '' },
        { hookEventName: 'agent_end', launchToken: '' }
      ])
      expect(states(seen)).toEqual(['working', 'done'])
    } finally {
      await server.stop()
    }
  })

  it('lets a relaunch with a different token take the pane back', async () => {
    const server = new AgentHookServer()
    await server.start({ env: 'production' })
    try {
      const seen = await runOmpPosts(server, [
        { hookEventName: 'agent_start', launchToken: LAUNCH_TOKEN },
        { hookEventName: 'agent_start', launchToken: 'launch-token-second' },
        { hookEventName: 'agent_end', launchToken: 'launch-token-second' }
      ])
      expect(states(seen)).toEqual(['working', 'working', 'done'])
    } finally {
      await server.stop()
    }
  })

  it('does not gate a different source that shares the pane', async () => {
    const server = new AgentHookServer()
    await server.start({ env: 'production' })
    const seen: StatusEvent[] = []
    server.setListener((payload) => {
      seen.push(payload)
    })
    try {
      const env = server.buildPtyEnv()
      const post = async (pathname: string, body: unknown): Promise<void> => {
        await fetch(`http://127.0.0.1:${env.ORCA_AGENT_HOOK_PORT}${pathname}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Orca-Agent-Hook-Token': env.ORCA_AGENT_HOOK_TOKEN
          },
          body: JSON.stringify(body)
        })
      }
      await post(
        '/hook/omp',
        buildBody({ hook_event_name: 'agent_start' }, { launchToken: LAUNCH_TOKEN })
      )
      await post('/hook/claude', buildBody({ hook_event_name: 'UserPromptSubmit', prompt: 'go' }))
      expect(seen.map((event) => event.source)).toEqual(['omp', 'claude'])
    } finally {
      await server.stop()
    }
  })
})
