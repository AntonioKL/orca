import { writeFileSync } from 'node:fs'

/** Persist the benchmark report so a passing run cannot silently lose its artifact. */
export function writeTerminalSplitLatencyArtifact(outputPath: string, body: string): void {
  try {
    writeFileSync(outputPath, body, 'utf8')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(
      `[terminal-split-activation-latency] unable to write ${outputPath}: ${message}`,
      { cause: error }
    )
  }
}
