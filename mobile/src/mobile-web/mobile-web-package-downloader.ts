import { Buffer } from 'buffer/'
import { sha256 } from '@noble/hashes/sha256'
import {
  MOBILE_WEB_PACKAGE_MAX_CONCURRENT_READS,
  MOBILE_WEB_PACKAGE_MAX_RANGE_BYTES,
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
import {
  decodeGzipMobileWebPackageChunk,
  decodeRawMobileWebPackageChunk
} from './mobile-web-package-chunk-decoder'

const MOBILE_WEB_PACKAGE_READ_LIMITED_RETRIES = 4
const MOBILE_WEB_PACKAGE_READ_LIMITED_BACKOFF_MS = 50

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
  const manifestResponse = await requestResult(request, 'mobileWeb.package.manifest')
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

type ChunkTask = { asset: MobileWebAsset; offset: number; expectedLength: number }
type SettledChunk = { bytes: Uint8Array } | { failure: unknown }

// The native stage appends each asset chunk at the file's current length, so chunks must reach
// the stager in offset order even though the reads themselves overlap.
async function downloadAssetChunks<TCommit>(args: {
  request: MobileWebPackageRequest
  stager: MobileWebPackageStager<TCommit>
  manifest: MobileWebManifest
  chunkBytes: number
  signal: AbortSignal | undefined
  useGzip: boolean
  rangeBytes: number
  maxConcurrentRequests: number
  onChunkWritten: (bytes: number) => void
}): Promise<void> {
  const tasks = planChunkTasks(args.manifest, args.rangeBytes)
  const inFlight = new Map<number, Promise<SettledChunk>>()
  let window = clampWindow(args.maxConcurrentRequests)
  let issued = 0
  let assetHash = sha256.create()

  const shrinkWindow = (): void => {
    window = Math.max(1, window - 1)
  }
  for (let drained = 0; drained < tasks.length; drained += 1) {
    while (issued < tasks.length && issued - drained < window) {
      const task = tasks[issued]!
      inFlight.set(issued, fetchChunk(args, task, shrinkWindow))
      issued += 1
    }
    const settled = await inFlight.get(drained)!
    inFlight.delete(drained)
    if ('failure' in settled) {
      throw settled.failure
    }
    throwIfAborted(args.signal)
    const task = tasks[drained]!
    assetHash.update(settled.bytes)
    // A ranged read answers several stage chunks at once; the native stage still appends
    // one 48 KiB chunk at a time.
    for (let written = 0; written < settled.bytes.byteLength; written += args.chunkBytes) {
      const slice = settled.bytes.subarray(written, written + args.chunkBytes)
      await args.stager.writeAssetChunk(task.asset, task.offset + written, slice)
      args.onChunkWritten(slice.byteLength)
    }
    if (task.offset + task.expectedLength === task.asset.byteLength) {
      if (Buffer.from(assetHash.digest()).toString('hex') !== task.asset.sha256) {
        throw new MobileWebPackageDownloadError('asset_integrity_failed')
      }
      assetHash = sha256.create()
      await args.stager.finishAsset(task.asset)
    }
  }
}

function planChunkTasks(manifest: MobileWebManifest, rangeBytes: number): ChunkTask[] {
  const tasks: ChunkTask[] = []
  for (const asset of manifest.assets) {
    for (let offset = 0; offset < asset.byteLength; offset += rangeBytes) {
      tasks.push({
        asset,
        offset,
        expectedLength: Math.min(rangeBytes, asset.byteLength - offset)
      })
    }
  }
  return tasks
}

// Ranged reads ride mobileWeb.package.asset.gzip's optional `length`, which strict-schema
// hosts predating MOBILE_WEB_PACKAGE_RANGE_RUNTIME_CAPABILITY reject.
function clampRangeBytes(chunkBytes: number, rangeBytes: number | undefined): number {
  if (rangeBytes === undefined || rangeBytes <= chunkBytes) {
    return chunkBytes
  }
  const chunks = Math.min(
    Math.floor(MOBILE_WEB_PACKAGE_MAX_RANGE_BYTES / chunkBytes),
    Math.floor(rangeBytes / chunkBytes)
  )
  return Math.max(1, chunks) * chunkBytes
}

function clampWindow(maxConcurrentRequests: number): number {
  return Number.isInteger(maxConcurrentRequests)
    ? Math.min(MOBILE_WEB_PACKAGE_MAX_CONCURRENT_READS, Math.max(1, maxConcurrentRequests))
    : 1
}

// Never rejects: a queued read that fails while an earlier one is still draining would
// otherwise surface as an unhandled rejection before the drain loop reaches it.
async function fetchChunk<TCommit>(
  args: {
    request: MobileWebPackageRequest
    stager: MobileWebPackageStager<TCommit>
    manifest: MobileWebManifest
    signal: AbortSignal | undefined
    useGzip: boolean
    chunkBytes: number
    rangeBytes: number
  },
  task: ChunkTask,
  onReadLimited: () => void
): Promise<SettledChunk> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      throwIfAborted(args.signal)
      const result = await requestResult(
        args.request,
        args.useGzip ? 'mobileWeb.package.asset.gzip' : 'mobileWeb.package.asset',
        {
          buildId: args.manifest.buildId,
          path: task.asset.path,
          offset: task.offset,
          ...(args.rangeBytes > args.chunkBytes ? { length: args.rangeBytes } : {})
        }
      )
      throwIfAborted(args.signal)
      const decode = args.useGzip ? decodeGzipMobileWebPackageChunk : decodeRawMobileWebPackageChunk
      const bytes = decode(
        result,
        args.manifest.buildId,
        task.asset.path,
        task.offset,
        task.expectedLength,
        task.asset.byteLength
      )
      return bytes ? { bytes } : { failure: new MobileWebPackageDownloadError('invalid_chunk') }
    } catch (error) {
      // Why: a host whose per-connection read budget is narrower than ours must slow the
      // pipeline down, not fail the whole package.
      if (
        error instanceof MobileWebPackageDownloadError &&
        error.code === 'mobile_web_package_read_limited' &&
        attempt < MOBILE_WEB_PACKAGE_READ_LIMITED_RETRIES
      ) {
        onReadLimited()
        await sleep(MOBILE_WEB_PACKAGE_READ_LIMITED_BACKOFF_MS * (attempt + 1))
        continue
      }
      return { failure: error }
    }
  }
}

async function requestResult(
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

function sleep(durationMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, durationMs))
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new MobileWebPackageDownloadError('cancelled')
  }
}
