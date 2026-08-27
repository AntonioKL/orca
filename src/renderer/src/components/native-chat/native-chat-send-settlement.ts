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

export function notifyNativeChatSlashCommand(
  onSlashCommand:
    | ((command: string, settled?: Promise<void>, cancelled?: () => boolean) => void)
    | undefined,
  command: string,
  settled: Promise<void> | undefined,
  cancelled?: () => boolean
): void {
  if (cancelled) {
    onSlashCommand?.(command, settled, cancelled)
  } else {
    onSlashCommand?.(command, settled)
  }
}
