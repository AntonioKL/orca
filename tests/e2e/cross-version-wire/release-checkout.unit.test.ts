import { execFileSync, spawn } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { lock } from 'proper-lockfile'
import { afterEach, describe, expect, it } from 'vitest'
import {
  importReleaseCheckoutModule,
  materializeReleaseCheckout,
  REPO_ROOT,
  type ReleaseCheckout
} from './release-checkout'
const temporaryRoots: string[] = []

function temporaryCacheRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'orca-cross-version-checkout-'))
  temporaryRoots.push(root)
  return root
}

function git(args: string[]): string {
  return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
}

function syntheticCheckout(): ReleaseCheckout {
  // Why realpath: vite-node reports module urls through macOS's /var -> /private/var
  // symlink, so provenance assertions need the resolved form.
  const root = realpathSync(temporaryCacheRoot())
  return { ref: 'v0.0.0-synthetic', commit: 'f'.repeat(40), label: 'v0.0.0-synthetic', root }
}

function waitForFile(path: string, timeoutMs: number): Promise<void> {
  const startedAt = Date.now()
  return new Promise((resolvePoll, rejectPoll) => {
    const poll = (): void => {
      if (existsSync(path)) {
        resolvePoll()
        return
      }
      if (Date.now() - startedAt > timeoutMs) {
        rejectPoll(new Error(`Timed out after ${timeoutMs}ms waiting for ${path}`))
        return
      }
      setTimeout(poll, 25)
    }
    poll()
  })
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('release checkout materialization', () => {
  it('single-flights concurrent consumers of one release identity', async () => {
    const cacheRoot = temporaryCacheRoot()
    const checkouts = await Promise.all([
      materializeReleaseCheckout('v1.4.190', { cacheRoot }),
      materializeReleaseCheckout('v1.4.190', { cacheRoot }),
      materializeReleaseCheckout('v1.4.190', { cacheRoot })
    ])

    expect(new Set(checkouts.map(({ root }) => root))).toHaveLength(1)
    expect(relative(cacheRoot, checkouts[0]!.root)).not.toMatch(/^\.\./)
  })

  it('loads a baseline module whose source imports another checkout-root file', async () => {
    const cacheRoot = temporaryCacheRoot()
    const checkout = await materializeReleaseCheckout('v1.4.190', { cacheRoot })
    const protocol = await importReleaseCheckoutModule(checkout, '/src/shared/protocol-version.ts')

    expect(protocol.REMOTE_SERVER_UPDATE_CAPABILITY).toBe('updater.remote-control.v1')
    expect(relative(cacheRoot, checkout.root)).not.toMatch(/^\.\./)
  })

  it('keeps an import live while another colliding release label materializes', async () => {
    const merge = git(['rev-list', '--merges', '-1', 'HEAD'])
    const firstRef = `${merge}~2`
    const secondRef = `${merge}^2`
    expect(git(['rev-parse', `${firstRef}^{commit}`])).not.toBe(
      git(['rev-parse', `${secondRef}^{commit}`])
    )

    const cacheRoot = temporaryCacheRoot()
    const first = await materializeReleaseCheckout(firstRef, { cacheRoot })
    const dependency = join(first.root, 'delayed-dependency.mjs')
    const entry = join(first.root, 'delayed-entry.mjs')
    writeFileSync(dependency, "export const loaded = 'first-release'\n")
    writeFileSync(
      entry,
      'await new Promise((resolve) => setTimeout(resolve, 100))\n' +
        "export const loaded = (await import('./delayed-dependency.mjs')).loaded\n"
    )

    const loading = importReleaseCheckoutModule(first, '/delayed-entry.mjs')
    const second = await materializeReleaseCheckout(secondRef, { cacheRoot })

    await expect(loading).resolves.toMatchObject({ loaded: 'first-release' })
    expect(first.root).not.toBe(second.root)
  })

  it('never lets a rival materializer process replace a published in-use checkout', async () => {
    const cacheRoot = temporaryCacheRoot()
    const scratch = temporaryCacheRoot()
    const published = await materializeReleaseCheckout('v1.4.190', { cacheRoot })
    const sentinel = join(published.root, 'in-use-sentinel.mjs')
    writeFileSync(sentinel, "export const sentinel = 'published-tree'\n")

    // Recreate the interleaving the lock exists for: the rival's stamp check
    // happens while nothing is published and the single-flight lock is held by
    // the extracting process. The rival must wait, re-check, and walk away —
    // never delete the tree published in the meantime.
    const aside = join(scratch, 'published-aside')
    renameSync(published.root, aside)
    const releaseLock = await lock(published.root, { realpath: false, stale: 60_000 })

    const enteredMarker = join(scratch, 'rival-entered')
    const resultPath = join(scratch, 'rival-result.json')
    const rivalScript = join(scratch, 'rival-materializer.mjs')
    const harnessUrl = new URL('./release-checkout.ts', import.meta.url).href
    writeFileSync(
      rivalScript,
      [
        `const { existsSync, writeFileSync } = await import('node:fs')`,
        `const harness = await import(${JSON.stringify(harnessUrl)})`,
        `if (existsSync(${JSON.stringify(published.root)})) {`,
        `  writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify({ error: 'already published: contention never happened' }))`,
        `  process.exit(1)`,
        `}`,
        `writeFileSync(${JSON.stringify(enteredMarker)}, '')`,
        `try {`,
        `  const checkout = await harness.materializeReleaseCheckout('v1.4.190', { cacheRoot: ${JSON.stringify(cacheRoot)} })`,
        `  writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify({ root: checkout.root }))`,
        `} catch (error) {`,
        `  writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify({ error: String(error) }))`,
        `  process.exit(1)`,
        `}`,
        ''
      ].join('\n')
    )

    // Why plain node: the rival must contend from another OS process through the
    // real lockfile — in-process rivals serialize at the sync sections and can
    // never reach the deletion the lock prevents.
    const rival = spawn(process.execPath, [rivalScript], {
      cwd: REPO_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NODE_OPTIONS: '' }
    })
    let rivalOutput = ''
    rival.stdout.on('data', (chunk) => {
      rivalOutput += String(chunk)
    })
    rival.stderr.on('data', (chunk) => {
      rivalOutput += String(chunk)
    })
    const rivalExit = new Promise<number | null>((resolveExit) => {
      rival.on('close', resolveExit)
    })

    let released = false
    const releaseOnce = async (): Promise<void> => {
      if (!released) {
        released = true
        await releaseLock()
      }
    }
    try {
      await waitForFile(enteredMarker, 30_000)
      // The marker follows the rival's own unpublished check, so its stamp check
      // cannot have seen this publish; by now it is blocked on the lock (or, with
      // the single-flight ablated, already extracting its replacement).
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_500))
      renameSync(aside, published.root)
      const consuming = importReleaseCheckoutModule(published, '/in-use-sentinel.mjs')
      await releaseOnce()

      const exitCode = await rivalExit
      const result = JSON.parse(readFileSync(resultPath, 'utf8')) as Record<string, unknown>
      expect(result, rivalOutput).toEqual({ root: published.root })
      expect(exitCode, rivalOutput).toBe(0)
      await expect(consuming).resolves.toMatchObject({ sentinel: 'published-tree' })
      expect(existsSync(sentinel)).toBe(true)
    } finally {
      await releaseOnce()
      if (rival.exitCode === null) {
        rival.kill('SIGKILL')
      }
    }
  }, 120_000)
})

