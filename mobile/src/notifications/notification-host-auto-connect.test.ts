import { describe, expect, it } from 'vitest'
import type { HostProfile } from '../transport/types'
import {
  NOTIFICATION_HOST_AUTO_CONNECT_LIMIT,
  selectNotificationHostAutoConnectIds
} from './notification-host-auto-connect'

function host(id: string, lastConnected: number): HostProfile {
  return {
    id,
    name: id,
    endpoint: `ws://${id}.internal:8787`,
    deviceToken: `token-${id}`,
    publicKeyB64: `key-${id}`,
    lastConnected
  }
}

describe('notification host auto-connect selection', () => {
  it('bounds startup sockets to the most recently connected hosts', () => {
    const hosts = Array.from({ length: 1_000 }, (_, index) => host(`host-${index}`, index))

    const selected = selectNotificationHostAutoConnectIds(hosts)

    expect(selected).toHaveLength(NOTIFICATION_HOST_AUTO_CONNECT_LIMIT)
    expect(selected.slice(0, 3)).toEqual(['host-999', 'host-998', 'host-997'])
  })

  it('does not mutate catalog order', () => {
    const hosts = [host('older', 1), host('newer', 2)]

    selectNotificationHostAutoConnectIds(hosts)

    expect(hosts.map(({ id }) => id)).toEqual(['older', 'newer'])
  })
})
