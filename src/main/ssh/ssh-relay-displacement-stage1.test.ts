import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getAppPath: () => '/mock/app' }
}))

vi.mock('fs', () => ({
  existsSync: vi.fn().mockReturnValue(true),
  readFileSync: vi.fn().mockReturnValue('0.1.0+abcdef012345')
}))

vi.mock('./relay-protocol', () => ({
  RELAY_VERSION: '0.1.0',
  RELAY_REMOTE_DIR: '.orca-remote',
  parseUnameToRelayPlatform: vi.fn().mockReturnValue('linux-x64'),
  RELAY_SENTINEL: 'ORCA-RELAY v0.1.0 READY\n',
  RELAY_SENTINEL_TIMEOUT_MS: 10_000
}))

vi.mock('./ssh-relay-deploy-helpers', () => ({
  uploadDirectory: vi.fn().mockResolvedValue(undefined),
  waitForSentinel: vi.fn(),
  isUnconfirmedSshCommandTermination: (error: unknown) =>
    error instanceof Error &&
    (error as Error & { sshChannelCloseConfirmed?: boolean }).sshChannelCloseConfirmed === false,
  execCommand: vi.fn()
}))

vi.mock('./ssh-remote-node-resolution', () => ({
  resolveRemoteNodePath: vi.fn().mockResolvedValue('/usr/bin/node')
}))

vi.mock('./ssh-relay-endpoint-credential', () => ({
  writeRelayEndpointCredential: vi.fn().mockResolvedValue(undefined)
}))

vi.mock('./ssh-relay-versioned-install', () => ({
  readLocalFullVersion: vi.fn().mockReturnValue('0.1.0+abcdef012345'),
  computeRemoteRelayDir: (home: string, version: string) => `${home}/.orca-remote/relay-${version}`,
  isRelayAlreadyInstalled: vi.fn().mockResolvedValue(true),
  finalizeInstall: vi.fn().mockResolvedValue(undefined),
  abandonInstall: vi.fn().mockResolvedValue(undefined),
  gcOldRelayVersions: vi.fn().mockResolvedValue(undefined)
}))

vi.mock('./ssh-relay-install-lock', () => ({
  acquireInstallLock: vi.fn().mockResolvedValue(undefined),
  RELAY_INSTALL_LOCK_NAME: '.install-lock'
}))

vi.mock('./ssh-relay-repair-lock', () => ({
  tryAcquireRelayRepairLock: vi.fn().mockResolvedValue('acquired')
}))

vi.mock('./ssh-connection-utils', () => ({
  shellEscape: (value: string) => `'${value}'`,
  createSshOperationAbortError: () =>
    Object.assign(new Error('SSH operation was cancelled'), { name: 'AbortError' })
}))

import { deployAndLaunchRelay } from './ssh-relay-deploy'
import { execCommand, waitForSentinel } from './ssh-relay-deploy-helpers'
import type { SshConnection } from './ssh-connection'
import { RelaySocketRefusedError } from './ssh-relay-socket-refused-error'
import { RelayVersionMismatchError } from './ssh-relay-version-mismatch-error'

function makeMockConnection(): SshConnection {
  return {
    canRunConcurrentExecCommands: vi.fn().mockReturnValue(true),
    exec: vi.fn().mockResolvedValue({
      on: vi.fn(),
      stderr: { on: vi.fn() },
      stdin: {},
      stdout: { on: vi.fn() },
      close: vi.fn()
    }),
    writeFile: vi.fn().mockResolvedValue(undefined),
    sftp: vi.fn().mockResolvedValue({
      mkdir: vi.fn((_path: string, callback: (error: Error | null) => void) => callback(null)),
      createWriteStream: vi.fn().mockReturnValue({ on: vi.fn(), end: vi.fn() }),
      end: vi.fn()
    })
  } as unknown as SshConnection
}

function queueExistingSocket(): void {
  vi.mocked(execCommand)
    .mockResolvedValueOnce('__ORCA_REMOTE_PLATFORM__ Linux x86_64')
    .mockResolvedValueOnce('/home/user')
    .mockResolvedValueOnce('ORCA-NATIVE-DEPS-OK')
    .mockResolvedValueOnce('') // launch namespace marker
    .mockResolvedValueOnce('ALIVE')
}

