import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  importReleaseCheckoutModule,
  materializeReleaseCheckout,
  REPO_ROOT
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
})
