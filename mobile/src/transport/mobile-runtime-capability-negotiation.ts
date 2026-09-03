import {
  MOBILE_RUNTIME_CLIENT_CAPABILITY_UPDATE_METHOD,
  mobileRuntimeClientCapabilityUpdateParams
} from './mobile-runtime-client-capabilities'
import type { RpcResponse } from './types'

type CapabilityRequest = (method: string, params: unknown) => Promise<RpcResponse>

export function requestMobileRuntimeCapabilities(
  sendRequest: CapabilityRequest
): Promise<RpcResponse> {
  return sendRequest(
    MOBILE_RUNTIME_CLIENT_CAPABILITY_UPDATE_METHOD,
    mobileRuntimeClientCapabilityUpdateParams()
  )
}

export function negotiateMobileRuntimeCapabilities(args: {
  sendRequest: CapabilityRequest
  current: () => boolean
  onReady: () => void
  onFailure: () => void
}): void {
  void requestMobileRuntimeCapabilities(args.sendRequest)
    .then((response) => {
      if (!args.current()) {
        return
      }
      if (!response.ok) {
        console.warn('[net] mobile capability negotiation unavailable', response.error.code)
      }
      args.onReady()
    })
    .catch((error: unknown) => {
      if (!args.current()) {
        return
      }
      console.warn('[net] mobile capability negotiation failed', error)
      args.onFailure()
    })
}
