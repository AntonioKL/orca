import { describe, expect, it } from 'vitest'
import {
  MAX_AUTOMATIC_DIFF_CHANGED_LINES,
  shouldLoadCombinedDiffOnDemand
} from './combined-diff-on-demand-load'

describe('combined diff on-demand loading', () => {
  it('defers diffs above the automatic changed-line limit', () => {
    expect(
      shouldLoadCombinedDiffOnDemand({
        added: MAX_AUTOMATIC_DIFF_CHANGED_LINES,
        removed: 1
      })
    ).toBe(true)
  })

  it('automatically loads diffs at the limit', () => {
    expect(
      shouldLoadCombinedDiffOnDemand({
        added: MAX_AUTOMATIC_DIFF_CHANGED_LINES - 500,
        removed: 500
      })
    ).toBe(false)
  })

  it('defers uncounted tracked text files, whose size is unknown', () => {
    // A capped status listing or a failed numstat leaves every tracked row
    // uncounted; auto-loading them is what froze Monaco before deferral.
    expect(shouldLoadCombinedDiffOnDemand({ path: 'src/generated/schema.ts' })).toBe(true)
  })

  it('defers untracked files whose line counts were skipped as too large', () => {
    expect(shouldLoadCombinedDiffOnDemand({ path: 'data/dump.json' })).toBe(true)
  })

  it('defers uncounted svgs, which render as text rather than a preview', () => {
    expect(shouldLoadCombinedDiffOnDemand({ path: 'assets/map.svg' })).toBe(true)
  })

  it('automatically loads uncounted images, which render as a preview', () => {
    expect(shouldLoadCombinedDiffOnDemand({ path: 'docs/Shot.PNG' })).toBe(false)
  })

  it('automatically loads uncounted non-image binaries of any size', () => {
    expect(shouldLoadCombinedDiffOnDemand({ path: 'fixtures/sample.zip' })).toBe(false)
    expect(shouldLoadCombinedDiffOnDemand({ path: 'fonts/Inter.woff2' })).toBe(false)
    expect(shouldLoadCombinedDiffOnDemand({ path: 'bun.lockb' })).toBe(false)
  })

  it('defers diffs when only additions are reported', () => {
    expect(shouldLoadCombinedDiffOnDemand({ added: MAX_AUTOMATIC_DIFF_CHANGED_LINES + 1 })).toBe(
      true
    )
  })

  it('defers diffs when only removals are reported', () => {
    expect(shouldLoadCombinedDiffOnDemand({ removed: MAX_AUTOMATIC_DIFF_CHANGED_LINES + 1 })).toBe(
      true
    )
  })

  it('keeps counted binary-extension rows on the line-count rule', () => {
    expect(shouldLoadCombinedDiffOnDemand({ added: 3, path: 'fixtures/sample.zip' })).toBe(false)
    expect(
      shouldLoadCombinedDiffOnDemand({
        added: MAX_AUTOMATIC_DIFF_CHANGED_LINES + 1,
        path: 'fixtures/sample.zip'
      })
    ).toBe(true)
  })
})
