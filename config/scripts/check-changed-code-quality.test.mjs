import { describe, expect, it } from 'vitest'
import {
  OXLINT_SCANS,
  batchFilesByArgumentBytes,
  diagnosticTouchesAddedLines,
  isMovedCode,
  overlapsAddedLines,
  parseAddedLineRanges,
  runOxlintScan
} from './check-changed-code-quality.mjs'

describe('changed-code quality line matching', () => {
  it('parses added and replaced hunk ranges while ignoring deletions', () => {
    const ranges = parseAddedLineRanges(
      ['@@ -10,2 +10,3 @@', '@@ -20 +21 @@', '@@ -40,4 +42,0 @@', '@@ -50 +48,2 @@'].join('\n')
    )

    expect(ranges).toEqual([
      { start: 10, end: 12 },
      { start: 21, end: 21 },
      { start: 48, end: 49 }
    ])
  })

  it('matches diagnostics that overlap any added line', () => {
    const ranges = [
      { start: 5, end: 7 },
      { start: 12, end: 12 }
    ]

    expect(overlapsAddedLines(3, 5, ranges)).toBe(true)
    expect(overlapsAddedLines(8, 11, ranges)).toBe(false)
    expect(overlapsAddedLines(12, 14, ranges)).toBe(true)
  })

  it('normalizes absolute diagnostic paths before matching', () => {
    const root = process.cwd()
    const file = 'config/scripts/check-changed-code-quality.test.mjs'
    const diagnostic = {
      filename: `${root}/${file}`,
      labels: [{ span: { line: 24 } }]
    }

    expect(
      diagnosticTouchesAddedLines(diagnostic, new Map([[file, [{ start: 24, end: 24 }]]]), root)
    ).toBe(true)
  })

  // Why: pinning --config disables nested-config discovery, so root rules that
  // mobile/.oxlintrc.json turns off would fail the gate on mobile files.
  it('lets the untyped scan discover nested configs instead of pinning the root config', () => {
    const scan = OXLINT_SCANS.find((candidate) => candidate.label === 'code quality')

    expect(scan.args).not.toContain('--config')
    expect(scan.args).not.toContain('--disable-nested-config')
  })
})

describe('moved-code exemption', () => {
  it('treats a verbatim contiguous block from the base as moved', () => {
    const base = [['const a = 1', 'items.map((item, index) => (', 'key={index}', '))']]
    expect(isMovedCode(['items.map((item, index) => (', 'key={index}', '))'], base)).toBe(true)
  })

  it('ignores indentation and whitespace changes from the move', () => {
    const base = [['    items.map((item, index) => (', '      key={index}']]
    expect(isMovedCode(['items.map((item, index) => (', 'key={index}'], base)).toBe(true)
  })

  it('does not exempt a genuinely new violation', () => {
    const base = [['const a = 1', 'const b = 2']]
    expect(isMovedCode(['rows.map((row, i) => <td key={i} />)'], base)).toBe(false)
  })

  it('does not exempt a block that is only partly present in the base', () => {
    const base = [['doThing()', 'unrelated()']]
    expect(isMovedCode(['doThing()', 'newlyAddedSideEffect()'], base)).toBe(false)
  })

  it('tolerates a few lines appended inside the moved block', () => {
    // A split commonly grows a hook dependency array when closure variables
    // become props; the moved body around it is still moved.
    const body = Array.from({ length: 20 }, (_, i) => `line${i}()`)
    const base = [body]
    const moved = [...body.slice(0, 19), 'newDep,', body[19]]
    expect(isMovedCode(moved, base)).toBe(true)
  })

  it('does not exempt when the anchor line is absent from the base', () => {
    const base = [['doThing()', 'filler()', 'other()']]
    expect(isMovedCode(['brandNewCall()', 'doThing()', 'other()'], base)).toBe(false)
  })

  it('does not exempt when most of the block is absent from the base', () => {
    const base = [['keep0()', 'keep1()', 'unrelated()']]
    const mostlyNew = ['keep0()', ...Array.from({ length: 18 }, (_, i) => `fresh${i}()`)]
    expect(isMovedCode(mostlyNew, base)).toBe(false)
  })

  it('ignores blank lines when matching', () => {
    const base = [['a()', 'b()']]
    expect(isMovedCode(['a()', '', 'b()'], base)).toBe(true)
  })

  it('never exempts an empty highlight', () => {
    expect(isMovedCode(['', '   '], [['a()']])).toBe(false)
  })
})

