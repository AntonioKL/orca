import { Buffer } from 'buffer/'
import { sha256 } from '@noble/hashes/sha256'
import {
  MOBILE_WEB_PACKAGE_MAX_CONCURRENT_READS,
  MobileWebPackageManifestResponseSchema,
  isMobileWebPackageErrorCode,
  type MobileWebPackageErrorCode
} from '../../../src/shared/mobile-web/package-rpc-contract'
import type {
  MobileWebAsset,
  MobileWebManifest
} from '../../../src/shared/mobile-web/manifest-contract'
import {
  serializeMobileWebManifestForBuildId,
  supportsMobileWebBridgeVersion
} from '../../../src/shared/mobile-web/manifest-contract'
import type { RpcResponse } from '../transport/types'
import { clampRangeBytes, downloadAssetChunks } from './mobile-web-package-chunk-pipeline'

export const MOBILE_WEB_PACKAGE_DOWNLOAD_ERROR_CODES = [
  'cancelled',
  'host_error',
  'host_forbidden',
  'host_method_unavailable',
  'host_rejected_request',
  'host_runtime_failure',
  'invalid_manifest',
  'incompatible_bridge',
  'invalid_chunk',
  'asset_integrity_failed',
  'staging_failed'
] as const

export type MobileWebPackageDownloadErrorCode =
  | (typeof MOBILE_WEB_PACKAGE_DOWNLOAD_ERROR_CODES)[number]
  | MobileWebPackageErrorCode

export class MobileWebPackageDownloadError extends Error {
  constructor(readonly code: MobileWebPackageDownloadErrorCode) {
    super(code)
    this.name = 'MobileWebPackageDownloadError'
  }
}

export function mobileWebPackageDownloadFailureCode(error: unknown): string {
  return error instanceof MobileWebPackageDownloadError ? error.code : 'native_session_error'
}

export type MobileWebPackageRequest = (method: string, params?: unknown) => Promise<RpcResponse>

export type MobileWebPackageDownloadProgress = {
  phase: 'downloading' | 'verifying' | 'activating'
  completedBytes: number
  totalBytes: number
}

export type MobileWebPackageStager<TCommit> = {
  begin(manifest: MobileWebManifest): Promise<void>
  writeAssetChunk(asset: MobileWebAsset, offset: number, bytes: Uint8Array): Promise<void>
  finishAsset(asset: MobileWebAsset): Promise<void>
  commit(manifest: MobileWebManifest): Promise<TCommit>
  abort(): Promise<void>
}

type DownloadMobileWebPackageOptions = {
  shellBridgeVersion: number
  signal?: AbortSignal
  useGzip?: boolean
  /** Chunk reads kept in flight at once. One round trip per 48 KiB otherwise caps throughput. */
  maxConcurrentRequests?: number
  /** Bytes per gzip read. Only send above chunkBytes when the host advertises range reads. */
  rangeBytes?: number
  onProgress?: (progress: MobileWebPackageDownloadProgress) => void
}

type DownloadMobileWebPackageWithReuseOptions = DownloadMobileWebPackageOptions & {
  reuseVerifiedBuild: (buildId: string) => boolean | Promise<boolean>
}

type DownloadedMobileWebPackage<TCommit> = {
  manifest: MobileWebManifest
  commit: TCommit
  reusedVerifiedBuild: false
}

type ReusedOrDownloadedMobileWebPackage<TCommit> =
  | DownloadedMobileWebPackage<TCommit>
  | {
      manifest: MobileWebManifest
      commit: null
      reusedVerifiedBuild: true
    }

export function downloadMobileWebPackage<TCommit>(
  request: MobileWebPackageRequest,
  stager: MobileWebPackageStager<TCommit>,
  options: DownloadMobileWebPackageWithReuseOptions
): Promise<ReusedOrDownloadedMobileWebPackage<TCommit>>

export function downloadMobileWebPackage<TCommit>(
  request: MobileWebPackageRequest,
  stager: MobileWebPackageStager<TCommit>,
  options: DownloadMobileWebPackageOptions
): Promise<DownloadedMobileWebPackage<TCommit>>

