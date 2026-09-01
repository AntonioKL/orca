import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, posix } from 'node:path'
import { probeAgentIdentityCount } from './ssh-agent-identity-probe'
import { joinRemotePath, type RemoteHostPlatform } from './ssh-remote-platform'

/**
 * The Win32 OpenSSH agent pipe.
 *
 * 1Password serves this exact pipe rather than a private one, so Windows has no
 * separate 1Password endpoint to discover — the incumbent fallback already covers it.
 */
export const WINDOWS_OPENSSH_AGENT_PIPE = '\\\\.\\pipe\\openssh-ssh-agent'

/** macOS publishes the agent inside 1Password's signed group container. */
const MACOS_ONEPASSWORD_SOCKET_SEGMENTS = [
  'Library',
  'Group Containers',
  '2BUA8C4S2C.com.1password',
  't',
  'agent.sock'
]
const POSIX_ONEPASSWORD_SOCKET_SEGMENTS = ['.1password', 'agent.sock']

/** One host's own `$SSH_AUTH_SOCK` reading. */
export type AgentSocketEnv = { SSH_AUTH_SOCK?: string | undefined }

/**
 * The machine whose SSH agent is being discovered.
 *
 * A socket found on one host is never a valid answer for another, so only `native`
 * may read this process's env and filesystem. The other kinds must be handed their
 * own host's `$HOME` and `$SSH_AUTH_SOCK`, and their candidates stay unprobed until
 * something asks that host directly.
 */
export type AgentSocketHost =
  | { kind: 'native' }
  | { kind: 'wsl'; distro: string; guestHome: string; guestEnv: AgentSocketEnv }
  | {
      kind: 'ssh-relay'
      connectionId: string
      platform: RemoteHostPlatform
      remoteHome: string
      remoteEnv: AgentSocketEnv
    }

function onePasswordAgentEndpoint(host: AgentSocketHost): string | undefined {
  switch (host.kind) {
    case 'native':
      if (process.platform === 'win32') {
        return WINDOWS_OPENSSH_AGENT_PIPE
      }
      if (process.platform === 'darwin') {
        return join(homedir(), ...MACOS_ONEPASSWORD_SOCKET_SEGMENTS)
      }
      return process.platform === 'linux'
        ? join(homedir(), ...POSIX_ONEPASSWORD_SOCKET_SEGMENTS)
        : undefined
    case 'wsl':
      // A distro is Linux, and 1Password's Windows pipe is unreachable from inside it
      // without an npiperelay bridge — which the user surfaces via $SSH_AUTH_SOCK.
      return posix.join(host.guestHome, ...POSIX_ONEPASSWORD_SOCKET_SEGMENTS)
    case 'ssh-relay':
      // No named pipe survives the relay, so a Windows host publishes nothing usable.
      return host.platform.os === 'win32'
        ? undefined
        : joinRemotePath(
            host.platform,
            host.remoteHome,
            ...(host.platform.os === 'darwin'
              ? MACOS_ONEPASSWORD_SOCKET_SEGMENTS
              : POSIX_ONEPASSWORD_SOCKET_SEGMENTS)
          )
  }
}

function hostEnv(host: AgentSocketHost): AgentSocketEnv {
  switch (host.kind) {
    case 'native':
      return { SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK }
    case 'wsl':
      return host.guestEnv
    case 'ssh-relay':
      return host.remoteEnv
  }
}

/**
 * Agent socket candidates for `host`, most preferred first.
 *
 * `$SSH_AUTH_SOCK` stays the primary signal; the 1Password endpoint is only a
 * fallback for a host that publishes none. Entries are unverified — probe them on
 * `host` itself, never on the client.
 */
export function listAgentSocketCandidates(host: AgentSocketHost): string[] {
  const candidates = [hostEnv(host).SSH_AUTH_SOCK, onePasswordAgentEndpoint(host)]
  return [...new Set(candidates.filter((candidate) => !!candidate))] as string[]
}

