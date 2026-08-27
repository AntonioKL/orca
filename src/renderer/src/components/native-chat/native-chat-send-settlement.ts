import { waitForNativeChatPtyIdle } from './native-chat-pty-send-queue'

export function waitForNativeChatSendQueueIdle(
  ptyId: string,
  settled?: Promise<void>
): Promise<void> | undefined {
  return settled?.then(
    () => waitForNativeChatPtyIdle(ptyId),
    () => waitForNativeChatPtyIdle(ptyId)
  )
}

export function trackNativeSend<THandle>(
  handle: THandle | null,
  track: (handle: THandle, pendingId?: string) => void,
  pendingId?: string
): void {
  if (handle) {
    track(handle, pendingId)
  }
}
