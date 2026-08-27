import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PtyHandler } from './pty-handler'

const daemonMocks = vi.hoisted(() => ({
  dispatcher: null as unknown,
  runtimePtyHandler: null as unknown,
  mockCreateShellPromptReadinessProbe: vi.fn(),
  mockPtySpawn: vi.fn(),
  socketCleanup: vi.fn()
}))

vi.mock('node-pty', () => ({ spawn: daemonMocks.mockPtySpawn }))

vi.mock('../main/shell-prompt-readiness-probe', () => ({
  createShellPromptReadinessProbe: daemonMocks.mockCreateShellPromptReadinessProbe
}))

vi.mock('../main/pty/posix-pty-process-groups', () => ({
  forceKillPosixPtyProcessGroups: vi.fn((_pid: number, fallback: () => void) => fallback())
}))

vi.mock('./relay-diagnostic-log', () => ({ relayLogLine: vi.fn() }))
vi.mock('./relay-handshake', () => ({ readLaunchVersion: vi.fn(() => 'test-version') }))

vi.mock('./relay-primary-channel', () => ({
  RelayPrimaryChannel: class {
    readonly dispatcher = daemonMocks.dispatcher
    readonly isAlive = true
    detachInput(): void {}
    startOutputFailureHandling(): void {}
    startInput(): void {}
    writeSentinel(): void {}
    detachPrimaryClient(): void {}
  }
}))

vi.mock('./relay-runtime-services', async () => {
  const { PtyHandler: ActualPtyHandler } = (await vi.importActual('./pty-handler')) as {
    PtyHandler: new (dispatcher: never) => PtyHandler
  }
  return {
    RelayRuntimeServices: class {
      readonly ptyHandler = new ActualPtyHandler(daemonMocks.dispatcher as never)
      readonly ptyConsumerSessionAdapter = { getDebugSnapshot: vi.fn() }
      readonly ptySourcePublication = { getDebugSnapshot: vi.fn() }
      constructor() {
        daemonMocks.runtimePtyHandler = this.ptyHandler
      }
      async disposeOwnedProcesses(): Promise<void> {}
      disposeHandlers(): void {}
    }
  }
})

vi.mock('./relay-agent-hook-runtime', () => ({
  RelayAgentHookRuntime: class {
    async start(): Promise<void> {}
    publishEndpointFile(): void {}
    stop(): void {}
  }
}))

vi.mock('./relay-socket-ownership', () => ({
  RelaySocketOwnership: class {
    readonly owned = false
    readonly server = null
    cleanup(): void {
      daemonMocks.socketCleanup()
    }
    closeAndCleanup(): void {}
  }
}))

vi.mock('./relay-reconnect-listener', () => ({
  RelayReconnectListener: class {
    readonly clientCount = 0
    readonly hasAcceptedClient = false
    readonly acceptedConnections = 0
    async start(): Promise<void> {}
  }
}))

vi.mock('./relay-grace-lifecycle', () => ({
  RelayGraceLifecycle: class {
    readonly deadlineAt = null
    readonly reason = null
    cancel(): void {}
    start(): void {}
    installProcessLifecycle(): void {}
  }
}))

import { createMockDispatcher } from './pty-handler-test-harness'
import { runRelayDaemon } from './relay-daemon'
import { __setConptyJobNativeForTests } from '../main/windows/windows-pty-job'

describe('relay daemon fatal PTY reap', () => {
  let originalPlatform: PropertyDescriptor | undefined
  let originalUncaughtListeners: Set<NodeJS.UncaughtExceptionListener>
  let originalRejectionListeners: Set<NodeJS.UnhandledRejectionListener>

  beforeEach(() => {
    originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    originalUncaughtListeners = new Set(process.listeners('uncaughtException'))
    originalRejectionListeners = new Set(process.listeners('unhandledRejection'))
    daemonMocks.dispatcher = createMockDispatcher()
    daemonMocks.runtimePtyHandler = null
    daemonMocks.mockPtySpawn.mockReset()
    daemonMocks.mockCreateShellPromptReadinessProbe.mockReset()
    daemonMocks.mockCreateShellPromptReadinessProbe.mockReturnValue({
      notifyOutput: vi.fn(),
      dispose: vi.fn()
    })
    daemonMocks.socketCleanup.mockReset()
  })

  afterEach(async () => {
    for (const listener of process.listeners('uncaughtException')) {
      if (!originalUncaughtListeners.has(listener)) {
        process.removeListener('uncaughtException', listener)
      }
    }
    for (const listener of process.listeners('unhandledRejection')) {
      if (!originalRejectionListeners.has(listener)) {
        process.removeListener('unhandledRejection', listener)
      }
    }
    const handler = daemonMocks.runtimePtyHandler as PtyHandler | null
    await handler?.dispose({ waitForPhysicalExit: false }).catch(() => {})
    __setConptyJobNativeForTests()
    vi.restoreAllMocks()
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform)
    }
  })

  it('synchronously reaps every Windows PTY job before fatal exit', async () => {
    const firstKill = vi.fn(() => {
      throw new Error('ConPTY close failed')
    })
    const secondKill = vi.fn()
    daemonMocks.mockPtySpawn
      .mockReturnValueOnce(createMockPty(11, 101, firstKill))
      .mockReturnValueOnce(createMockPty(22, 202, secondKill))
    const terminateJob = vi.fn((id: number) => id === 22)
    __setConptyJobNativeForTests(() => ({
      terminateJob,
      listJobProcessIds: vi.fn(),
      assignCurrentProcessToJob: vi.fn()
    }))
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)

    await runRelayDaemon(
      {
        graceTimeMs: 0,
        connectMode: false,
        detached: false,
        cliMode: false,
        sockPath: 'relay-test-socket'
      },
      undefined
    )
    const dispatcher = daemonMocks.dispatcher as ReturnType<typeof createMockDispatcher>
    await dispatcher.callRequest('pty.spawn', {})
    await dispatcher.callRequest('pty.spawn', {})
    const fatalListener = process
      .listeners('uncaughtException')
      .find((listener) => !originalUncaughtListeners.has(listener))

    expect(fatalListener).toBeDefined()
    fatalListener!(new Error('relay crashed'), 'uncaughtException')

    expect(terminateJob.mock.calls).toEqual([
      [11, 101],
      [22, 202]
    ])
    expect(firstKill).toHaveBeenCalledOnce()
    expect(firstKill.mock.calls[0]).toEqual([])
    expect(secondKill).not.toHaveBeenCalled()
    expect(daemonMocks.socketCleanup).toHaveBeenCalledOnce()
    expect(exit).toHaveBeenCalledWith(1)
  })
})

function createMockPty(id: number, pid: number, kill: ReturnType<typeof vi.fn>) {
  return {
    _pty: id,
    pid,
    process: 'cmd.exe',
    onData: vi.fn(),
    onExit: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    kill,
    clear: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn()
  }
}
