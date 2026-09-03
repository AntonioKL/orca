// Harness behind scripts/measure-mobile-web-package-download.mjs. It drives the real mobile
// package downloader over the real mobile RPC clients (direct WebSocket and the cloud-relay
// session) against the real desktop MobileWebPackageAssets reader, with an injectable per-hop
// delay so a cloud round trip can be modelled on loopback.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import nacl from 'tweetnacl'
import WebSocketClient, { WebSocketServer, type RawData, type WebSocket } from 'ws'
import { connect as connectDirectRpcClient, type RpcClient } from '../src/transport/rpc-client'
import { connectMobileRelayRpcSession } from '../src/transport/mobile-relay-rpc-session'
import {
  downloadMobileWebPackage,
  type MobileWebPackageStager
} from '../src/mobile-web/mobile-web-package-downloader'
import { MOBILE_WEB_BRIDGE_PROTOCOL_VERSION } from '../../src/shared/mobile-web/bridge-contract'
import type { MobileWebPackageAssetParams } from '../../src/shared/mobile-web/package-rpc-contract'
import type { MobileRelayEndpoint } from '../../src/shared/mobile-relay-credential-contract'
import { DeviceRegistry } from '../../src/main/runtime/device-registry'
import {
  MobileSocketWiring,
  type MobileSocketTransport
} from '../../src/main/runtime/rpc/mobile-socket-wiring'
import { CloudRelayTransport } from '../../src/main/runtime/rpc/relay-transport'
import { deriveRelayHostId } from '../../src/main/runtime/relay/relay-http-client'
import { MobileWebPackageAssets } from '../../src/main/runtime/rpc/mobile-web-package-assets'

export type MeasurementOptions = {
  path: 'direct' | 'relay'
  packageRoot: string
  oneWayDelayMs: number
  gzip: boolean
  rangeBytes: number
  maxConcurrentRequests: number
}

export type MeasurementResult = MeasurementOptions & {
  totalBytes: number
  wallMs: number
  bytesPerSecond: number
  chunkRequests: number
  wireBytesToPhone: number
  latencyMedianMs: number
  latencyP95Ms: number
  peakInFlight: number
}

type MeasurementRpcRequest = { id: string; method: string; params?: Record<string, unknown> }

type Teardown = (() => Promise<void> | void)[]

export async function measureMobileWebPackageDownload(
  options: MeasurementOptions
): Promise<MeasurementResult> {
  const teardown: Teardown = []
  try {
    const packageAssets = new MobileWebPackageAssets({ resolveRoot: () => options.packageRoot })
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-package-measure-'))
    teardown.push(() => rmSync(userDataPath, { recursive: true, force: true }))
    const registry = new DeviceRegistry(userDataPath)
    const device = registry.addDevice('Measurement phone', 'mobile')
    const desktopKeys = nacl.box.keyPair()
    const desktopPublicKeyB64 = Buffer.from(desktopKeys.publicKey).toString('base64')
    const relayHostId = deriveRelayHostId(desktopKeys.publicKey)
    const relayEndpoint: MobileRelayEndpoint = {
      v: 1,
      directorUrl: 'https://relay.measure.test',
      cellUrl: 'https://relay-c1.measure.test',
      assignmentEpoch: 1,
      relayHostId,
      e2eeFraming: 2
    }

    let wireBytesToPhone = 0
    const countInbound = (bytes: number): void => {
      wireBytesToPhone += bytes
    }
    const wiring = new MobileSocketWiring({
      deviceRegistry: registry,
      e2eeKeypair: {
        publicKey: desktopKeys.publicKey,
        secretKey: desktopKeys.secretKey,
        publicKeyB64: desktopPublicKeyB64
      },
      onText: (socket, plaintext, reply) => {
        const request = JSON.parse(plaintext) as MeasurementRpcRequest
        if (request.method === 'pairing.getEndpoints') {
          reply(
            rpcSuccess(request.id, {
              v: 1,
              relay: relayEndpoint,
              resumeConfirmation: {
                v: 1,
                reqId: request.params?.resumeConfirmReqId,
                currentVersion: 3,
                acceptedAs: 'current',
                renewed: true,
                resumeExpiresAt: Date.now() + 900_000
              }
            })
          )
          return
        }
        const params = request.params as unknown as MobileWebPackageAssetParams
        const readOptions = { connectionId: socket.connectionId }
        if (request.method === 'mobileWeb.package.manifest') {
          settle(request.id, packageAssets.getManifest(), reply)
          return
        }
        if (request.method === 'mobileWeb.package.asset') {
          settle(request.id, packageAssets.getAssetChunk(params, readOptions), reply)
          return
        }
        if (request.method === 'mobileWeb.package.asset.gzip') {
          settle(request.id, packageAssets.getAssetGzipChunk(params, readOptions), reply)
          return
        }
        reply(rpcSuccess(request.id, {}))
      },
      onBinary: () => {},
      onClose: () => {}
    })

    const client =
      options.path === 'relay'
        ? await openRelayClient({
            wiring,
            relayEndpoint,
            relayHostId,
            relayDeviceId: device.deviceId,
            deviceToken: device.token,
            desktopPublicKeyB64,
            oneWayDelayMs: options.oneWayDelayMs,
            teardown,
            countInbound
          })
        : await openDirectClient({
            wiring,
            deviceToken: device.token,
            desktopPublicKeyB64,
            oneWayDelayMs: options.oneWayDelayMs,
            teardown,
            countInbound
          })

    const latencies: number[] = []
    let chunkRequests = 0
    let inFlight = 0
    let peakInFlight = 0
    const startedAt = performance.now()
    const downloaded = await downloadMobileWebPackage(
      async (method, params) => {
        inFlight += 1
        peakInFlight = Math.max(peakInFlight, inFlight)
        const requestStartedAt = performance.now()
        try {
          return await client.sendRequest(method, params, { timeoutMs: 180_000 })
        } finally {
          inFlight -= 1
          if (method !== 'mobileWeb.package.manifest') {
            chunkRequests += 1
            latencies.push(performance.now() - requestStartedAt)
          }
        }
      },
      createDiscardingStager(),
      {
        shellBridgeVersion: MOBILE_WEB_BRIDGE_PROTOCOL_VERSION,
        useGzip: options.gzip,
        rangeBytes: options.rangeBytes,
        maxConcurrentRequests: options.maxConcurrentRequests
      }
    )
    const wallMs = performance.now() - startedAt
    client.close()
    return {
      ...options,
      totalBytes: downloaded.manifest.totalBytes,
      wallMs,
      bytesPerSecond: downloaded.manifest.totalBytes / (wallMs / 1000),
      chunkRequests,
      wireBytesToPhone,
      latencyMedianMs: percentile(latencies, 0.5),
      latencyP95Ms: percentile(latencies, 0.95),
      peakInFlight
    }
  } finally {
    for (const dispose of teardown.toReversed()) {
      await dispose()
    }
  }
}

