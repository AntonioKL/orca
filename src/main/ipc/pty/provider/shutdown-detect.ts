import type { IPtyProvider } from '../../../providers/types'
import { ptyIncarnationById } from './ownership-state'
import type { PtyKillIntent } from '../../../../shared/pty-kill-sessions'

export async function shutdownProviderAndDetectExit(
  provider: IPtyProvider,
  id: string,
  opts: {
    immediate?: boolean
    keepHistory?: boolean
    deadlineMs?: number
    intent?: PtyKillIntent
    incarnationId?: string
  }
): Promise<boolean> {
  let providerExitObserved = false
  const expectedIncarnationId = ptyIncarnationById.get(id)
  const unsubscribe = provider.onExit((payload) => {
    if (
      payload.id === id &&
      (!expectedIncarnationId || payload.incarnationId === expectedIncarnationId)
    ) {
      providerExitObserved = true
    }
  })
  try {
    await provider.shutdown(id, opts)
  } finally {
    unsubscribe()
  }
  return providerExitObserved
}
