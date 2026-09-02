import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parse } from 'yaml'

import {
  findCachedElevatePaths,
  replaceCachedElevateHelpers,
  resolveElectronBuilderCacheDir
} from './replace-cached-nsis-elevate.mjs'

const projectRoot = resolve(import.meta.dirname, '../..')
const scriptPath = join(projectRoot, 'config/scripts/replace-cached-nsis-elevate.mjs')

let scratch

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'orca elevate swap '))
})

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true })
})

function makeCache(...relativeFiles) {
  const cacheDir = join(scratch, 'Cache')
  for (const relative of relativeFiles) {
    const path = join(cacheDir, ...relative.split('/'))
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, 'unsigned-elevate')
  }
  mkdirSync(cacheDir, { recursive: true })
  return cacheDir
}

describe('cached elevate.exe swap covers the real electron-builder layouts', () => {
  // Why these exact shapes: `downloadBuilderToolset` unpacks to
  // `<cache>/<releaseName>/<archive basename>-<url hash>/`, and `releaseName` is
  // `nsis-3.0.4.1` on the legacy bundle (`getBinFromUrl`), `nsis@<toolset>` on the
  // unified bundle, and `nsis-<version>` for `customNsisBinary`. The release
  // workflow searched `<cache>/nsis`, which matches none of them.
  it.each([
    ['legacy bundle', 'nsis-3.0.4.1/nsis-3.0.4.1-1mx3n/elevate.exe'],
    ['unified bundle', 'nsis@1.2.1/nsis-bundle-3.12-k4d9x/elevate.exe'],
    ['custom nsis binary', 'nsis-9f3a1c2b/nsis-custom-3.11-0zqp2/elevate.exe'],
    ['bare nsis release dir', 'nsis/nsis-3.0.4.1/elevate.exe']
  ])('finds the cached helper in the %s layout', (_label, relative) => {
    const cacheDir = makeCache(relative)
    expect(findCachedElevatePaths(cacheDir, { env: {} })).toEqual([
      join(cacheDir, ...relative.split('/'))
    ])
  })

  it('ignores cache siblings that are not NSIS toolset bundles', () => {
    const cacheDir = makeCache(
      'winCodeSign/winCodeSign-2.6.0-abc12/elevate.exe',
      'downloads/nsis/elevate.exe',
      'nsis-resources-3.4.1/nsis-resources-3.4.1-p8w1z/plugins/x86-unicode/nsProcess.dll'
    )
    expect(findCachedElevatePaths(cacheDir, { env: {} })).toEqual([])
  })

  // The rebuild picks one bundle, and nothing outside app-builder-lib knows which.
  // Replacing every cached copy is the deliberate answer to that ambiguity.
  it('replaces every cached copy when several bundles are present', async () => {
    const cacheDir = makeCache(
      'nsis-3.0.4.1/nsis-3.0.4.1-1mx3n/elevate.exe',
      'nsis@1.2.1/nsis-bundle-3.12-k4d9x/elevate.exe'
    )
    const signed = join(scratch, 'signed-elevate.exe')
    writeFileSync(signed, 'signpath-signed-elevate')

    const { replaced } = await replaceCachedElevateHelpers({
      signedPath: signed,
      cacheDir,
      env: {},
      probeToolset: false
    })

    expect(replaced).toHaveLength(2)
    for (const path of replaced) {
      expect(readFileSync(path, 'utf8')).toBe('signpath-signed-elevate')
    }
  })

  it('covers the ELECTRON_BUILDER_NSIS_DIR override copy', () => {
    const overrideDir = join(scratch, 'nsis-override')
    mkdirSync(overrideDir, { recursive: true })
    writeFileSync(join(overrideDir, 'elevate.exe'), 'unsigned-elevate')
    const cacheDir = makeCache()

    expect(
      findCachedElevatePaths(cacheDir, { env: { ELECTRON_BUILDER_NSIS_DIR: overrideDir } })
    ).toEqual([join(overrideDir, 'elevate.exe')])
  })

  it('resolves the cache root the same way app-builder-lib does', () => {
    expect(
      resolveElectronBuilderCacheDir({
        env: { LOCALAPPDATA: 'C:\\Users\\runneradmin\\AppData\\Local' },
        platform: 'win32'
      })
    ).toBe(join('C:\\Users\\runneradmin\\AppData\\Local', 'electron-builder', 'Cache'))
    expect(resolveElectronBuilderCacheDir({ env: {}, platform: 'darwin', home: '/Users/a' })).toBe(
      join('/Users/a', 'Library', 'Caches', 'electron-builder')
    )
    expect(resolveElectronBuilderCacheDir({ env: { ELECTRON_BUILDER_CACHE: '/mnt/cache' } })).toBe(
      '/mnt/cache'
    )
  })

  // Proof against the layout actually on disk, not just the fixtures. Cross-checked
  // against an independent unbounded walk so a search that scopes itself wrongly
  // cannot pass by finding nothing — which is exactly how the inline path passed.
  // Skipped only where no NSIS bundle has been downloaded into the cache yet.
  it('finds every elevate.exe the real electron-builder cache holds', () => {
    const cacheDir = resolveElectronBuilderCacheDir()
    if (!existsSync(cacheDir)) {
      return
    }
    const walk = (dir) =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const path = join(dir, entry.name)
        if (entry.isDirectory()) {
          return walk(path)
        }
        return entry.name.toLowerCase() === 'elevate.exe' ? [path] : []
      })
    const onDisk = walk(cacheDir)
    if (onDisk.length === 0) {
      return
    }
    expect(findCachedElevatePaths(cacheDir, { env: {} }).sort()).toEqual(onDisk.sort())
  })
})

