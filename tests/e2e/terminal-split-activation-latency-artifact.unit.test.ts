import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { writeTerminalSplitLatencyArtifact } from './terminal-split-activation-latency-artifact'

const temporaryDirectories: string[] = []

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop()
    if (directory) {
      rmSync(directory, { recursive: true, force: true })
    }
  }
})

describe('writeTerminalSplitLatencyArtifact', () => {
  it('writes the report body to the requested path', () => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-split-latency-artifact-'))
    temporaryDirectories.push(directory)
    const outputPath = join(directory, 'report.json')
    const body = '{"status":"passed"}\n'

    writeTerminalSplitLatencyArtifact(outputPath, body)

    expect(existsSync(outputPath)).toBe(true)
    expect(readFileSync(outputPath, 'utf8')).toBe(body)
  })

  it('throws when the report path cannot be written', () => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-split-latency-artifact-'))
    temporaryDirectories.push(directory)
    const outputPath = join(directory, 'missing-parent', 'report.json')

    expect(() => writeTerminalSplitLatencyArtifact(outputPath, '{}')).toThrow(
      `[terminal-split-activation-latency] unable to write ${outputPath}`
    )
  })
})
