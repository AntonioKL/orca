import manifest from '../../config/relay-assets/windows-process-tree/manifest.json' with { type: 'json' }

export const WINDOWS_PROCESS_TREE_RELAY_ARCHES = ['x64', 'arm64'] as const
export type WindowsProcessTreeRelayArch = (typeof WINDOWS_PROCESS_TREE_RELAY_ARCHES)[number]

export const WINDOWS_PROCESS_TREE_RELAY_CONTRACT_VERSION = 1
export const WINDOWS_PROCESS_TREE_RELAY_PACKAGE = '@vscode/windows-process-tree@0.8.0'

type WindowsProcessTreeRelayManifest = {
  contractVersion?: unknown
  package?: unknown
  binaries?: Record<string, { sha256?: unknown } | undefined>
}

type ValidatedWindowsProcessTreeRelayManifest = {
  contractVersion: number
  package: string
  binaries: Record<WindowsProcessTreeRelayArch, { sha256: string }>
}

function validateManifest(
  candidate: WindowsProcessTreeRelayManifest
): ValidatedWindowsProcessTreeRelayManifest {
  if (candidate.contractVersion !== WINDOWS_PROCESS_TREE_RELAY_CONTRACT_VERSION) {
    throw new Error(
      `Windows process-tree relay manifest contractVersion must be ${WINDOWS_PROCESS_TREE_RELAY_CONTRACT_VERSION}.`
    )
  }
  if (candidate.package !== WINDOWS_PROCESS_TREE_RELAY_PACKAGE) {
    throw new Error(
      `Windows process-tree relay manifest package must be ${WINDOWS_PROCESS_TREE_RELAY_PACKAGE}.`
    )
  }
  for (const arch of WINDOWS_PROCESS_TREE_RELAY_ARCHES) {
    const sha256 = candidate.binaries?.[arch]?.sha256
    if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256)) {
      throw new Error(`Windows process-tree relay manifest has no valid ${arch} SHA-256.`)
    }
  }
  return candidate as ValidatedWindowsProcessTreeRelayManifest
}

const validatedManifest = validateManifest(manifest)

export function windowsProcessTreeRelaySha256(arch: WindowsProcessTreeRelayArch): string {
  return validatedManifest.binaries[arch].sha256
}
