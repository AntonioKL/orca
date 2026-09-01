import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'

const mockExistsSync = vi.fn<(path: string) => boolean>()

vi.mock('node:fs', () => ({
  existsSync: (path: string) => mockExistsSync(path)
}))

const TEST_HOME = '/home/testuser'
vi.mock('node:os', () => ({
  homedir: () => TEST_HOME
}))

import {
  discoverNativeAgentSocket,
  listAgentSocketCandidates,
  WINDOWS_OPENSSH_AGENT_PIPE
} from './ssh-agent-socket-discovery'
import { getRemoteHostPlatform } from './ssh-remote-platform'

const MACOS_ONEPASSWORD_SOCKET = join(
  TEST_HOME,
  'Library',
  'Group Containers',
  '2BUA8C4S2C.com.1password',
  't',
  'agent.sock'
)
const LINUX_ONEPASSWORD_SOCKET = join(TEST_HOME, '.1password', 'agent.sock')

const originalSshAuthSock = process.env.SSH_AUTH_SOCK

function usePlatform(platform: NodeJS.Platform): void {
  vi.spyOn(process, 'platform', 'get').mockReturnValue(platform)
}

beforeEach(() => {
  mockExistsSync.mockReset()
  mockExistsSync.mockReturnValue(false)
  delete process.env.SSH_AUTH_SOCK
})

afterEach(() => {
  vi.restoreAllMocks()
  if (originalSshAuthSock === undefined) {
    delete process.env.SSH_AUTH_SOCK
  } else {
    process.env.SSH_AUTH_SOCK = originalSshAuthSock
  }
})

describe('discoverNativeAgentSocket', () => {
  it('keeps SSH_AUTH_SOCK as the primary signal even when 1Password is installed', () => {
    usePlatform('darwin')
    mockExistsSync.mockReturnValue(true)
    process.env.SSH_AUTH_SOCK = '/tmp/env-agent.sock'

    expect(discoverNativeAgentSocket()).toBe('/tmp/env-agent.sock')
  })

  it('falls back to the macOS 1Password group-container socket when SSH_AUTH_SOCK is unset', () => {
    usePlatform('darwin')
    mockExistsSync.mockImplementation((path) => path === MACOS_ONEPASSWORD_SOCKET)

    expect(discoverNativeAgentSocket()).toBe(MACOS_ONEPASSWORD_SOCKET)
  })

  it('falls back to the Linux 1Password socket when SSH_AUTH_SOCK is unset', () => {
    usePlatform('linux')
    mockExistsSync.mockImplementation((path) => path === LINUX_ONEPASSWORD_SOCKET)

    expect(discoverNativeAgentSocket()).toBe(LINUX_ONEPASSWORD_SOCKET)
  })

  it('returns nothing rather than a socket path that is not there', () => {
    usePlatform('darwin')

    expect(discoverNativeAgentSocket()).toBeUndefined()
    expect(mockExistsSync).toHaveBeenCalledWith(MACOS_ONEPASSWORD_SOCKET)
  })

  it('uses the Windows OpenSSH pipe, which 1Password serves too', () => {
    usePlatform('win32')

    expect(discoverNativeAgentSocket()).toBe(WINDOWS_OPENSSH_AGENT_PIPE)
    expect(mockExistsSync).not.toHaveBeenCalled()
  })

  it('lists the environment socket ahead of the 1Password one', () => {
    usePlatform('linux')
    process.env.SSH_AUTH_SOCK = '/tmp/env-agent.sock'

    expect(listAgentSocketCandidates({ kind: 'native' })).toEqual([
      '/tmp/env-agent.sock',
      LINUX_ONEPASSWORD_SOCKET
    ])
  })
})

describe('listAgentSocketCandidates host boundary', () => {
  it('never answers for a WSL distro with the Windows host machine sockets', () => {
    usePlatform('win32')
    process.env.SSH_AUTH_SOCK = '/tmp/windows-agent.sock'

    const candidates = listAgentSocketCandidates({
      kind: 'wsl',
      distro: 'Ubuntu',
      guestHome: '/home/dev',
      guestEnv: {}
    })

    expect(candidates).toEqual(['/home/dev/.1password/agent.sock'])
    expect(candidates).not.toContain(WINDOWS_OPENSSH_AGENT_PIPE)
    expect(candidates).not.toContain('/tmp/windows-agent.sock')
  })

  it("prefers the distro's own SSH_AUTH_SOCK, where an npiperelay bridge lands", () => {
    usePlatform('win32')

    expect(
      listAgentSocketCandidates({
        kind: 'wsl',
        distro: 'Ubuntu',
        guestHome: '/home/dev',
        guestEnv: { SSH_AUTH_SOCK: '/home/dev/.ssh/agent.sock' }
      })
    ).toEqual(['/home/dev/.ssh/agent.sock', '/home/dev/.1password/agent.sock'])
  })

  it('never answers for a relay host with the client machine socket', () => {
    usePlatform('darwin')
    process.env.SSH_AUTH_SOCK = '/tmp/client-agent.sock'

    const candidates = listAgentSocketCandidates({
      kind: 'ssh-relay',
      connectionId: 'target-1',
      platform: getRemoteHostPlatform('linux-x64'),
      remoteHome: '/home/deploy',
      remoteEnv: {}
    })

    expect(candidates).toEqual(['/home/deploy/.1password/agent.sock'])
    expect(candidates).not.toContain('/tmp/client-agent.sock')
    expect(candidates).not.toContain(MACOS_ONEPASSWORD_SOCKET)
  })

  it('uses the remote group-container path for a macOS relay host, with remote separators', () => {
    usePlatform('win32')

    expect(
      listAgentSocketCandidates({
        kind: 'ssh-relay',
        connectionId: 'target-1',
        platform: getRemoteHostPlatform('darwin-arm64'),
        remoteHome: '/Users/deploy',
        remoteEnv: {}
      })
    ).toEqual(['/Users/deploy/Library/Group Containers/2BUA8C4S2C.com.1password/t/agent.sock'])
  })

  it('offers no 1Password candidate for a Windows relay host the relay cannot pipe to', () => {
    usePlatform('darwin')

    expect(
      listAgentSocketCandidates({
        kind: 'ssh-relay',
        connectionId: 'target-1',
        platform: getRemoteHostPlatform('win32-x64'),
        remoteHome: 'C:/Users/deploy',
        remoteEnv: {}
      })
    ).toEqual([])
  })
})
