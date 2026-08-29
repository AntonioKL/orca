import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentHookServer, _internals } from './server'
import { makePaneKey } from '../../shared/stable-pane-id'
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

async function postOmp(server: AgentHookServer, posts: Post[]): Promise<void> {
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
}

// Why it returns the live array: it keeps filling after the awaited posts, which is exactly
// where a released hold has to show up. Installs the listener, so call it once per server.
async function runOmpPosts(server: AgentHookServer, posts: Post[]): Promise<StatusEvent[]> {
  const seen: StatusEvent[] = []
  server.setListener((payload) => {
    seen.push(payload)
  })
  await postOmp(server, posts)
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
    // Why a tokened post has to follow: a tokenless post on its own is only evidence that the
    // token is missing. It becomes evidence of a *second* poster when the managed copy speaks
    // over it on the same pane and source — one process cannot both send and omit the token.
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
        { hookEventName: 'agent_end', launchToken: LAUNCH_TOKEN },
        { hookEventName: 'agent_end' },
        { hookEventName: 'agent_end', launchToken: LAUNCH_TOKEN }
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

  it('delivers a held tokenless post once the tokened poster goes silent', async () => {
    // Why this is the whole exit: "a tokened post was seen" proves a managed poster existed, not
    // that one is live. Without a lapse the pane would claim work forever with no user recovery.
    const server = new AgentHookServer()
    await server.start({ env: 'production' })
    server._setUnmanagedExtensionConfirmationWindowMsForTests(40)
    try {
      const seen = await runOmpPosts(server, [
        { hookEventName: 'agent_start', launchToken: LAUNCH_TOKEN },
        { hookEventName: 'agent_end' }
      ])
      expect(states(seen)).toEqual(['working'])
      await vi.waitFor(() => {
        expect(states(seen)).toEqual(['working', 'done'])
      })
    } finally {
      await server.stop()
    }
  })

  it('keeps holding while the tokened poster keeps posting', async () => {
    // Why: the lapse must not become a back door. As long as the managed copy is live, every
    // stale post is superseded, so the pane never settles early.
    const server = new AgentHookServer()
    await server.start({ env: 'production' })
    server._setUnmanagedExtensionConfirmationWindowMsForTests(40)
    try {
      const seen = await runOmpPosts(server, [
        { hookEventName: 'agent_start', launchToken: LAUNCH_TOKEN },
        { hookEventName: 'agent_end' },
        { hookEventName: 'tool_call', launchToken: LAUNCH_TOKEN }
      ])
      await new Promise((resolve) => setTimeout(resolve, 120))
      expect(states(seen)).toEqual(['working', 'working'])
    } finally {
      await server.stop()
    }
  })

  it('does not report Orca’s own tokenless relaunch as a foreign extension', async () => {
    // Why: Orca’s detached Codex account-switch restart respawns into the same pane key. Until it
    // carried a launch token its posts were tokenless, and warning a user about “an extension Orca
    // did not install” for something Orca launched is unactionable. Two posters are only proven
    // when a tokened post interleaves with a held tokenless one — a relaunch never does.
    const server = new AgentHookServer()
    await server.start({ env: 'production' })
    server._setUnmanagedExtensionConfirmationWindowMsForTests(40)
    const reports: string[] = []
    server.setUnmanagedStatusExtensionListener((report) => {
      reports.push(`${report.source}:${report.paneKey}`)
    })
    try {
      await runOmpPosts(server, [
        { hookEventName: 'agent_start', launchToken: LAUNCH_TOKEN },
        { hookEventName: 'agent_start' },
        { hookEventName: 'agent_end' }
      ])
      expect(reports).toEqual([])
    } finally {
      await server.stop()
    }
  })

  it('reports per pane and source, which is what the renderer dedupe collapses to one toast', async () => {
    // Why pin the fan-out shape: the one-shot property lives in the renderer's per-source
    // dedupe, not here. This side must stay per-pane-and-source, or that dedupe is being fed
    // something it was never sized for.
    const server = new AgentHookServer()
    await server.start({ env: 'production' })
    const reports: string[] = []
    server.setUnmanagedStatusExtensionListener((report) => {
      reports.push(`${report.source}:${report.paneKey}`)
    })
    const env = server.buildPtyEnv()
    const paneKeys = Array.from({ length: 13 }, (_, index) =>
      makePaneKey(
        `tab-${index}`,
        `${index.toString(16).padStart(8, '0')}-1111-4111-8111-111111111111`
      )
    )
    const post = async (paneKey: string, hookEventName: string, launchToken?: string) => {
      await fetch(`http://127.0.0.1:${env.ORCA_AGENT_HOOK_PORT}/hook/omp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Orca-Agent-Hook-Token': env.ORCA_AGENT_HOOK_TOKEN
        },
        body: JSON.stringify(
          buildBody(
            { hook_event_name: hookEventName },
            {
              paneKey,
              tabId: paneKey.split(':')[0],
              ...(launchToken === undefined ? {} : { launchToken })
            }
          )
        )
      })
    }
    try {
      for (const paneKey of paneKeys) {
        await post(paneKey, 'agent_start', LAUNCH_TOKEN)
        await post(paneKey, 'agent_end')
        await post(paneKey, 'agent_end', LAUNCH_TOKEN)
      }
      expect(reports).toEqual(paneKeys.map((paneKey) => `omp:${paneKey}`))
    } finally {
      await server.stop()
    }
  })

  it('drops a held post when the pane is retired, so a reused key cannot settle on it', async () => {
    // Why the revive matters: retirement alone hides the released post behind the retired-pane
    // gate. A pane key reused by a tokenless launch re-opens that gate, and a hold surviving
    // teardown would then settle the *new* turn with the old turn's completion.
    const server = new AgentHookServer()
    await server.start({ env: 'production' })
    server._setUnmanagedExtensionConfirmationWindowMsForTests(40)
    try {
      const seen = await runOmpPosts(server, [
        { hookEventName: 'agent_start', launchToken: LAUNCH_TOKEN },
        { hookEventName: 'agent_end' }
      ])
      server.retirePaneAuthority(PANE)
      // Why before_agent_start: that is omp's new-turn boundary, the one event that re-opens a
      // retired pane. Anything else stays suppressed and would hide the held post either way.
      await postOmp(server, [{ hookEventName: 'before_agent_start' }])
      await new Promise((resolve) => setTimeout(resolve, 120))
      expect(states(seen)).toEqual(['working', 'working'])
    } finally {
      await server.stop()
    }
  })
})
