import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const projectDir = resolve(import.meta.dirname, '../..')
const assetDir = join(projectDir, 'config', 'relay-assets', 'windows-process-tree')
const manifest = JSON.parse(readFileSync(join(assetDir, 'manifest.json'), 'utf8'))
const machines = { x64: 0x8664, arm64: 0xaa64 }

function binaryPath(arch) {
  return join(assetDir, arch, 'windows-process-tree.node')
}

function peMachine(bytes) {
  const peOffset = bytes.readUInt32LE(0x3c)
  return bytes.readUInt16LE(peOffset + 4)
}

describe('Windows process-table relay prebuilds', () => {
  it.each(['x64', 'arm64'])('pins the %s binary hash and machine', (arch) => {
    const bytes = readFileSync(binaryPath(arch))
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(manifest.binaries[arch].sha256)
    expect(peMachine(bytes)).toBe(machines[arch])
  })

  it.runIf(process.platform === 'win32' && process.arch in machines)(
    'loads the host-architecture prebuild and returns the required self fields',
    async () => {
      const addon = createRequire(import.meta.url)(binaryPath(process.arch))
      expect(addon.processTableContractVersion).toBe(manifest.contractVersion)
      const rows = await new Promise((resolve, reject) => {
        const deadline = setTimeout(
          () => reject(new Error('process-table callback timed out')),
          3_000
        )
        addon.getProcessList((result) => {
          clearTimeout(deadline)
          resolve(result)
        }, 7)
      })
      const self = rows.find((row) => row.pid === process.pid)
      expect(self).toMatchObject({
        memory: expect.any(Number),
        privateMemory: expect.any(Number),
        cpuTimeTicks: expect.stringMatching(/^\d+$/),
        startTimeId: expect.stringMatching(/^\d+$/),
        commandLine: expect.any(String)
      })
    }
  )
})