function nativeAgentEndpointExists(endpoint: string): boolean {
  // Why: named pipes are invisible to the filesystem, and this pipe name is the
  // incumbent Windows fallback — probing it could only regress Windows.
  if (process.platform === 'win32') {
    return true
  }
  try {
    return existsSync(endpoint)
  } catch {
    return false
  }
}

/**
 * The socket launchd hands every macOS GUI process. `/tmp` is a symlink to
 * `/private/tmp`, so both spellings name the same listener.
 *
 * Because launchd always sets it, its presence says nothing about whether the user
 * chose it — unlike any other `$SSH_AUTH_SOCK` value, which someone had to write.
 */
const APPLE_LAUNCHD_AGENT_SOCKET = /^\/(?:private\/)?tmp\/com\.apple\.launchd\.[^/]+\/Listeners$/

export function isAppleLaunchdAgentSocket(socketPath: string): boolean {
  return APPLE_LAUNCHD_AGENT_SOCKET.test(socketPath)
}

/**
 * The launchd socket last proven to offer nothing, and the ones that would not say.
 *
 * An agent that answered is re-asked on the next attempt, so an `ssh-add` takes effect
 * immediately. One that timed out is not: retrying it would only re-pay the timeout on
 * every connect, and the incumbent stands either way.
 */
let emptyLaunchdAgentSocket: string | undefined
const unreadableLaunchdAgentSockets = new Set<string>()

/** The 1Password socket worth displacing an unchosen, empty launchd agent for. */
function installedOnePasswordSocketOverLaunchd(envSocket: string | undefined): string | undefined {
  if (process.platform !== 'darwin' || !envSocket || !isAppleLaunchdAgentSocket(envSocket)) {
    return undefined
  }
  const endpoint = onePasswordAgentEndpoint({ kind: 'native' })
  return endpoint && nativeAgentEndpointExists(endpoint) ? endpoint : undefined
}

/**
 * Ask the incumbent macOS agent whether it has anything to offer, before
 * {@link discoverNativeAgentSocket} has to choose.
 *
 * Deliberately not a "first socket with keys wins" sweep: it probes one socket, in the
 * single ambiguous case where the user never picked the incumbent and a 1Password agent
 * is installed beside it. Everywhere else — a populated agent, a socket the user pointed
 * somewhere themselves, no 1Password — nothing is opened and nothing is overridden.
 *
 * Skipping this leaves resolution exactly as it was: `$SSH_AUTH_SOCK` wins.
 */
export async function primeNativeAgentSocketPreference(): Promise<void> {
  emptyLaunchdAgentSocket = undefined
  const envSocket = process.env.SSH_AUTH_SOCK
  if (!envSocket || !installedOnePasswordSocketOverLaunchd(envSocket)) {
    return
  }
  if (unreadableLaunchdAgentSockets.has(envSocket)) {
    return
  }
  const identityCount = await probeAgentIdentityCount(envSocket)
  if (identityCount === undefined) {
    unreadableLaunchdAgentSockets.add(envSocket)
    return
  }
  if (identityCount === 0) {
    emptyLaunchdAgentSocket = envSocket
  }
}

export function resetNativeAgentSocketPreference(): void {
  emptyLaunchdAgentSocket = undefined
  unreadableLaunchdAgentSockets.clear()
}

/**
 * The agent socket on the machine running this process — the only host ssh2 can reach.
 *
 * `$SSH_AUTH_SOCK` is returned as the user set it; the 1Password endpoint is a guess,
 * so it is only returned once proven present rather than handed over as a dead path.
 * The one exception is the macOS agent nobody chose and that has already been proven
 * empty — see {@link primeNativeAgentSocketPreference}.
 */
export function discoverNativeAgentSocket(): string | undefined {
  const envSocket = process.env.SSH_AUTH_SOCK
  if (envSocket) {
    return (
      (emptyLaunchdAgentSocket === envSocket
        ? installedOnePasswordSocketOverLaunchd(envSocket)
        : undefined) ?? envSocket
    )
  }
  const endpoint = onePasswordAgentEndpoint({ kind: 'native' })
  return endpoint && nativeAgentEndpointExists(endpoint) ? endpoint : undefined
}
