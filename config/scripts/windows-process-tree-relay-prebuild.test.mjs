import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  assertWindowsProcessTreePeMachine,
  assertWindowsProcessTreeRelayBuildMatchesAsset,
  validateWindowsProcessTreeRelayAsset
} from './windows-process-tree-relay-asset.mjs'

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
    expect(() => validateWindowsProcessTreeRelayAsset(arch)).not.toThrow()
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(manifest.binaries[arch].sha256)
    expect(peMachine(bytes)).toBe(machines[arch])
  })

  it('rejects a binary whose PE machine does not match its declared architecture', () => {
    const bytes = Buffer.from(readFileSync(binaryPath('x64')))
    const peOffset = bytes.readUInt32LE(0x3c)
    bytes.writeUInt16LE(machines.arm64, peOffset + 4)

    expect(() => assertWindowsProcessTreePeMachine(bytes, 'x64', 'fixture')).toThrow(
      /expected 0x8664 for x64/
    )
  })

  it('requires fresh builds to be byte-identical to the reviewed asset', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'orca-windows-process-tree-'))
    const builtPath = join(tempDir, 'windows-process-tree.node')
    const bytes = readFileSync(binaryPath('x64'))
    try {
      writeFileSync(builtPath, bytes)
      expect(() => assertWindowsProcessTreeRelayBuildMatchesAsset(builtPath, 'x64')).not.toThrow()

      const changed = Buffer.from(bytes)
      changed[changed.length - 1] ^= 1
      writeFileSync(builtPath, changed)
      expect(() => assertWindowsProcessTreeRelayBuildMatchesAsset(builtPath, 'x64')).toThrow(
        /not byte-identical/
      )
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
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
