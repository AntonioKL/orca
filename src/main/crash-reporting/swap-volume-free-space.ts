import { statfs } from 'node:fs/promises'
import path from 'node:path'

// Why: a system-managed Windows pagefile only grows into free space on its own
// volume, so low available commit means a REFUSED allocation only when that
// volume is also full — otherwise Windows just expands the pagefile. macOS
// grows swapfiles on the boot volume the same way. Without this number, "commit
// was low" and "commit was refused" are indistinguishable in a crash report.

const BYTES_PER_MB = 1024 * 1024

type SwapVolumeFreeSpaceReader = () => Promise<number | undefined>

function swapVolumeAnchor(): string {
  // SystemRoot names the pagefile's volume on Windows; elsewhere swap is on the root fs.
  const anchor = process.env.SystemRoot || process.env.SystemDrive || path.sep
  return path.parse(anchor).root || anchor
}

async function readVolumeFreeSpaceMB(): Promise<number | undefined> {
  try {
    const stats = await statfs(swapVolumeAnchor())
    const bytes = Number(stats.bsize) * Number(stats.bavail)
    return Number.isFinite(bytes) ? Math.round(Math.max(0, bytes) / BYTES_PER_MB) : undefined
  } catch {
    return undefined
  }
}

let swapVolumeFreeSpaceReader: SwapVolumeFreeSpaceReader = readVolumeFreeSpaceMB

export function setSwapVolumeFreeSpaceReaderForTest(
  reader: SwapVolumeFreeSpaceReader | null
): void {
  swapVolumeFreeSpaceReader = reader ?? readVolumeFreeSpaceMB
}

export function readSwapVolumeFreeSpaceMB(): Promise<number | undefined> {
  return swapVolumeFreeSpaceReader()
}