async function openRelayClient(args: {
  wiring: MobileSocketWiring
  relayEndpoint: MobileRelayEndpoint
  relayHostId: string
  relayDeviceId: string
  deviceToken: string
  desktopPublicKeyB64: string
  oneWayDelayMs: number
  teardown: Teardown
  countInbound: (bytes: number) => void
}): Promise<RpcClient> {
  const relayServer = new WebSocketServer({ host: '127.0.0.1', port: 0, perMessageDeflate: false })
  const port = await listen(relayServer, args.teardown)

  let hostSocket: WebSocket | null = null
  let phoneSocket: WebSocket | null = null
  const splice = (): void => {
    if (!hostSocket || !phoneSocket) {
      return
    }
    const host = hostSocket
    const phone = phoneSocket
    host.on('message', (raw, isBinary) => {
      args.countInbound(rawByteLength(raw))
      forward(phone, raw, isBinary, args.oneWayDelayMs)
    })
    phone.on('message', (raw, isBinary) => forward(host, raw, isBinary, args.oneWayDelayMs))
    phone.send(
      JSON.stringify({
        type: 'relay-hello',
        ok: true,
        credentialKind: 'resume',
        leaseExpiresAt: Date.now() + 900_000,
        acceptedCredentialVersion: 3,
        acceptedAs: 'current',
        resumeExpiresAt: Date.now() + 900_000
      })
    )
  }
  relayServer.on('connection', (socket, request) => {
    socket.once('message', () => {
      if (request.url === '/v1/host/data/connection-1') {
        hostSocket = socket
      } else {
        phoneSocket = socket
      }
      splice()
    })
  })

  const transport = new CloudRelayTransport({
    cellUrl: `http://127.0.0.1:${port}`,
    relayHostId: args.relayHostId,
    generation: 1
  })
  args.teardown.push(() => transport.stop())
  args.wiring.attachTransport(transport, (socket) => transport.metadataFor(socket))
  await transport.start()
  await transport.openConnection({
    connId: 'connection-1',
    connTicket: 'A'.repeat(43),
    kind: 'resume',
    relayDeviceId: args.relayDeviceId,
    attachDeadlineMs: 15_000
  })

  const session = connectMobileRelayRpcSession({
    relay: args.relayEndpoint,
    resumeToken: 'B'.repeat(43),
    resumeCredentialVersion: 3,
    resumeConfirmReqId: 'measure-confirm',
    deviceToken: args.deviceToken,
    desktopPublicKeyB64: args.desktopPublicKeyB64,
    requestTimeoutMs: 180_000,
    createSocket: () =>
      new WebSocketClient(`ws://127.0.0.1:${port}/v1/connect/${args.relayHostId}`, {
        perMessageDeflate: false,
        maxPayload: 16 * 1024 * 1024
      }) as unknown as globalThis.WebSocket
  })
  args.teardown.push(() => session.close())
  await waitFor(() => session.getState() === 'connected', 30_000, 'relay session connect')
  return session
}