export async function downloadMobileWebPackage<TCommit>(
  request: MobileWebPackageRequest,
  stager: MobileWebPackageStager<TCommit>,
  options: DownloadMobileWebPackageOptions & {
    reuseVerifiedBuild?: (buildId: string) => boolean | Promise<boolean>
  }
): Promise<ReusedOrDownloadedMobileWebPackage<TCommit>> {
  throwIfAborted(options.signal)
  const manifestResponse = await requestMobileWebPackageResult(
    request,
    'mobileWeb.package.manifest'
  )
  throwIfAborted(options.signal)
  const parsedManifest = MobileWebPackageManifestResponseSchema.safeParse(manifestResponse)
  if (!parsedManifest.success) {
    throw new MobileWebPackageDownloadError('invalid_manifest')
  }
  const { manifest, chunkBytes } = parsedManifest.data
  options.onProgress?.({
    phase: 'downloading',
    completedBytes: 0,
    totalBytes: manifest.totalBytes
  })
  if (sha256Hex(Buffer.from(serializeMobileWebManifestForBuildId(manifest))) !== manifest.buildId) {
    throw new MobileWebPackageDownloadError('invalid_manifest')
  }
  if (!supportsMobileWebBridgeVersion(manifest.bridge, options.shellBridgeVersion)) {
    throw new MobileWebPackageDownloadError('incompatible_bridge')
  }
  if (await options.reuseVerifiedBuild?.(manifest.buildId)) {
    throwIfAborted(options.signal)
    return { manifest, commit: null, reusedVerifiedBuild: true }
  }
  throwIfAborted(options.signal)

  let stagingStarted = false
  try {
    await stager.begin(manifest)
    stagingStarted = true
    let completedBytes = 0
    await downloadAssetChunks({
      request,
      stager,
      manifest,
      chunkBytes,
      signal: options.signal,
      useGzip: options.useGzip ?? false,
      rangeBytes: options.useGzip ? clampRangeBytes(chunkBytes, options.rangeBytes) : chunkBytes,
      maxConcurrentRequests:
        options.maxConcurrentRequests ?? MOBILE_WEB_PACKAGE_MAX_CONCURRENT_READS,
      onChunkWritten: (writtenBytes) => {
        completedBytes += writtenBytes
        options.onProgress?.({
          phase: 'downloading',
          completedBytes,
          totalBytes: manifest.totalBytes
        })
      }
    })
    throwIfAborted(options.signal)
    options.onProgress?.({
      phase: 'verifying',
      completedBytes: manifest.totalBytes,
      totalBytes: manifest.totalBytes
    })
    const commit = await stager.commit(manifest)
    options.onProgress?.({
      phase: 'activating',
      completedBytes: manifest.totalBytes,
      totalBytes: manifest.totalBytes
    })
    stagingStarted = false
    return { manifest, commit, reusedVerifiedBuild: false }
  } catch (error) {
    if (stagingStarted) {
      await stager.abort().catch(() => {})
    }
    if (error instanceof MobileWebPackageDownloadError) {
      throw error
    }
    throw new MobileWebPackageDownloadError('staging_failed')
  }
}

export async function requestMobileWebPackageResult(
  request: MobileWebPackageRequest,
  method: string,
  params?: unknown
): Promise<unknown> {
  let response: RpcResponse
  try {
    response = await request(method, params)
  } catch {
    throw new MobileWebPackageDownloadError('host_error')
  }
  if (!response.ok) {
    const message = response.error.message
    throw new MobileWebPackageDownloadError(
      isMobileWebPackageErrorCode(message)
        ? message
        : mobileWebPackageHostFailureCode(response.error.code)
    )
  }
  return response.result
}

function sha256Hex(bytes: Uint8Array): string {
  return Buffer.from(sha256(bytes)).toString('hex')
}

function mobileWebPackageHostFailureCode(code: string): MobileWebPackageDownloadErrorCode {
  switch (code) {
    case 'forbidden':
    case 'unauthorized':
      return 'host_forbidden'
    case 'method_not_found':
    case 'method_not_supported':
      return 'host_method_unavailable'
    case 'invalid_argument':
      return 'host_rejected_request'
    case 'runtime_error':
      return 'host_runtime_failure'
    default:
      return 'host_error'
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new MobileWebPackageDownloadError('cancelled')
  }
}
