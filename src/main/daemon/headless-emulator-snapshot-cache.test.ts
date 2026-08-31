import { afterEach, describe, expect, it, vi } from 'vitest'
import { HeadlessEmulator } from './headless-emulator'

// Why this suite: attach latency is dominated by serializing the full buffer,
// so getSnapshot memoizes on a mutation epoch. A missed invalidation would
// hand a viewer a stale terminal, so every mutator gets its own case.
let emulator: HeadlessEmulator | undefined

afterEach(() => {
  emulator?.dispose()
  emulator = undefined
})

/** Counts real serializations so a "cache hit" claim is proven, not implied. */
function spyOnSerialize(target: HeadlessEmulator): { calls: () => number } {
  const serializer = (
    target as unknown as { serializer: { serialize: (...args: never[]) => string } }
  ).serializer
  const spy = vi.spyOn(serializer, 'serialize')
  return { calls: () => spy.mock.calls.length }
}

describe('HeadlessEmulator snapshot cache', () => {
  it('serves a repeated snapshot without re-serializing', async () => {
    emulator = new HeadlessEmulator({ cols: 80, rows: 24 })
    await emulator.write('hello world')
    const first = emulator.getSnapshot()
    const serialize = spyOnSerialize(emulator)

    const second = emulator.getSnapshot()

    expect(serialize.calls()).toBe(0)
    expect(second.snapshotAnsi).toBe(first.snapshotAnsi)
    expect(second.scrollbackAnsi).toBe(first.scrollbackAnsi)
  })

  it('re-serializes for a different scrollbackRows window', async () => {
    emulator = new HeadlessEmulator({ cols: 80, rows: 24 })
    await emulator.write('hello world')
    emulator.getSnapshot({ scrollbackRows: 100 })
    const serialize = spyOnSerialize(emulator)

    emulator.getSnapshot({ scrollbackRows: 500 })

    expect(serialize.calls()).toBeGreaterThan(0)
  })

  it('reflects an async write that lands after a cached snapshot', async () => {
    emulator = new HeadlessEmulator({ cols: 80, rows: 24 })
    await emulator.write('first line')
    expect(emulator.getSnapshot().snapshotAnsi).toContain('first line')

    await emulator.write('\r\nsecond line')

    const snapshot = emulator.getSnapshot()
    expect(snapshot.snapshotAnsi).toContain('second line')
  })

  it('invalidates on resize', async () => {
    emulator = new HeadlessEmulator({ cols: 80, rows: 24 })
    await emulator.write('sized')
    expect(emulator.getSnapshot().cols).toBe(80)

    emulator.resize(120, 40)

    const snapshot = emulator.getSnapshot()
    expect(snapshot.cols).toBe(120)
    expect(snapshot.rows).toBe(40)
  })

  it('invalidates on clearScrollback', async () => {
    emulator = new HeadlessEmulator({ cols: 80, rows: 24 })
    for (let i = 0; i < 60; i++) {
      await emulator.write(`line ${i}\r\n`)
    }
    expect(emulator.getSnapshot().snapshotAnsi).toContain('line 0')

    emulator.clearScrollback()

    expect(emulator.getSnapshot().snapshotAnsi).not.toContain('line 0')
  })

  it('invalidates on cwd and title changes', async () => {
    emulator = new HeadlessEmulator({ cols: 80, rows: 24 })
    await emulator.write('x')
    expect(emulator.getSnapshot().cwd).toBeNull()

    emulator.setCwd('/tmp/project')
    expect(emulator.getSnapshot().cwd).toBe('/tmp/project')

    emulator.setLastTitle('agent running')
    expect(emulator.getSnapshot().lastTitle).toBe('agent running')
  })

  it('invalidates on restored osc links', async () => {
    emulator = new HeadlessEmulator({ cols: 80, rows: 24 })
    await emulator.write('link target')
    expect(emulator.getSnapshot().oscLinks).toEqual([])

    emulator.setRestoredOscLinks([{ row: 0, startCol: 0, endCol: 4, uri: 'https://example.com' }])

    expect(emulator.getSnapshot().oscLinks?.length ?? 0).toBeGreaterThan(0)
  })

  it('never hands out aliases into the retained cache entry', async () => {
    emulator = new HeadlessEmulator({ cols: 80, rows: 24 })
    await emulator.write('aliasing check')
    emulator.setRestoredOscLinks([{ row: 0, startCol: 0, endCol: 4, uri: 'https://example.com' }])

    const first = emulator.getSnapshot()
    const originalUri = first.oscLinks?.[0]?.uri
    first.oscLinks?.push({ row: 9, startCol: 0, endCol: 1, uri: 'https://injected' })
    const firstLink = first.oscLinks?.[0]
    if (firstLink) {
      firstLink.uri = 'https://mutated'
    }
    ;(first.modes as { alternateScreen: boolean }).alternateScreen = true

    const second = emulator.getSnapshot()
    expect(second.oscLinks).toHaveLength(1)
    expect(second.oscLinks?.[0]?.uri).toBe(originalUri)
    expect(second.modes.alternateScreen).toBe(false)
  })

  it('keeps the cache warm across a zero-byte parse fence', async () => {
    // Why: flushParsedWrites() is write(''), and every getSettledSnapshot runs
    // one. Bumping on it would evict the attach entry on each checkpoint read.
    emulator = new HeadlessEmulator({ cols: 80, rows: 24 })
    await emulator.write('fenced output')
    emulator.getSnapshot()
    const serialize = spyOnSerialize(emulator)

    await emulator.write('')

    emulator.getSnapshot()
    expect(serialize.calls()).toBe(0)
  })

  it('still reflects writes that a fence follows', async () => {
    emulator = new HeadlessEmulator({ cols: 80, rows: 24 })
    await emulator.write('before fence')
    emulator.getSnapshot()

    const pending = emulator.write('\r\nafter fence')
    await emulator.write('')
    await pending

    expect(emulator.getSnapshot().snapshotAnsi).toContain('after fence')
  })

  it('invalidates on dispose so a post-dispose read is never served the cache', async () => {
    const disposable = new HeadlessEmulator({ cols: 80, rows: 24 })
    await disposable.write('pre dispose')
    disposable.getSnapshot()
    const serialize = spyOnSerialize(disposable)

    disposable.dispose()

    expect(serialize.calls()).toBe(0)
  })

  // Why this guard: the cache's correctness rests on every mutator calling
  // markMutated(), which is convention, not a type. Freezing the public surface
  // makes a new method a deliberate decision about invalidation rather than a
  // silent stale-snapshot bug.
  it('has no unreviewed public methods that could mutate state', () => {
    emulator = new HeadlessEmulator({ cols: 80, rows: 24 })
    const surface = Object.getOwnPropertyNames(HeadlessEmulator.prototype)
      .filter((name) => name !== 'constructor')
      .sort()
    expect(surface).toEqual(
      [
        'applyKittyKeyboardFlags',
        'applyPushedViewAttributes',
        'clearScrollback',
        'disableQueryReplyForwarding',
        'dispose',
        'getAppliedSize',
        'getBufferTailLines',
        'getCursorLineContext',
        'getCwd',
        'getModes',
        'getSnapshot',
        'getVisibleBufferRange',
        'getVisibleLines',
        'installConptyPrimaryDeviceAttributesOverride',
        'installViewAttributeResponder',
        'isAlternateScreen',
        'isCursorOnEmptyPromptLine',
        'markMutated',
        'markWritten',
        'partialEscapeTailAnsi',
        'emitQueryReply',
        'resize',
        'responderParser',
        'setCwd',
        'setLastTitle',
        'setRestoredOscLinks',
        'write',
        'writeSync',
        'tryWriteSync'
      ].sort()
    )
  })
})
