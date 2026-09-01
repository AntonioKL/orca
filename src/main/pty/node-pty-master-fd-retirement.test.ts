import * as pty from 'node-pty'
import { describe, expect, it } from 'vitest'

/**
 * node-pty hands the master fd to libuv, which closes it on EIO/EOF, but upstream
 * never invalidated `_fd`, and neither `resize()` nor the `process` getter consulted
 * anything. Orca's patch retires `_fd` in the same block that gives up the handle
 * (config/patches/node-pty@1.1.0.patch), which is what makes a stale handle
 * unreachable instead of merely unlucky.
 */

const POSIX_SHELL = '/bin/sh'

function spawnPty(command: string, cols = 80, rows = 24): pty.IPty {
  return pty.spawn(POSIX_SHELL, ['-c', command], {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: process.cwd(),
    env: { ...process.env }
  })
}

function masterFd(term: pty.IPty): number {
  return (term as unknown as { fd: number }).fd
}

/** Run `command` to completion and let node-pty finish giving up the master. */
async function retiredPty(command = 'exit 0'): Promise<{ term: pty.IPty; spawnFd: number }> {
  const term = spawnPty(command)
  const spawnFd = masterFd(term)
  await new Promise<void>((resolve) => {
    term.onExit(() => resolve())
  })
  ;(term as unknown as { destroy?: () => void }).destroy?.()
  await new Promise<void>((resolve) => setTimeout(resolve, 400))
  return { term, spawnFd }
}

// Windows never reaches this code: WindowsTerminal.resize goes through the conpty
// agent and reads no fd, so the sentinel is written and never consulted there.
const describeOnPosix = process.platform === 'win32' ? describe.skip : describe

describeOnPosix('node-pty master fd retirement', () => {
  it('invalidates the descriptor once it gives up the handle', async () => {
    const { term, spawnFd } = await retiredPty()

    expect(spawnFd).toBeGreaterThanOrEqual(0)
    expect(masterFd(term)).toBe(-1)
  }, 15000)

  it('answers a resize past retirement without issuing the ioctl', async () => {
    const { term } = await retiredPty()

    // Pre-patch this threw `ioctl(2) failed, EBADF` out of whatever called it.
    expect(() => term.resize(200, 50)).not.toThrow()
    // Geometry stays at the last size actually applied rather than claiming one
    // that no descriptor ever received.
    expect([term.cols, term.rows]).toEqual([80, 24])
  }, 15000)

  it('names the spawn file rather than tcgetpgrp on a retired descriptor', async () => {
    const { term } = await retiredPty()

    expect(term.process).toBe(POSIX_SHELL)
  }, 15000)
})

// Linux frees the master synchronously enough that the very next pty is handed the
// same descriptor number every time, which makes the reuse hazard directly
// observable rather than a race to reproduce.
const describeOnLinux = process.platform === 'linux' ? describe : describe.skip

describeOnLinux('node-pty master fd reuse', () => {
  it('cannot resize a live pty handed the retired descriptor number', async () => {
    const { term: retired, spawnFd } = await retiredPty()

    const live = spawnPty('sleep 1; stty size')
    let output = ''
    live.onData((data) => {
      output += data
    })
    try {
      // The premise of this test: the kernel really did reissue the number. If it
      // stops holding, the assertion below would pass for the wrong reason.
      expect(masterFd(live)).toBe(spawnFd)

      // Pre-patch this reached TIOCSWINSZ on `live`'s master and silently resized
      // a terminal it has no relationship to — no error, nothing for a liveness
      // probe of the retired pid to observe.
      retired.resize(200, 50)

      await new Promise<void>((resolve) => {
        live.onExit(() => resolve())
      })
      expect(output.trim()).toBe('24 80')
    } finally {
      live.kill()
    }
  }, 15000)

  it('does not name a live pty foreground process off the retired descriptor', async () => {
    const { term: retired, spawnFd } = await retiredPty()

    // `exec` replaces the shell, so the foreground pgrp's cmdline is distinct
    // from the file this pty was spawned with.
    const live = spawnPty('exec sleep 5')
    try {
      expect(masterFd(live)).toBe(spawnFd)
      // Let the shell finish exec'ing, or its own cmdline is still the fallback.
      await new Promise<void>((resolve) => setTimeout(resolve, 300))

      // Pre-patch this read tcgetpgrp off `live`'s master and reported `sleep`,
      // attributing an unrelated pane's process to a pty that had already exited.
      expect(retired.process).toBe(POSIX_SHELL)
    } finally {
      live.kill()
    }
  }, 15000)
})
