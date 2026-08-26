import { ipcMain } from 'electron'
import {
  addEnvironmentFromPairingCode,
  listEnvironments,
  removeEnvironment,
  resolveEnvironment,
  RuntimeEnvironmentStoreError
} from '../../shared/runtime-environment-store'
import {
  redactRuntimeEnvironment,
  type PublicKnownRuntimeEnvironment
} from '../../shared/runtime-environments'
import { RemoteRuntimeClientError } from '../../shared/remote-runtime-client-error'
import { RuntimeRpcCallQueueOverloadError } from '../../shared/runtime-rpc-call-queue'
import type { RuntimeRpcFailure, RuntimeRpcResponse } from '../../shared/runtime-rpc-envelope'
import type { RuntimeStatus } from '../../shared/runtime-types'
import type { Store } from '../persistence'
import { clearBrowserRoutePartitionStorageForEnvironment } from '../browser/browser-route-partition-storage-runtime'
import { retireBrowserRoutePartitionStorageForEnvironment } from '../browser/browser-route-partition-storage-retirement'
import { verifyAndAddRuntimeEnvironmentFromPairingCode } from './runtime-environment-pairing-verification'
import { closeRemoteRuntimeRequestConnection } from './runtime-environment-request-connections'
import {
  callRuntimeEnvironment,
  clearSharedControlSupport,
  getRuntimeEnvironmentStatus
} from './runtime-environment-transport-routing'

const manuallyDisconnectedEnvironmentIds = new Set<string>()

function manualDisconnectResponse(
  environment: ReturnType<typeof resolveEnvironment>,
  code: 'runtime_manually_disconnected' | 'runtime_manually_disconnected_after_reply'
): RuntimeRpcResponse<never> {
  return {
    id: 'runtime.manualDisconnect',
    ok: false,
    error: { code, message: 'Runtime environment is manually disconnected.' },
    _meta: { runtimeId: environment.runtimeId }
  }
}

/** The call never left this process, so whatever it asked for definitely did not happen. */
function manuallyDisconnectedResponse(
  environment: ReturnType<typeof resolveEnvironment>
): RuntimeRpcResponse<never> {
  return manualDisconnectResponse(environment, 'runtime_manually_disconnected')
}

/**
 * Discarding a reply the runtime already sent is not the same as refusing to dispatch: the discarded
 * reply may have been `ok:true`, so callers must read this as "outcome unknown", not "did not happen".
 */
function manuallyDisconnectedAfterReplyResponse(
  environment: ReturnType<typeof resolveEnvironment>
): RuntimeRpcResponse<never> {
  return manualDisconnectResponse(environment, 'runtime_manually_disconnected_after_reply')
}

export function isRuntimeEnvironmentManuallyDisconnected(environmentId: string): boolean {
  return manuallyDisconnectedEnvironmentIds.has(environmentId)
}

type ConnectivityHandlerOptions = {
  store: Store
  getUserDataPath: () => string
  invalidateTransport: (environmentId: string) => Promise<void> | void
}

export function registerRuntimeEnvironmentConnectivityHandlers({
  store,
  getUserDataPath,
  invalidateTransport
}: ConnectivityHandlerOptions): void {
  ipcMain.handle('runtimeEnvironments:list', () =>
    listEnvironments(getUserDataPath()).map(redactRuntimeEnvironment)
  )
  ipcMain.handle(
    'runtimeEnvironments:addFromPairingCode',
    (
      _event,
      args: { name: string; pairingCode: string }
    ): { environment: PublicKnownRuntimeEnvironment } => {
      const environment = addEnvironmentFromPairingCode(getUserDataPath(), args)
      manuallyDisconnectedEnvironmentIds.delete(environment.id)
      return { environment: redactRuntimeEnvironment(environment) }
    }
  )
  ipcMain.handle(
    'runtimeEnvironments:verifyAndAddFromPairingCode',
    async (_event, args: { name: string; pairingCode: string; allowLoopback?: boolean }) => {
      const result = await verifyAndAddRuntimeEnvironmentFromPairingCode(getUserDataPath(), args)
      if (result.ok) {
        manuallyDisconnectedEnvironmentIds.delete(result.environment.id)
      }
      return result
    }
  )
  ipcMain.handle('runtimeEnvironments:resolve', (_event, args: { selector: string }) =>
    redactRuntimeEnvironment(resolveEnvironment(getUserDataPath(), args.selector))
  )
  ipcMain.handle(
    'runtimeEnvironments:remove',
    (_event, args: { selector: string }): { removed: PublicKnownRuntimeEnvironment } => {
      const environment = resolveEnvironment(getUserDataPath(), args.selector)
      if (store.getSettings().activeRuntimeEnvironmentId === environment.id) {
        throw new Error('Choose another Active Server in Advanced before removing this server.')
      }
      const removed = removeEnvironment(getUserDataPath(), args.selector)
      manuallyDisconnectedEnvironmentIds.delete(removed.id)
      const retiring = Promise.resolve(invalidateTransport(removed.id))
      closeLegacySelectorTransport(args.selector, removed.id)
      // Why: removal is an explicit lifecycle decision, so its client-hosted browser storage goes
      // too -- but only once the client host releases its partitions, or every one refuses as live.
      void retireBrowserRoutePartitionStorageForEnvironment({
        environmentId: removed.id,
        whenClientHostClosed: retiring,
        clearStorage: clearBrowserRoutePartitionStorageForEnvironment,
        onError: (error) => {
          console.warn('[runtime-environments] browser partition storage clear failed:', error)
        }
      }).catch((error) => {
        console.warn('[runtime-environments] browser partition storage clear failed:', error)
      })
      return { removed: redactRuntimeEnvironment(removed) }
    }
  )
  ipcMain.handle(
    'runtimeEnvironments:disconnect',
    (_event, args: { selector: string }): { disconnected: PublicKnownRuntimeEnvironment } => {
      const environment = resolveEnvironment(getUserDataPath(), args.selector)
      manuallyDisconnectedEnvironmentIds.add(environment.id)
      invalidateTransport(environment.id)
      closeLegacySelectorTransport(args.selector, environment.id)
      return { disconnected: redactRuntimeEnvironment(environment) }
    }
  )
  ipcMain.handle(
    'runtimeEnvironments:connect',
    async (
      _event,
      args: { selector: string; timeoutMs?: number }
    ): Promise<RuntimeRpcResponse<RuntimeStatus>> => {
      const environment = resolveEnvironment(getUserDataPath(), args.selector)
      manuallyDisconnectedEnvironmentIds.delete(environment.id)
      return getRuntimeEnvironmentStatus(getUserDataPath(), environment.id, args.timeoutMs)
    }
  )
}

