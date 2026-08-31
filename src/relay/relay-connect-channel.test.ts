import { describe, expect, it } from 'vitest'
import { relayConnectExitCodeForSocketError } from './relay-connect-channel'
import { EXIT_CODE_SOCKET_REFUSED } from './relay-handshake'

describe('relay connect socket error exit codes', () => {
  it.each(['ECONNREFUSED', 'ENOENT'] as const)('uses the refusal code for %s', (code) => {
    expect(relayConnectExitCodeForSocketError(Object.assign(new Error(code), { code }))).toBe(
      EXIT_CODE_SOCKET_REFUSED
    )
  })

  it.each(['ETIMEDOUT', 'EACCES', 'EPROTO'] as const)(
    'keeps %s on the generic exit path',
    (code) => {
      expect(relayConnectExitCodeForSocketError(Object.assign(new Error(code), { code }))).toBe(1)
    }
  )
})
