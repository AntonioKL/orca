import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { mockPtySpawn, mockPtyInstance, mockCreateShellPromptReadinessProbe } = vi.hoisted(() => ({
  mockPtySpawn: vi.fn(),
  mockCreateShellPromptReadinessProbe: vi.fn(),
  mockPtyInstance: {
    pid: process.pid,
    onData: vi.fn(),
    onExit: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    clear: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn()
  }
}))

vi.mock('node-pty', () => ({
  spawn: mockPtySpawn
}))

vi.mock('../main/pty/posix-pty-process-groups', () => ({
  forceKillPosixPtyProcessGroups: vi.fn((_pid: number, fallback: () => void) => fallback())
}))

vi.mock('../main/shell-prompt-readiness-probe', () => ({
  createShellPromptReadinessProbe: mockCreateShellPromptReadinessProbe
}))

import type { PtyHandler } from './pty-handler'
import * as ptyShellUtils from './pty-shell-utils'
import { beginPtyHandlerTest, endPtyHandlerTest, testPtyId } from './pty-handler-test-harness'
import type { MockDispatcher } from './pty-handler-test-harness'

const PTY_1 = testPtyId(1)
const STALE_PID = 424_242

/** node-pty's native `pty.resize` error when the master fd is already closed. */
function ebadfResize(): never {
  throw new Error('ioctl(2) failed, EBADF')
}

describe('PtyHandler.resize against a stale PTY handle', () => {
  let dispatcher: MockDispatcher
  let handler: PtyHandler
  let originalPlatform: PropertyDescriptor | undefined
  let resize: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    ;({ dispatcher, handler, originalPlatform } = beginPtyHandlerTest({
      mockPtySpawn,
      mockPtyInstance,
      mockCreateShellPromptReadinessProbe
    }))
    resize = vi.fn()
    // A shell that exited without node-pty producing `onExit`: the record is
    // still in the pool and undisposed, but the master fd behind it is closed.
    mockPtySpawn.mockReturnValue({ ...mockPtyInstance, pid: STALE_PID, resize })
    await dispatcher.callRequest('pty.spawn', {})
    expect(handler.activePtyCount).toBe(1)
  })

  afterEach(async () => {
    await endPtyHandlerTest(handler, originalPlatform)
  })

  it('retires an entry whose pid the host proves is gone, instead of issuing the ioctl', () => {
    vi.spyOn(ptyShellUtils, 'isProcessAlive').mockReturnValue(false)
    resize.mockImplementation(ebadfResize)

    expect(() =>
      dispatcher.callNotification('pty.resize', { id: PTY_1, cols: 120, rows: 40 })
    ).not.toThrow()

    expect(resize).not.toHaveBeenCalled()
    // The record must leave the pool: while it stays, the relay keeps
    // advertising a dead shell and `activePtyCount` never reaches zero, so a
    // relay configured with an unlimited grace never reaches its idle exit.
    expect(handler.activePtyCount).toBe(0)
  })

  it('contains an ioctl failure whose process is still live, and keeps the record', () => {
    vi.spyOn(ptyShellUtils, 'isProcessAlive').mockReturnValue(true)
    resize.mockImplementation(ebadfResize)
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true)

    expect(() =>
      dispatcher.callNotification('pty.resize', { id: PTY_1, cols: 120, rows: 40 })
    ).not.toThrow()
    // Repeats must stay contained too — this is the notification the client
    // re-sends on every reconnect and every window resize.
    expect(() =>
      dispatcher.callNotification('pty.resize', { id: PTY_1, cols: 90, rows: 30 })
    ).not.toThrow()

    // Loss of an fd is not evidence the shell exited, so the claim is retained.
    expect(handler.activePtyCount).toBe(1)
    expect(stderr.mock.calls.map(([line]) => String(line)).join('')).toContain(
      'ioctl(2) failed, EBADF'
    )
  })

  it('still resizes a live PTY, with the clamped geometry', () => {
    vi.spyOn(ptyShellUtils, 'isProcessAlive').mockReturnValue(true)

    dispatcher.callNotification('pty.resize', { id: PTY_1, cols: 4_000, rows: 40 })

    expect(resize).toHaveBeenCalledWith(500, 40)
    expect(handler.activePtyCount).toBe(1)
  })
})