describe('Stage 1 relay displacement', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(execCommand).mockReset().mockResolvedValue('')
    vi.mocked(waitForSentinel).mockReset().mockResolvedValue({
      write: vi.fn(),
      onData: vi.fn(),
      onClose: vi.fn()
    })
  })

  it('does not launch fresh after an inconclusive reconnect failure', async () => {
    const conn = makeMockConnection()
    const reconnectError = new Error('stale relay reconnect failed')
    vi.mocked(waitForSentinel).mockRejectedValueOnce(reconnectError)
    queueExistingSocket()

    await expect(deployAndLaunchRelay(conn)).rejects.toBe(reconnectError)
    expect(
      vi.mocked(conn.exec).mock.calls.some(([command]) => command.includes('--detached'))
    ).toBe(false)
    expect(vi.mocked(execCommand).mock.calls.some(([, command]) => command.includes('rm -f'))).toBe(
      false
    )
  })

  it('does not launch fresh after an unconfirmed initial socket probe', async () => {
    const conn = makeMockConnection()
    const unconfirmedProbe = Object.assign(new Error('socket probe still running'), {
      sshChannelCloseConfirmed: false
    })
    vi.mocked(execCommand)
      .mockResolvedValueOnce('__ORCA_REMOTE_PLATFORM__ Linux x86_64')
      .mockResolvedValueOnce('/home/user')
      .mockResolvedValueOnce('ORCA-NATIVE-DEPS-OK')
      .mockResolvedValueOnce('')
      .mockRejectedValueOnce(unconfirmedProbe)

    await expect(deployAndLaunchRelay(conn)).rejects.toBe(unconfirmedProbe)
    expect(
      vi.mocked(conn.exec).mock.calls.some(([command]) => command.includes('--detached'))
    ).toBe(false)
  })

  it('allows a typed socket refusal to reach fresh launch without client-side unlink', async () => {
    const conn = makeMockConnection()
    vi.mocked(waitForSentinel).mockRejectedValueOnce(new RelaySocketRefusedError())
    queueExistingSocket()
    vi.mocked(execCommand).mockResolvedValueOnce('READY')

    await expect(deployAndLaunchRelay(conn)).resolves.toMatchObject({ nodePath: '/usr/bin/node' })
    expect(vi.mocked(execCommand).mock.calls.some(([, command]) => command.includes('rm -f'))).toBe(
      false
    )
    expect(
      vi.mocked(conn.exec).mock.calls.some(([command]) => command.includes('--detached'))
    ).toBe(true)
  })

  it.each([
    ['timeout', new Error('Relay failed to start within 10s.')],
    ['missing sentinel', new Error('Relay process exited before ready.')]
  ])('does not unlink or launch fresh on reconnect %s', async (_label, reconnectError) => {
    const conn = makeMockConnection()
    vi.mocked(waitForSentinel).mockRejectedValueOnce(reconnectError)
    queueExistingSocket()

    await expect(deployAndLaunchRelay(conn)).rejects.toBe(reconnectError)
    expect(vi.mocked(execCommand).mock.calls.some(([, command]) => command.includes('rm -f'))).toBe(
      false
    )
    expect(
      vi.mocked(conn.exec).mock.calls.some(([command]) => command.includes('--detached'))
    ).toBe(false)
  })

  it('treats exit 42 as proof of life and never unlinks or launches fresh', async () => {
    const conn = makeMockConnection()
    const mismatchError = new RelayVersionMismatchError('0.1.0+local', '0.1.0+remote')
    vi.mocked(waitForSentinel).mockRejectedValueOnce(mismatchError)
    queueExistingSocket()

    await expect(deployAndLaunchRelay(conn)).rejects.toBe(mismatchError)
    expect(vi.mocked(execCommand).mock.calls.some(([, command]) => command.includes('rm -f'))).toBe(
      false
    )
    expect(
      vi.mocked(conn.exec).mock.calls.some(([command]) => command.includes('--detached'))
    ).toBe(false)
  })
})
