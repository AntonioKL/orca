import { encryptedTerminalMultiplexFrame } from './rpc-client-terminal-multiplex'
import type { TerminalStreamFrame } from './terminal-stream-protocol'

export function sendMobileTerminalBinaryFrame(args: {
  frame: TerminalStreamFrame
  socket: WebSocket | null
  sharedKey: Uint8Array | null
  isConnected: boolean
  onSocketClosed: (socket: WebSocket) => void
}): boolean {
  if (!args.socket || args.socket.readyState !== WebSocket.OPEN || !args.sharedKey) {
    return false
  }
  try {
    args.socket.send(encryptedTerminalMultiplexFrame(args.frame, args.sharedKey))
    return true
  } catch {
    if (args.isConnected) {
      args.onSocketClosed(args.socket)
    }
    return false
  }
}
