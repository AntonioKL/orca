import { decodeTerminalStreamFrame, type TerminalStreamFrame } from './terminal-stream-protocol'

type MultiplexStream = {
  method: string
  cancelled?: boolean
  onTerminalBinaryFrame?: (frame: TerminalStreamFrame) => boolean
}

export function routeTerminalMultiplexFrame(
  bytes: Uint8Array,
  streams: Iterable<MultiplexStream>
): boolean {
  const frame = decodeTerminalStreamFrame(bytes)
  if (!frame) {
    return false
  }
  for (const stream of streams) {
    if (
      stream.method === 'terminal.multiplex' &&
      !stream.cancelled &&
      stream.onTerminalBinaryFrame?.(frame) === true
    ) {
      return true
    }
  }
  return false
}
