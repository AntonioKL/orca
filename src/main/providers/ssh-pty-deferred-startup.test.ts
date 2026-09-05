import { expect, it } from 'vitest'
import { SshPtyProvider } from './ssh-pty-provider'
import { createMockMux } from './ssh-pty-provider-mock-multiplexer'

it('rejects deferred startup before asking an unsupported relay to execute', async () => {
  const mux = createMockMux()
  const provider = new SshPtyProvider('connection', mux as never)
  await expect(
    provider.spawn({ cols: 80, rows: 24, command: 'codex', deferredStartupOperationId: 'op' })
  ).rejects.toThrow('does not support deferred')
  expect(mux.request).not.toHaveBeenCalled()
})
