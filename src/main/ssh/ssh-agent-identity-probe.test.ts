import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { probeAgentIdentityCount } from './ssh-agent-identity-probe'

const SSH_AGENT_IDENTITIES_ANSWER = 12
const SSH_AGENT_FAILURE = 5

function sshString(payload: Buffer): Buffer {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(payload.length)
  return Buffer.concat([length, payload])
}

function agentMessage(body: Buffer): Buffer {
  return sshString(body)
}

/** A well-formed ed25519 blob: the probe only counts what ssh2 can parse. */
function ed25519KeyBlob(): Buffer {
  return Buffer.concat([sshString(Buffer.from('ssh-ed25519')), sshString(randomBytes(32))])
}

function identitiesAnswer(keyCount: number): Buffer {
  const header = Buffer.alloc(5)
  header.writeUInt8(SSH_AGENT_IDENTITIES_ANSWER, 0)
  header.writeUInt32BE(keyCount, 1)
  const keys = Array.from({ length: keyCount }, () =>
    Buffer.concat([sshString(ed25519KeyBlob()), sshString(Buffer.from('probe@test'))])
  )
  return agentMessage(Buffer.concat([header, ...keys]))
}

const openServers: Server[] = []
const openSockets: Socket[] = []
const tempDirs: string[] = []

function agentSocketPath(): string {
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\orca-agent-probe-${randomBytes(6).toString('hex')}`
  }
  const dir = mkdtempSync(join(tmpdir(), 'oa'))
  tempDirs.push(dir)
  return join(dir, 'a.sock')
}

async function startFakeAgent(onRequest: (socket: Socket) => void): Promise<string> {
  const socketPath = agentSocketPath()
  const server = createServer((socket) => {
    openSockets.push(socket)
    socket.once('data', () => onRequest(socket))
  })
  openServers.push(server)
  await new Promise<void>((resolve) => server.listen(socketPath, resolve))
  return socketPath
}

afterEach(async () => {
  for (const socket of openSockets.splice(0)) {
    socket.destroy()
  }
  await Promise.all(
    openServers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
  )
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('probeAgentIdentityCount', () => {
  it('reports zero for an agent that answers with no identities', async () => {
    const socketPath = await startFakeAgent((socket) => socket.end(identitiesAnswer(0)))

    await expect(probeAgentIdentityCount(socketPath)).resolves.toBe(0)
  })

  it('reports the identity count for a populated agent', async () => {
    const socketPath = await startFakeAgent((socket) => socket.end(identitiesAnswer(2)))

    await expect(probeAgentIdentityCount(socketPath)).resolves.toBe(2)
  })

  it('reports unknown, not zero, when the agent refuses', async () => {
    const socketPath = await startFakeAgent((socket) =>
      socket.end(agentMessage(Buffer.from([SSH_AGENT_FAILURE])))
    )

    await expect(probeAgentIdentityCount(socketPath)).resolves.toBeUndefined()
  })

  it('reports unknown, not zero, when the agent hangs up without answering', async () => {
    const socketPath = await startFakeAgent((socket) => socket.destroy())

    await expect(probeAgentIdentityCount(socketPath)).resolves.toBeUndefined()
  })

  it('reports unknown, not zero, when the agent never answers', async () => {
    const socketPath = await startFakeAgent(() => {})

    await expect(probeAgentIdentityCount(socketPath, 50)).resolves.toBeUndefined()
  })

  it('reports unknown, not zero, when there is no agent at the path', async () => {
    await expect(probeAgentIdentityCount(agentSocketPath())).resolves.toBeUndefined()
  })
})