describe('a cached elevate.exe miss is not silent', () => {
  // ELECTRON_BUILDER_NSIS_DIR short-circuits app-builder-lib's own resolution before
  // any download, so the probe fails offline instead of fetching the NSIS bundle.
  function runScript(cacheDir, nsisDir, signedPath) {
    return spawnSync(process.execPath, [scriptPath, signedPath], {
      cwd: projectRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        ELECTRON_BUILDER_CACHE: cacheDir,
        ELECTRON_BUILDER_NSIS_DIR: nsisDir
      }
    })
  }

  it('exits non-zero with an ::error:: annotation when no cached copy is found', () => {
    const cacheDir = makeCache()
    const emptyNsisDir = join(scratch, 'empty-nsis')
    mkdirSync(emptyNsisDir, { recursive: true })
    const signed = join(scratch, 'signed-elevate.exe')
    writeFileSync(signed, 'signpath-signed-elevate')

    const result = runScript(cacheDir, emptyNsisDir, signed)

    expect(result.status).toBe(1)
    expect(result.stdout).toContain('::error::No cached elevate.exe found')
  })

  it('exits zero and rewrites the cached copy when one is found', () => {
    const cacheDir = makeCache('nsis-3.0.4.1/nsis-3.0.4.1-1mx3n/elevate.exe')
    const emptyNsisDir = join(scratch, 'empty-nsis')
    mkdirSync(emptyNsisDir, { recursive: true })
    const signed = join(scratch, 'signed-elevate.exe')
    writeFileSync(signed, 'signpath-signed-elevate')

    const result = runScript(cacheDir, emptyNsisDir, signed)

    expect(result.status).toBe(0)
    expect(result.stdout).not.toContain('::error::')
    expect(
      readFileSync(join(cacheDir, 'nsis-3.0.4.1', 'nsis-3.0.4.1-1mx3n', 'elevate.exe'), 'utf8')
    ).toBe('signpath-signed-elevate')
  })
})

describe('release-cut.yml swaps the cached elevate.exe through the resolver', () => {
  function swapStep() {
    const workflow = parse(
      readFileSync(join(projectRoot, '.github/workflows/release-cut.yml'), 'utf8')
    )
    const step = workflow.jobs.build.steps.find(
      (candidate) => candidate.name === 'Replace cached elevate.exe with the signed copy'
    )
    expect(step).toBeDefined()
    return step
  }

  it('delegates the cache lookup to the script instead of an inline path', () => {
    const step = swapStep()
    expect(step.run).toContain('node config/scripts/replace-cached-nsis-elevate.mjs $signed')
    // The hardcoded miss that shipped v1.4.193/v1.4.194 unsigned.
    expect(step.run).not.toContain('electron-builder\\Cache\\nsis')
    expect(step.run).not.toContain('-ErrorAction SilentlyContinue')
  })

  it('fails the step when the swap reports a miss', () => {
    const step = swapStep()
    // Matched as an executed statement: downgrading this to a Write-Host restores
    // the silent fail-open that let the unsigned helper ship.
    expect(step.run).toMatch(/if \(\$LASTEXITCODE -ne 0\) \{/)
    expect(step.run).toMatch(/^\s*throw \$message\s*$/m)
    expect(step.run).toContain('GITHUB_STEP_SUMMARY')
  })

  // Why kept: windows-signing-rehearsal.yml shares the electron-builder-win-<hash>
  // cache key, so dropping this guard would let a test certificate reach a release cache.
  it('still refuses to stage anything but a SignPath-signed helper', () => {
    const step = swapStep()
    expect(step.run).toContain("$signature.Status -ne 'Valid'")
    expect(step.run).toContain("$subject -notlike '*CN=SignPath Foundation*'")
  })

  // The inner-signing chain stays fail-open: a loud red step, not an unbuildable release.
  it('keeps the step unable to fail the release job', () => {
    expect(swapStep()['continue-on-error']).toBe(true)
  })
})
