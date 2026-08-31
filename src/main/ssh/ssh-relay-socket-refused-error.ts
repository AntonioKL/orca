// Why: the relay bridge uses a dedicated code so the client can distinguish a refused
// endpoint from a timeout or protocol failure without parsing remote stderr.
export const RELAY_EXIT_CODE_SOCKET_REFUSED = 43

export class RelaySocketRefusedError extends Error {
  readonly name = 'RelaySocketRefusedError'

  constructor() {
    super('Remote relay socket refused the connection')
  }
}

export function isRelaySocketRefusedError(err: unknown): err is RelaySocketRefusedError {
  return err instanceof RelaySocketRefusedError
}
