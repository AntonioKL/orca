import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import {
  installBrowserGlobals,
  writeStoredRuntimeEnvironment
} from './web-preload-api-test-harness'

describe('web UI computer-use permission reset', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.doUnmock('./web-runtime-client')
  })

  it('proxies permission reset for paired web clients', async () => {
    const calls: { method: string; params: unknown }[] = []
    vi.doMock('./web-runtime-client', () => ({
      WebRuntimeClient: class {
        call(method: string, params: unknown): Promise<RuntimeRpcResponse<unknown>> {
          calls.push({ method, params })
          return Promise.resolve({
            id: method,
            ok: true,
            result:
              method === 'computer.permissionsReset'
                ? {
                    platform: 'darwin',
                    helperAppPath: '/Applications/Orca Computer Use.app',
                    helperUnavailableReason: null,
                    bundleId: 'com.stablyai.orca.computer-use',
                    permissions: [
                      { id: 'accessibility', status: 'not-granted' },
                      { id: 'screenshots', status: 'not-granted' }
                    ]
                  }
                : {},
            _meta: { runtimeId: 'runtime-1' }
          })
        }

        close(): void {}
      }
    }))

    const globals = installBrowserGlobals('Linux')
    writeStoredRuntimeEnvironment(globals.storage)
    const { installWebPreloadApi } = await import('./web-preload-api')
    installWebPreloadApi()

    await expect(globals.window.api.computerUsePermissions.reset()).resolves.toMatchObject({
      bundleId: 'com.stablyai.orca.computer-use',
      permissions: [
        { id: 'accessibility', status: 'not-granted' },
        { id: 'screenshots', status: 'not-granted' }
      ]
    })
    expect(calls).toEqual([{ method: 'computer.permissionsReset', params: {} }])
  })
})
