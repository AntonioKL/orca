import type { IPtyProvider, PtySpawnOptions } from '../../../providers/types'
import { parseAppSshPtyId } from '../../../providers/ssh-pty-id'
import { registerPaneKeyTeardownListener } from './key-state'

const RELAY_STATUS_TIMEOUT_MS = 2_000
const MAX_RETIRED_RELAY_OWNERS = 1_024
const relayMintEpochByProvider = new WeakMap<IPtyProvider, Promise<string | undefined>>()
const retiredRelayOwnerByPane = new Map<string, string>()
const retiredRelayOwnerKeysByPane = new Map<string, Set<string>>()

function forgetRetiredRelayOwnerKey(key: string, paneKey: string): void {
  retiredRelayOwnerByPane.delete(key)
  const keys = retiredRelayOwnerKeysByPane.get(paneKey)
  keys?.delete(key)
  if (keys?.size === 0) {
    retiredRelayOwnerKeysByPane.delete(paneKey)
  }
}

export function clearRetiredRelayEpochOwnersForPane(paneKey: string): void {
  const keys = retiredRelayOwnerKeysByPane.get(paneKey)
  if (!keys) {
    return
  }
  for (const key of keys) {
    retiredRelayOwnerByPane.delete(key)
  }
  retiredRelayOwnerKeysByPane.delete(paneKey)
}

// Retired owners are only useful while their pane remains alive; drop them when teardown closes it.
registerPaneKeyTeardownListener(clearRetiredRelayEpochOwnersForPane)

function retiredRelayOwnerKey(connectionId: string, paneKey: string): string {
  return `${connectionId}\0${paneKey}`
}

function parseRelayPtyMintEpoch(relayPtyId: string): string | undefined {
  const match = /^pty2:([^:]+):(\d+)$/.exec(relayPtyId)
  if (!match || !Number.isSafeInteger(Number(match[2]))) {
    return undefined
  }
  try {
    const epoch = decodeURIComponent(match[1])
    return epoch.length > 0 ? epoch : undefined
  } catch {
    return undefined
  }
}

function readRelayMintEpoch(provider: IPtyProvider): Promise<string | undefined> {
  const cached = relayMintEpochByProvider.get(provider)
  if (cached) {
    return cached
  }
  const read = provider
    .requestHostRpc?.('relay.status', {}, { timeoutMs: RELAY_STATUS_TIMEOUT_MS })
    .then((status) => {
      if (!status || typeof status !== 'object') {
        return undefined
      }
      const epoch = (status as { ptyIdMintEpoch?: unknown }).ptyIdMintEpoch
      return typeof epoch === 'string' && epoch.length > 0 ? epoch : undefined
    })
    .catch(() => undefined)
  const result = read ?? Promise.resolve(undefined)
  relayMintEpochByProvider.set(provider, result)
  return result
}

export function rememberRetiredRelayEpochOwner(args: {
  connectionId: string
  paneKey: string | undefined
  ownerPtyId: string
}): void {
  if (!args.paneKey) {
    return
  }
  const parsed = parseAppSshPtyId(args.ownerPtyId)
  if (parsed?.connectionId !== args.connectionId || !parseRelayPtyMintEpoch(parsed.relayPtyId)) {
    return
  }
  const key = retiredRelayOwnerKey(args.connectionId, args.paneKey)
  retiredRelayOwnerByPane.set(key, args.ownerPtyId)
  let keys = retiredRelayOwnerKeysByPane.get(args.paneKey)
  if (!keys) {
    keys = new Set()
    retiredRelayOwnerKeysByPane.set(args.paneKey, keys)
  }
  keys.add(key)
  while (retiredRelayOwnerByPane.size > MAX_RETIRED_RELAY_OWNERS) {
    const oldestKey = retiredRelayOwnerByPane.keys().next().value as string | undefined
    if (!oldestKey) {
      break
    }
    const separator = oldestKey.indexOf('\0')
    const oldestPaneKey = separator === -1 ? undefined : oldestKey.slice(separator + 1)
    if (oldestPaneKey) {
      forgetRetiredRelayOwnerKey(oldestKey, oldestPaneKey)
    } else {
      retiredRelayOwnerByPane.delete(oldestKey)
    }
  }
}

export function takeRetiredRelayEpochOwner(
  connectionId: string | null | undefined,
  paneKey: string | null | undefined
): string | undefined {
  if (!connectionId || !paneKey) {
    return undefined
  }
  const key = retiredRelayOwnerKey(connectionId, paneKey)
  const ownerPtyId = retiredRelayOwnerByPane.get(key)
  forgetRetiredRelayOwnerKey(key, paneKey)
  return ownerPtyId
}

export async function compareStablePaneRelayEpoch(args: {
  provider: IPtyProvider
  ownerPtyId: string
  connectionId: string | null | undefined
}): Promise<'same' | 'different' | 'unknown'> {
  if (!args.connectionId) {
    return 'unknown'
  }
  const relayPtyId = parseAppSshPtyId(args.ownerPtyId)?.relayPtyId
  const ownerEpoch = relayPtyId ? parseRelayPtyMintEpoch(relayPtyId) : undefined
  if (!ownerEpoch || !args.provider.requestHostRpc) {
    return 'unknown'
  }
  const currentEpoch = await readRelayMintEpoch(args.provider)
  if (!currentEpoch) {
    return 'unknown'
  }
  return currentEpoch === ownerEpoch ? 'same' : 'different'
}

function stripAgentResumeOptions(options: PtySpawnOptions): PtySpawnOptions {
  const stripped = { ...options }
  delete stripped.launchAgent
  delete stripped.command
  delete stripped.commandDelivery
  delete stripped.startupCommandDelivery
  delete stripped.resumeProviderSession
  delete stripped.startupIngress
  delete stripped.agentSessionEnsure
  delete stripped.agentSessionCreateOperationId
  if (stripped.env) {
    stripped.env = { ...stripped.env }
    delete stripped.env.ORCA_AGENT_LAUNCH_TOKEN
  }
  stripped.envToDelete = [...new Set([...(stripped.envToDelete ?? []), 'ORCA_AGENT_LAUNCH_TOKEN'])]
  return stripped
}

export async function deriveStablePaneFreshSpawnOptions(args: {
  provider: IPtyProvider
  ownerPtyId: string | undefined
  connectionId: string | null | undefined
  spawnOptions: PtySpawnOptions
}): Promise<{ options: PtySpawnOptions; agentResumeDeclined: boolean }> {
  const verdict = args.ownerPtyId
    ? await compareStablePaneRelayEpoch({
        provider: args.provider,
        ownerPtyId: args.ownerPtyId,
        connectionId: args.connectionId
      })
    : 'unknown'
  const hasAgentResumeIntent = Boolean(
    args.spawnOptions.launchAgent ||
    args.spawnOptions.resumeProviderSession ||
    args.spawnOptions.agentSessionEnsure
  )
  // Compatibility: legacy pty-N ids, old relays, RPC failure/timeout, and non-SSH panes are no
  // verdict and resume as today. We grandfather them because ordinary absence means the same
  // relay lost its PTY; residual risk requires a legacy id, relay replacement, and surviving orphan.
  const agentResumeDeclined = verdict === 'different' && hasAgentResumeIntent
  return {
    options: agentResumeDeclined ? stripAgentResumeOptions(args.spawnOptions) : args.spawnOptions,
    agentResumeDeclined
  }
}
