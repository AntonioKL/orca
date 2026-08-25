import { X509Certificate } from 'node:crypto'
import { rootCertificates } from 'node:tls'
import { describe, expect, it } from 'vitest'
import type { ProcessResult } from '../../shared/child-process/run-process'
import { loadLegacySystemCaCertificates } from './first-party-ca-certificates'

const bundledRoot = rootCertificates.find((pem) => {
  const certificate = new X509Certificate(pem)
  return certificate.ca && certificate.checkIssued(certificate)
})

if (!bundledRoot) {
  throw new Error('expected a current bundled root certificate')
}

const bundledRootDer = new X509Certificate(bundledRoot).raw

function processResult(overrides: Partial<ProcessResult> = {}): ProcessResult {
  return {
    code: 0,
    signal: null,
    stdout: '',
    stderr: '',
    timedOut: false,
    ...overrides
  }
}

class FakeWindowsStore {
  private index = 0

  constructor(private readonly certificates: Uint8Array[]) {}

  next(): Uint8Array | undefined {
    return this.certificates[this.index++]
  }

  done(): void {}
}

describe('legacy system CA loading', () => {
  it('reads the policy-owned Linux bundle when Node cannot enumerate system roots', async () => {
    const certificates = await loadLegacySystemCaCertificates({
      platform: 'linux',
      env: { SSL_CERT_FILE: '/fixture/ca-bundle.crt' },
      readFile: async (path) => {
        expect(path).toBe('/fixture/ca-bundle.crt')
        return bundledRoot
      }
    })

    expect(certificates).toEqual([bundledRoot])
  })

  it('accepts only macOS roots that the host trust policy verifies', async () => {
    const accepted = await loadLegacySystemCaCertificates({
      platform: 'darwin',
      runProcess: async (spec) =>
        spec.args?.[0] === 'find-certificate'
          ? processResult({ stdout: bundledRoot })
          : processResult()
    })
    const rejected = await loadLegacySystemCaCertificates({
      platform: 'darwin',
      runProcess: async (spec) =>
        spec.args?.[0] === 'find-certificate'
          ? processResult({ stdout: bundledRoot })
          : processResult({ code: 1 })
    })

    expect(accepted).toEqual([bundledRoot])
    expect(rejected).toEqual([])
  })

  it('subtracts the Windows disallowed store from trusted roots', async () => {
    const load = (disallowed: Uint8Array[]) =>
      loadLegacySystemCaCertificates({
        platform: 'win32',
        loadWindowsCaModule: async () => ({
          Crypt32: class {
            private readonly store: FakeWindowsStore

            constructor(name?: string) {
              this.store = new FakeWindowsStore(
                name === 'Disallowed' ? disallowed : [bundledRootDer]
              )
            }

            next(): Uint8Array | undefined {
              return this.store.next()
            }

            done(): void {
              this.store.done()
            }
          }
        })
      })

    expect(await load([])).toHaveLength(1)
    expect(await load([bundledRootDer])).toEqual([])
  })
})
