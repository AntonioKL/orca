import { describe, expect, it, vi } from 'vitest'
import type { ClaudeStructuredSessionEvent } from './claude-structured-session-adapter'
import { ClaudeTranscriptPreviousCursorMissingError } from './claude-transcript-branch-proof'
import {
  adapterFor,
  fakeClaude,
  identityFor,
  PROVIDER_SESSION_ID,
  tick
} from './claude-structured-session-test-support'

describe('ClaudeStructuredSessionAdapter transcript-derived recovery', () => {
  it('persists only the last transcript-entry uuid before graceful close', async () => {
    const claude = fakeClaude()
    const events: ClaudeStructuredSessionEvent[] = []
    const persistedHandles: unknown[] = []
    const adapter = adapterFor(claude, {}, events, persistedHandles)
    await adapter.acquire({ identity: identityFor(), fence: 7, spawnToken: 'spawn-9' })
    claude.connections[0].handlers.onMessage?.({
      type: 'assistant',
      session_id: PROVIDER_SESSION_ID,
      uuid: 'assistant-leaf'
    })
    claude.connections[0].handlers.onMessage?.({
      type: 'result',
      session_id: PROVIDER_SESSION_ID,
      uuid: 'result-frame-uuid'
    })
    claude.connections[0].handlers.onMessage?.({
      type: 'stream_event',
      session_id: PROVIDER_SESSION_ID,
      uuid: 'stream-event-frame-uuid'
    })

    await adapter.closeSession('session-1')

    expect(persistedHandles).toEqual([
      {
        sessionId: 'session-1',
        providerSessionId: PROVIDER_SESSION_ID,
        leafUuid: 'assistant-leaf',
        fence: 7
      }
    ])
    expect(events.at(-2)).toEqual({
      type: 'handle',
      sessionId: 'session-1',
      providerSessionId: PROVIDER_SESSION_ID,
      leafUuid: 'assistant-leaf',
      fence: 7
    })
    expect(claude.connections[0].closeCount).toBe(1)
  })

  it('prefers a validated durable transcript leaf at graceful close', async () => {
    const claude = fakeClaude()
    const persistedHandles: unknown[] = []
    const readTranscriptLeaf = vi.fn().mockResolvedValue('durable-tail')
    const adapter = adapterFor(claude, {}, [], persistedHandles, undefined, readTranscriptLeaf)
    await adapter.acquire({ identity: identityFor(), fence: 7, spawnToken: 'spawn-9' })
    claude.connections[0].handlers.onMessage?.({
      type: 'assistant',
      session_id: PROVIDER_SESSION_ID,
      uuid: 'observed-tail'
    })

    await adapter.closeSession('session-1')

    expect(readTranscriptLeaf).toHaveBeenCalledWith({
      providerSessionId: PROVIDER_SESSION_ID,
      previousLeafUuid: 'observed-tail',
      claudeConfigDir: '/accounts/claude'
    })
    expect(persistedHandles.at(-1)).toMatchObject({ leafUuid: 'durable-tail' })
  })

  it('passes the pinned Claude account home to transcript validation', async () => {
    const claude = fakeClaude()
    const persistedHandles: unknown[] = []
    const readTranscriptLeaf = vi.fn().mockResolvedValue('durable-tail')
    const adapter = adapterFor(
      claude,
      { claudeConfigDir: '/accounts/selected' },
      [],
      persistedHandles,
      undefined,
      readTranscriptLeaf
    )
    await adapter.acquire({ identity: identityFor(), fence: 7, spawnToken: 'spawn-9' })
    claude.connections[0].handlers.onMessage?.({
      type: 'assistant',
      session_id: PROVIDER_SESSION_ID,
      uuid: 'observed-tail'
    })

    await adapter.closeSession('session-1')

    expect(readTranscriptLeaf).toHaveBeenCalledWith({
      providerSessionId: PROVIDER_SESSION_ID,
      previousLeafUuid: 'observed-tail',
      claudeConfigDir: '/accounts/selected'
    })
  })

  it('re-proves from the transcript root when the observed cursor is missing', async () => {
    const claude = fakeClaude()
    const persistedHandles: unknown[] = []
    const readTranscriptLeaf = vi
      .fn()
      .mockRejectedValueOnce(new ClaudeTranscriptPreviousCursorMissingError())
      .mockResolvedValueOnce('reproved-main-leaf')
    const adapter = adapterFor(claude, {}, [], persistedHandles, undefined, readTranscriptLeaf)
    await adapter.acquire({ identity: identityFor(), fence: 7, spawnToken: 'spawn-9' })
    claude.connections[0].handlers.onMessage?.({
      type: 'assistant',
      session_id: PROVIDER_SESSION_ID,
      uuid: 'observed-tail'
    })

    await adapter.closeSession('session-1')

    expect(readTranscriptLeaf).toHaveBeenNthCalledWith(1, {
      providerSessionId: PROVIDER_SESSION_ID,
      previousLeafUuid: 'observed-tail',
      claudeConfigDir: '/accounts/claude'
    })
    expect(readTranscriptLeaf).toHaveBeenNthCalledWith(2, {
      providerSessionId: PROVIDER_SESSION_ID,
      previousLeafUuid: null,
      claudeConfigDir: '/accounts/claude'
    })
    expect(persistedHandles.at(-1)).toMatchObject({ leafUuid: 'reproved-main-leaf' })
  })

  it('keeps the observed leaf when transcript validation proves a sibling branch', async () => {
    const claude = fakeClaude()
    const persistedHandles: unknown[] = []
    const readTranscriptLeaf = vi
      .fn()
      .mockRejectedValue(new Error('latest marker is on a sibling branch'))
    const adapter = adapterFor(claude, {}, [], persistedHandles, undefined, readTranscriptLeaf)
    await adapter.acquire({ identity: identityFor(), fence: 7, spawnToken: 'spawn-9' })
    claude.connections[0].handlers.onMessage?.({
      type: 'assistant',
      session_id: PROVIDER_SESSION_ID,
      uuid: 'observed-tail'
    })

    await adapter.closeSession('session-1')

    expect(readTranscriptLeaf).toHaveBeenCalledTimes(1)
    expect(persistedHandles.at(-1)).toMatchObject({ leafUuid: 'observed-tail' })
  })

  it('persists the last transcript leaf before an unexpected first-hand exit', async () => {
    const claude = fakeClaude()
    const persistedHandles: unknown[] = []
    const events: ClaudeStructuredSessionEvent[] = []
    const adapter = adapterFor(claude, {}, events, persistedHandles)
    await adapter.acquire({ identity: identityFor(), fence: 7, spawnToken: 'spawn-9' })
    claude.connections[0].handlers.onMessage?.({
      type: 'assistant',
      session_id: PROVIDER_SESSION_ID,
      uuid: 'crash-leaf'
    })

    claude.connections[0].handlers.onExit?.(
      new Error('claude stream-json exited (code 1): crashed unexpectedly')
    )
    await tick()

    expect(persistedHandles).toContainEqual({
      sessionId: 'session-1',
      providerSessionId: PROVIDER_SESSION_ID,
      leafUuid: 'crash-leaf',
      fence: 7
    })
    expect(events.at(-1)).toMatchObject({
      type: 'ended',
      cause: 'unexpected-exit',
      fence: 7,
      acquisitionGeneration: expect.any(String)
    })
  })

  it('derives the crash cursor from the validated transcript tail', async () => {
    const claude = fakeClaude()
    const persistedHandles: unknown[] = []
    const adapter = adapterFor(
      claude,
      {},
      [],
      persistedHandles,
      undefined,
      vi.fn().mockResolvedValue('durable-crash-leaf')
    )
    await adapter.acquire({ identity: identityFor(), fence: 7, spawnToken: 'spawn-9' })
    claude.connections[0].handlers.onMessage?.({
      type: 'assistant',
      session_id: PROVIDER_SESSION_ID,
      uuid: 'stale-observed-tail'
    })
    claude.connections[0].handlers.onExit?.(
      new Error('claude stream-json exited (signal SIGKILL): crashed')
    )
    await tick()

    expect(persistedHandles.at(-1)).toMatchObject({ leafUuid: 'durable-crash-leaf' })
  })

  it('re-proves a first-hand crash cursor from the transcript root after stale validation', async () => {
    const claude = fakeClaude()
    const persistedHandles: unknown[] = []
    const readTranscriptLeaf = vi
      .fn()
      .mockRejectedValueOnce(new ClaudeTranscriptPreviousCursorMissingError())
      .mockResolvedValueOnce('reproved-crash-leaf')
    const adapter = adapterFor(claude, {}, [], persistedHandles, undefined, readTranscriptLeaf)
    await adapter.acquire({ identity: identityFor(), fence: 7, spawnToken: 'spawn-9' })
    claude.connections[0].handlers.onMessage?.({
      type: 'assistant',
      session_id: PROVIDER_SESSION_ID,
      uuid: 'stale-observed-tail'
    })
    claude.connections[0].handlers.onExit?.(new Error('crashed'))
    await tick()

    expect(readTranscriptLeaf).toHaveBeenNthCalledWith(1, {
      providerSessionId: PROVIDER_SESSION_ID,
      previousLeafUuid: 'stale-observed-tail',
      claudeConfigDir: '/accounts/claude'
    })
    expect(readTranscriptLeaf).toHaveBeenNthCalledWith(2, {
      providerSessionId: PROVIDER_SESSION_ID,
      previousLeafUuid: null,
      claudeConfigDir: '/accounts/claude'
    })
    expect(persistedHandles.at(-1)).toMatchObject({ leafUuid: 'reproved-crash-leaf' })
  })

  it('keeps the observed crash leaf when transcript validation proves a sibling branch', async () => {
    const claude = fakeClaude()
    const persistedHandles: unknown[] = []
    const readTranscriptLeaf = vi
      .fn()
      .mockRejectedValue(new Error('latest marker is on a sibling branch'))
    const adapter = adapterFor(claude, {}, [], persistedHandles, undefined, readTranscriptLeaf)
    await adapter.acquire({ identity: identityFor(), fence: 7, spawnToken: 'spawn-9' })
    claude.connections[0].handlers.onMessage?.({
      type: 'assistant',
      session_id: PROVIDER_SESSION_ID,
      uuid: 'observed-crash-tail'
    })
    claude.connections[0].handlers.onExit?.(new Error('crashed'))
    await tick()

    expect(readTranscriptLeaf).toHaveBeenCalledTimes(1)
    expect(persistedHandles.at(-1)).toMatchObject({ leafUuid: 'observed-crash-tail' })
  })

  it('publishes lifecycle recovery even when crash-cursor persistence fails', async () => {
    const claude = fakeClaude()
    const events: ClaudeStructuredSessionEvent[] = []
    const adapter = adapterFor(
      claude,
      {},
      events,
      [],
      undefined,
      undefined,
      vi.fn().mockRejectedValue(new Error('store unavailable'))
    )
    await adapter.acquire({ identity: identityFor(), fence: 7, spawnToken: 'spawn-9' })

    claude.connections[0].handlers.onExit?.(new Error('crashed'))
    await tick()

    expect(events.at(-1)).toMatchObject({ type: 'ended', cause: 'unexpected-exit' })
  })

  it('runs the child close proof before publishing unexpected-exit recovery', async () => {
    const claude = fakeClaude()
    const events: ClaudeStructuredSessionEvent[] = []
    const adapter = adapterFor(claude, {}, events)
    await adapter.acquire({ identity: identityFor(), fence: 7, spawnToken: 'spawn-9' })
    const close = vi.spyOn(claude.connections[0], 'close').mockResolvedValue(true)

    claude.connections[0].handlers.onExit?.(new Error('crashed'))
    await tick()

    expect(close).toHaveBeenCalledOnce()
    expect(events.at(-1)).toMatchObject({ type: 'ended', cause: 'unexpected-exit' })
  })
})