export function registerRuntimeEnvironmentPassiveHandlers(getUserDataPath: () => string): void {
  registerPassiveStatusHandler(getUserDataPath)
  registerPassiveCallHandler(getUserDataPath)
}

function closeLegacySelectorTransport(selector: string, environmentId: string): void {
  if (selector === environmentId) {
    return
  }
  closeRemoteRuntimeRequestConnection(selector)
  clearSharedControlSupport(selector)
}

function registerPassiveStatusHandler(getUserDataPath: () => string): void {
  ipcMain.handle(
    'runtimeEnvironments:getStatus',
    async (
      _event,
      args: { selector: string; timeoutMs?: number }
    ): Promise<RuntimeRpcResponse<RuntimeStatus>> => {
      const environment = resolveEnvironment(getUserDataPath(), args.selector)
      if (isRuntimeEnvironmentManuallyDisconnected(environment.id)) {
        return manuallyDisconnectedResponse(environment)
      }
      const response = await getRuntimeEnvironmentStatus(
        getUserDataPath(),
        environment.id,
        args.timeoutMs
      )
      return isRuntimeEnvironmentManuallyDisconnected(environment.id)
        ? manuallyDisconnectedAfterReplyResponse(environment)
        : response
    }
  )
}

function runtimeEnvironmentCallFailure(
  environment: ReturnType<typeof resolveEnvironment>,
  method: string,
  error: unknown
): RuntimeRpcFailure | null {
  if (
    !(error instanceof RemoteRuntimeClientError) &&
    !(error instanceof RuntimeRpcCallQueueOverloadError)
  ) {
    return null
  }
  return {
    id: method,
    ok: false,
    error: { code: error.code, message: error.message },
    _meta: { runtimeId: environment.runtimeId }
  }
}

/**
 * Electron IPC drops the error code on a rejection, so a selector the main process already refused
 * would reach the renderer as an unclassifiable string it could only treat as "outcome unknown".
 */
function runtimeEnvironmentSelectorFailure(
  method: string,
  error: unknown
): RuntimeRpcFailure | null {
  return error instanceof RuntimeEnvironmentStoreError
    ? { id: method, ok: false, error: { code: error.code, message: error.message } }
    : null
}

function registerPassiveCallHandler(getUserDataPath: () => string): void {
  ipcMain.handle(
    'runtimeEnvironments:call',
    async (
      _event,
      args: {
        selector: string
        method: string
        params?: unknown
        timeoutMs?: number
        expectedEnvironmentPairingRevision?: number
      }
    ): Promise<RuntimeRpcResponse<unknown>> => {
      let environment: ReturnType<typeof resolveEnvironment>
      try {
        environment = resolveEnvironment(getUserDataPath(), args.selector)
      } catch (error) {
        const failure = runtimeEnvironmentSelectorFailure(args.method, error)
        if (failure) {
          return failure
        }
        throw error
      }
      if (isRuntimeEnvironmentManuallyDisconnected(environment.id)) {
        return manuallyDisconnectedResponse(environment)
      }
      let response: RuntimeRpcResponse<unknown>
      try {
        response = await callRuntimeEnvironment(
          getUserDataPath(),
          environment.id,
          args.method,
          args.params,
          args.timeoutMs,
          args.expectedEnvironmentPairingRevision
        )
      } catch (error) {
        const failure = runtimeEnvironmentCallFailure(environment, args.method, error)
        if (failure) {
          return failure
        }
        throw error
      }
      return isRuntimeEnvironmentManuallyDisconnected(environment.id)
        ? manuallyDisconnectedAfterReplyResponse(environment)
        : response
    }
  )
}
