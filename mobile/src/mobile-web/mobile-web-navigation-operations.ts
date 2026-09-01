import {
  MobileWebNavigationReconnectPayloadSchema,
  MobileWebNavigationRemoveHostPayloadSchema,
  MobileWebNavigationRoutePayloadSchema
} from '../../../src/shared/mobile-web/navigation-operation-contract'
import { MobileWebBrokerError } from './mobile-web-broker-error'
import { requireRecentUserGesture } from './mobile-web-user-gesture-requirement'

export type MobileWebNavigationAuthority = {
  route(
    destination: 'hostPicker' | 'pairingRepair' | 'terminalSettings',
    requestId: string
  ): void | Promise<void>
  reconnect(): void | Promise<void>
  removeHost(): void | Promise<void>
  consumeRecentUserGesture(): boolean
}

export async function executeMobileWebNavigationOperation(args: {
  requestId: string
  operation: string
  payload: unknown
  authority: MobileWebNavigationAuthority | undefined
}): Promise<null> {
  if (args.operation === 'route') {
    const payload = MobileWebNavigationRoutePayloadSchema.parse(args.payload)
    const authority = requireAuthority(args.authority)
    if (payload.destination === 'terminalSettings') {
      requireRecentUserGesture(() => authority.consumeRecentUserGesture())
    }
    await authority.route(payload.destination, args.requestId)
    return null
  }
  if (args.operation === 'reconnect') {
    MobileWebNavigationReconnectPayloadSchema.parse(args.payload)
    const authority = requireAuthority(args.authority)
    requireRecentUserGesture(() => authority.consumeRecentUserGesture())
    await authority.reconnect()
    return null
  }
  if (args.operation === 'removeHost') {
    MobileWebNavigationRemoveHostPayloadSchema.parse(args.payload)
    const authority = requireAuthority(args.authority)
    requireRecentUserGesture(() => authority.consumeRecentUserGesture())
    await authority.removeHost()
    return null
  }
  throw new MobileWebBrokerError('unsupported_capability')
}

function requireAuthority(
  authority: MobileWebNavigationAuthority | undefined
): MobileWebNavigationAuthority {
  if (!authority) {
    throw new MobileWebBrokerError('unavailable')
  }
  return authority
}
