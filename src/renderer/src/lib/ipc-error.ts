/**
 * Electron's ipcRenderer.invoke wraps errors as:
 *   "Error invoking remote method 'channel': Error: actual message"
 * Strip the wrapper so users see only the meaningful part.
 *
 * The envelope itself is described once in `shared` because main-side callers strip it too.
 */

export {
  stripErrorClassPrefix,
  stripIpcInvokeEnvelope,
  stripIpcInvokeEnvelopeFrom
} from '../../../shared/ipc-invoke-envelope'

export function extractIpcErrorMessage(err: unknown, fallback: string): string {
  if (!(err instanceof Error)) {
    return fallback
  }
  const match = err.message.match(/Error invoking remote method '[^']*': (?:Error: )?(.+)/)
  return match ? match[1] : err.message
}