describe('argument batching', () => {
  const argumentBytes = (batch) => batch.reduce((total, file) => total + file.length + 1, 0)
  // Large enough to exceed the real byte budget, so the batching that ships is what runs.
  const oversizedSet = Array.from(
    { length: 20000 },
    (_, index) => `src/generated/module-${index}.ts`
  )

  it('runs a normal changed set as a single invocation', () => {
    const files = Array.from({ length: 50 }, (_, index) => `src/renderer/src/module-${index}.tsx`)

    expect(batchFilesByArgumentBytes(files)).toEqual([files])
  })

  it('splits an oversized set into batches that each fit the limit', () => {
    const batches = batchFilesByArgumentBytes(oversizedSet)

    expect(batches.length).toBeGreaterThan(1)
    expect(batches.flat()).toEqual(oversizedSet)
    for (const batch of batches) {
      expect(argumentBytes(batch)).toBeLessThanOrEqual(256 * 1024)
    }
  })

  // Why: an empty argument list makes Oxlint lint the whole working directory.
  it('never emits an empty batch, even when the first path is longer than the limit', () => {
    const batches = batchFilesByArgumentBytes(['src/very-long-path.ts', 'src/a.ts'], 10)

    expect(batches.every((batch) => batch.length > 0)).toBe(true)
    expect(batches.flat()).toEqual(['src/very-long-path.ts', 'src/a.ts'])
  })

  it('counts multi-byte paths by their byte length, not their character count', () => {
    expect(batchFilesByArgumentBytes(['src/\u00e9.ts', 'src/b.ts'], 18)).toEqual([
      ['src/\u00e9.ts'],
      ['src/b.ts']
    ])
  })
})

describe('diagnostic collection across batches', () => {
  const scan = { label: 'code quality', args: [] }
  const diagnosticFor = (file) => ({ filename: file, message: `finding in ${file}` })
  const files = Array.from({ length: 20000 }, (_, index) => `src/generated/module-${index}.ts`)

  it('keeps the diagnostics of every batch, not just the last one', () => {
    const spawnBatch = (_root, _scan, batch) =>
      JSON.stringify({ diagnostics: batch.map(diagnosticFor) })

    expect(batchFilesByArgumentBytes(files).length).toBeGreaterThan(1)
    expect(runOxlintScan('/repo', scan, files, spawnBatch)).toEqual(files.map(diagnosticFor))
  })

  it('reports a finding that only a middle batch produces', () => {
    const batches = batchFilesByArgumentBytes(files)
    const failing = batches.at(Math.floor(batches.length / 2)).at(0)
    const spawnBatch = (_root, _scan, batch) =>
      JSON.stringify({ diagnostics: batch.includes(failing) ? [diagnosticFor(failing)] : [] })

    expect(batches.at(0)).not.toContain(failing)
    expect(batches.at(-1)).not.toContain(failing)
    expect(runOxlintScan('/repo', scan, files, spawnBatch)).toEqual([diagnosticFor(failing)])
  })

  // Why: the whole point is that no single invocation carries the full argument list.
  it('never hands the whole oversized set to one invocation', () => {
    const batchSizes = []
    const spawnBatch = (_root, _scan, batch) => {
      batchSizes.push(batch.length)
      return JSON.stringify({ diagnostics: [] })
    }
    runOxlintScan('/repo', scan, files, spawnBatch)

    expect(batchSizes.length).toBeGreaterThan(1)
    expect(Math.max(...batchSizes)).toBeLessThan(files.length)
  })
})
