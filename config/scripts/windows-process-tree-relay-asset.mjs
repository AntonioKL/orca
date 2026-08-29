import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { RELAY_WINDOWS_PROCESS_TREE_FILENAME } from '../../src/shared/relay-artifacts.ts'
import {
  windowsProcessTreeRelaySha256,
  WINDOWS_PROCESS_TREE_RELAY_ARCHES
} from '../../src/shared/windows-process-tree-relay-manifest.ts'

const ROOT = resolve(import.meta.dirname, '..', '..')
export const WINDOWS_PROCESS_TREE_RELAY_ASSET_DIR = join(
  ROOT,
  'config',
  'relay-assets',
  'windows-process-tree'
)

const PE_MACHINE = { x64: 0x8664, arm64: 0xaa64 }

function assertSupportedArch(arch) {
  if (!WINDOWS_PROCESS_TREE_RELAY_ARCHES.includes(arch)) {
    throw new Error(
      `Windows process-tree relay architecture must be ${WINDOWS_PROCESS_TREE_RELAY_ARCHES.join(' or ')}; got ${arch}.`
    )
  }
}

export function windowsProcessTreeRelayAssetPath(arch) {
  assertSupportedArch(arch)
  return join(WINDOWS_PROCESS_TREE_RELAY_ASSET_DIR, arch, RELAY_WINDOWS_PROCESS_TREE_FILENAME)
}

export function readWindowsProcessTreePeMachine(bytes, label = 'Windows process-tree binary') {
  if (bytes.length < 0x40 || bytes.readUInt16LE(0) !== 0x5a4d) {
    throw new Error(`${label} has no valid DOS header.`)
  }
  const peOffset = bytes.readUInt32LE(0x3c)
  if (peOffset > bytes.length - 6 || bytes.readUInt32LE(peOffset) !== 0x00004550) {
    throw new Error(`${label} has no valid PE header.`)
  }
  return bytes.readUInt16LE(peOffset + 4)
}

export function assertWindowsProcessTreePeMachine(bytes, arch, label) {
  assertSupportedArch(arch)
  const machine = readWindowsProcessTreePeMachine(bytes, label)
  if (machine !== PE_MACHINE[arch]) {
    throw new Error(
      `${label} is machine 0x${machine.toString(16)}, expected 0x${PE_MACHINE[arch].toString(16)} for ${arch}.`
    )
  }
  return machine
}

export function validateWindowsProcessTreeRelayAsset(arch) {
  const binaryPath = windowsProcessTreeRelayAssetPath(arch)
  const bytes = readFileSync(binaryPath)
  assertWindowsProcessTreePeMachine(bytes, arch, binaryPath)
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const expectedSha256 = windowsProcessTreeRelaySha256(arch)
  if (sha256 !== expectedSha256) {
    throw new Error(
      `${binaryPath} has SHA-256 ${sha256}, but manifest.json requires ${expectedSha256}.`
    )
  }
  return { binaryPath, bytes, sha256 }
}

export function assertWindowsProcessTreeRelayBuildMatchesAsset(binaryPath, arch) {
  const reviewed = validateWindowsProcessTreeRelayAsset(arch)
  const builtBytes = readFileSync(binaryPath)
  assertWindowsProcessTreePeMachine(builtBytes, arch, binaryPath)
  if (!builtBytes.equals(reviewed.bytes)) {
    const builtSha256 = createHash('sha256').update(builtBytes).digest('hex')
    throw new Error(
      `${binaryPath} has SHA-256 ${builtSha256} and is not byte-identical to reviewed ${reviewed.binaryPath}.`
    )
  }
}
