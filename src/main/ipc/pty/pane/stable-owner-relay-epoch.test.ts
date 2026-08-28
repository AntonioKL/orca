import { describe, expect, it, vi } from 'vitest'
import type { IPtyProvider, PtySpawnOptions, PtySpawnResult } from '../../../providers/types'
import { toAppSshPtyId } from '../../../providers/ssh-pty-id'
import { spawnForStablePane, type StablePaneOwner } from './stable-owner'

type EpochAwareSpawnOptions = PtySpawnOptions & { resumeProviderSession?: unknown }
type EpochAwareSpawnResult = PtySpawnResult & { agentResumeUnavailable?: true }

const owner = (relayPtyId: string): StablePaneOwner => ({
  tabId: 'tab-epoch-gate',
  leafId: '11111111-1111-4111-8111-111111111111',
  ptyId: toAppSshPtyId('remote', relayPtyId)
})

const agentSpawnOptions = (): EpochAwareSpawnOptions => ({
  cols: 100,
  rows: 30,
  cwd: '/workspace',
  env: { KEEP: 'yes', ORCA_AGENT_LAUNCH_TOKEN: 'launch-token' },
  envToDelete: ['DELETE_ME'],
  command: 'codex resume session',
  commandDelivery: 'provider',
  startupCommandDelivery: 'shell-ready',
  launchAgent: 'codex',
  resumeProviderSession: { key: 'session_id', id: 'session' },
  startupIngress: { colors: { foreground: '#ffffff' }, deadlineMs: 5_000 },
  agentSessionEnsure: {} as never,
  agentSessionCreateOperationId: 'create-operation'
})

function createProvider(status: unknown | Error) {
  const spawns: EpochAwareSpawnOptions[] = []
  const requestHostRpc = vi.fn(async () => {
    if (status instanceof Error) {
      throw status
    }
    return status
  })
  const provider = {
    requestHostRpc,
    spawn: vi.fn(async (options: EpochAwareSpawnOptions) => {
      spawns.push(options)
      if (options.attachOnly) {
        throw new Error(`PTY "${options.sessionId}" not found`)
      }
      return { id: toAppSshPtyId('remote', 'pty2:current:2') }
    })
  } as unknown as IPtyProvider
  return { provider, requestHostRpc, spawns }
}

async function runSpawn(
  relayPtyId: string,
  status: unknown | Error,
  spawnOptions: EpochAwareSpawnOptions = agentSpawnOptions()
) {
  const harness = createProvider(status)
  let freshResult: EpochAwareSpawnResult | undefined
  const spawned = await spawnForStablePane({
    runtime: undefined,
    provider: harness.provider,
    spawnOptions,
    owner: owner(relayPtyId),
    connectionId: 'remote',
    onFreshSpawn: (result) => {
      freshResult = result as EpochAwareSpawnResult
    }
  })
  return {
    ...harness,
    freshOptions: harness.spawns[1],
    result: spawned.result as EpochAwareSpawnResult,
    freshResult
  }
}

describe('spawnForStablePane relay epoch gate', () => {
  it('declines an agent resume owned by a different relay epoch', async () => {
    const { freshOptions, result, freshResult, requestHostRpc } = await runSpawn(
      'pty2:previous:1',
      { ptyIdMintEpoch: 'current' }
    )

    expect(requestHostRpc).toHaveBeenCalledWith(
      'relay.status',
      {},
      expect.objectContaining({ timeoutMs: expect.any(Number) })
    )
    expect(freshOptions).toMatchObject({
      cols: 100,
      rows: 30,
      cwd: '/workspace',
      env: { KEEP: 'yes' },
      envToDelete: expect.arrayContaining(['DELETE_ME', 'ORCA_AGENT_LAUNCH_TOKEN'])
    })
    expect(freshOptions).not.toHaveProperty('launchAgent')
    expect(freshOptions).not.toHaveProperty('command')
    expect(freshOptions).not.toHaveProperty('commandDelivery')
    expect(freshOptions).not.toHaveProperty('startupCommandDelivery')
    expect(freshOptions).not.toHaveProperty('resumeProviderSession')
    expect(freshOptions).not.toHaveProperty('startupIngress')
    expect(freshOptions).not.toHaveProperty('agentSessionEnsure')
    expect(freshOptions).not.toHaveProperty('agentSessionCreateOperationId')
    expect(result.agentResumeUnavailable).toBe(true)
    expect(freshResult?.agentResumeUnavailable).toBe(true)
  })

  it('preserves an agent resume owned by the current relay epoch', async () => {
    const spawnOptions = agentSpawnOptions()
    const { freshOptions, result } = await runSpawn('pty2:current:1', {
      ptyIdMintEpoch: 'current'
    })

    expect(freshOptions).toEqual(spawnOptions)
    expect(result.agentResumeUnavailable).toBeUndefined()
  })

  it.each([
    ['legacy owner id', 'pty-1', { ptyIdMintEpoch: 'current' }],
    ['unknown relay epoch', 'pty2:previous:1', {}],
    ['relay status failure', 'pty2:previous:1', new Error('relay unavailable')]
  ])('preserves current behavior for %s', async (_label, relayPtyId, status) => {
    const spawnOptions = agentSpawnOptions()
    const { freshOptions, result } = await runSpawn(relayPtyId, status)

    expect(freshOptions).toEqual(spawnOptions)
    expect(result.agentResumeUnavailable).toBeUndefined()
  })

  it('decodes the epoch embedded in an app-facing SSH PTY id', async () => {
    const spawnOptions = agentSpawnOptions()
    const { freshOptions } = await runSpawn('pty2:relay%3Aepoch:1', {
      ptyIdMintEpoch: 'relay:epoch'
    })

    expect(freshOptions).toEqual(spawnOptions)
  })

  it('reads relay status only once per provider connection generation', async () => {
    const harness = createProvider({ ptyIdMintEpoch: 'current' })
    const spawn = () =>
      spawnForStablePane({
        runtime: undefined,
        provider: harness.provider,
        spawnOptions: agentSpawnOptions(),
        owner: owner('pty2:current:1'),
        connectionId: 'remote'
      })

    await Promise.all([spawn(), spawn()])
    expect(harness.requestHostRpc).toHaveBeenCalledOnce()
  })

  it('does not label a plain replacement shell as an unavailable agent resume', async () => {
    const { freshOptions, result } = await runSpawn(
      'pty2:previous:1',
      { ptyIdMintEpoch: 'current' },
      { cols: 80, rows: 24 }
    )

    expect(freshOptions).toEqual({ cols: 80, rows: 24 })
    expect(result.agentResumeUnavailable).toBeUndefined()
  })
})
