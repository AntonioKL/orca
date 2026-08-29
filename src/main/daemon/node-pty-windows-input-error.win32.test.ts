import type { Socket } from 'node:net'
import { spawn, type IPty } from 'node-pty'
import { describe, expect, it } from 'vitest'

type WindowsPtyInternals = IPty & {
  _agent: { inSocket: Socket }
}

describe.skipIf(process.platform !== 'win32')('node-pty Windows input errors', () => {
  it('retires only the failed PTY when its ConPTY input pipe emits EAGAIN', async () => {
    const terminal = spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/q'], {
      cwd: process.cwd(),
      env: process.env
    })
    const input = (terminal as WindowsPtyInternals)._agent.inSocket
    const exited = new Promise<void>((resolve) => terminal.onExit(() => resolve()))

    try {
      expect(input.listenerCount('error')).toBeGreaterThan(0)
      expect(() =>
        input.emit('error', Object.assign(new Error('write EAGAIN'), { code: 'EAGAIN' }))
      ).not.toThrow()
      await exited
    } finally {
      try {
        terminal.kill()
      } catch {}
    }
  })
})