async function openDirectClient(args: {
  wiring: MobileSocketWiring
  deviceToken: string
  desktopPublicKeyB64: string
  oneWayDelayMs: number
  teardown: Teardown
  countInbound: (bytes: number) => void
}): Promise<RpcClient> {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0, perMessageDeflate: false })
  const port = await listen(server, args.teardown)
  args.wiring.attachTransport(
    createDirectLoopbackTransport(server, args.oneWayDelayMs, args.countInbound)
  )
  const client = connectDirectRpcClient(
    `ws://127.0.0.1:${port}`,
    args.deviceToken,
    args.desktopPublicKeyB64
  )
  args.teardown.push(() => client.close())
  await waitFor(() => client.getState() === 'connected', 30_000, 'direct client connect')
  return client
}

function createDirectLoopbackTransport(
  server: WebSocketServer,
  oneWayDelayMs: number,
  countInbound: (bytes: number) => void
): MobileSocketTransport {
  type MessageHandler = (
    message: string | Uint8Array,
    reply: (response: string) => void,
    ws: WebSocket
  ) => void
  const messageHandlers: MessageHandler[] = []
  const closeHandlers: ((clientId: string | null, ws: WebSocket, other: boolean) => void)[] = []
  const clientIds = new Map<WebSocket, string>()
  server.on('connection', (socket) => {
    // Why: the desktop replies through E2EEChannel's own ws.send, so the outbound hop is
    // delayed by wrapping send rather than by a forwarding splice like the relay path has.
    delaySocketSend(socket, oneWayDelayMs, countInbound)
    socket.on('message', (raw, isBinary) => {
      const message = isBinary ? toBytes(raw) : raw.toString('utf8')
      after(oneWayDelayMs, () => {
        for (const handler of messageHandlers) {
          handler(message, () => {}, socket)
        }
      })
    })
    socket.on('close', () => {
      const clientId = clientIds.get(socket) ?? null
      clientIds.delete(socket)
      for (const handler of closeHandlers) {
        handler(clientId, socket, false)
      }
    })
  })
  return {
    onMessage: (handler) => messageHandlers.push(handler),
    onConnectionClose: (handler) => closeHandlers.push(handler),
    setClientId: (ws, clientId) => clientIds.set(ws, clientId),
    terminateClientConnections: (clientId) => {
      let terminated = 0
      for (const [socket, id] of clientIds) {
        if (id === clientId) {
          socket.terminate()
          terminated += 1
        }
      }
      return terminated
    }
  }
}

function delaySocketSend(
  socket: WebSocket,
  oneWayDelayMs: number,
  countInbound: (bytes: number) => void
): void {
  const send = socket.send.bind(socket)
  socket.send = ((data: string | Uint8Array, ...rest: unknown[]) => {
    countInbound(typeof data === 'string' ? Buffer.byteLength(data) : data.byteLength)
    after(oneWayDelayMs, () => {
      if (socket.readyState === socket.OPEN) {
        ;(send as (...values: unknown[]) => void)(data, ...rest)
      }
    })
  }) as typeof socket.send
}

function forward(socket: WebSocket, raw: RawData, isBinary: boolean, oneWayDelayMs: number): void {
  after(oneWayDelayMs, () => {
    if (socket.readyState === socket.OPEN) {
      socket.send(raw, { binary: isBinary })
    }
  })
}

function after(delayMs: number, run: () => void): void {
  if (delayMs <= 0) {
    queueMicrotask(run)
    return
  }
  setTimeout(run, delayMs)
}

async function listen(server: WebSocketServer, teardown: Teardown): Promise<number> {
  await new Promise<void>((resolve) => server.once('listening', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('expected a TCP address')
  }
  teardown.push(
    () =>
      new Promise<void>((resolve) => {
        for (const socket of server.clients) {
          socket.terminate()
        }
        server.close(() => resolve())
      })
  )
  return address.port
}

function createDiscardingStager(): MobileWebPackageStager<{ buildId: string }> {
  return {
    async begin() {},
    async writeAssetChunk() {},
    async finishAsset() {},
    async commit(manifest) {
      return { buildId: manifest.buildId }
    },
    async abort() {}
  }
}

function settle(id: string, operation: Promise<unknown>, reply: (response: string) => void): void {
  void operation.then(
    (result) => reply(rpcSuccess(id, result)),
    (error: unknown) =>
      reply(
        JSON.stringify({
          id,
          ok: false,
          error: { code: 'invalid_argument', message: String((error as Error).message) },
          _meta: { runtimeId: 'measure-runtime' }
        })
      )
  )
}

function rpcSuccess(id: string, result: unknown): string {
  return JSON.stringify({ id, ok: true, result, _meta: { runtimeId: 'measure-runtime' } })
}

function rawByteLength(raw: RawData): number {
  return typeof raw === 'string' ? Buffer.byteLength(raw) : toBytes(raw).byteLength
}

function toBytes(raw: RawData): Uint8Array {
  if (Array.isArray(raw)) {
    return Buffer.concat(raw)
  }
  return raw instanceof ArrayBuffer ? new Uint8Array(raw) : new Uint8Array(raw as Buffer)
}

function percentile(values: number[], fraction: number): number {
  if (values.length === 0) {
    return 0
  }
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.min(sorted.length - 1, Math.floor(fraction * (sorted.length - 1)))]!
}

async function waitFor(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`timed out waiting for ${label}`)
}