describe('release checkout module importer', () => {
  it('hands the importer a raw absolute forward-slash specifier, never a file URL', async () => {
    const checkout = syntheticCheckout()
    const captured: string[] = []
    const capture = (specifier: string): Promise<Record<string, unknown>> => {
      captured.push(specifier)
      return Promise.resolve({})
    }

    await importReleaseCheckoutModule(checkout, '/src/main/runtime/rpc/dispatcher.ts', capture)
    await importReleaseCheckoutModule(checkout, '\\src\\shared\\protocol-version.ts', capture)

    const normalizedRoot = checkout.root.split('\\').join('/')
    expect(captured).toEqual([
      `${normalizedRoot}/src/main/runtime/rpc/dispatcher.ts`,
      `${normalizedRoot}/src/shared/protocol-version.ts`
    ])
    for (const specifier of captured) {
      expect(specifier).not.toMatch(/^file:/)
      expect(specifier).not.toContain('\\')
    }
  })

  it('refuses module paths that escape the checkout root', () => {
    const checkout = syntheticCheckout()
    const escape = /stay inside the release checkout/
    expect(() => importReleaseCheckoutModule(checkout, '/src/../../escape.ts')).toThrow(escape)
    expect(() => importReleaseCheckoutModule(checkout, '..')).toThrow(escape)
    expect(() => importReleaseCheckoutModule(checkout, '')).toThrow(escape)
  })

  it('anchors root-relative modules to the checkout root, never the working tree', async () => {
    const checkout = syntheticCheckout()
    mkdirSync(join(checkout.root, 'src'), { recursive: true })
    writeFileSync(
      join(checkout.root, 'src', 'provenance-probe.mjs'),
      'export const moduleUrl = import.meta.url\n'
    )

    const probe = await importReleaseCheckoutModule(checkout, '/src/provenance-probe.mjs')
    expect(String(probe.moduleUrl)).toContain(checkout.root.split('\\').join('/'))

    // The working tree has this module and the synthetic checkout does not:
    // resolving it would mean a root-relative specifier silently ran current
    // code as the "old" side — the exact poison this harness exists to prevent.
    await expect(
      importReleaseCheckoutModule(checkout, '/src/shared/protocol-version.ts')
    ).rejects.toThrow()
  })
})
