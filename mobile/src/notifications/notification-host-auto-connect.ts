import type { HostProfile } from '../transport/types'

// Bounds foreground sockets and reconnect storms while covering well beyond Home's startup set.
export const NOTIFICATION_HOST_AUTO_CONNECT_LIMIT = 32

export function selectNotificationHostAutoConnectIds(
  hosts: readonly HostProfile[],
  limit = NOTIFICATION_HOST_AUTO_CONNECT_LIMIT
): string[] {
  return [...hosts]
    .sort(
      (left, right) => right.lastConnected - left.lastConnected || left.id.localeCompare(right.id)
    )
    .slice(0, Math.max(0, limit))
    .map(({ id }) => id)
}
