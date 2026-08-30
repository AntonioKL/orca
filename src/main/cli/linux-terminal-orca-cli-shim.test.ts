import { chmodSync, mkdirSync, readFileSync, readlinkSync, statSync, writeFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runProcess } from '../../shared/child-process/run-process'

vi.mock('electron', () => ({
  app: { isPackaged: true }
}))

import {
  resolveAppImageLauncherEndpointPath,
  resolveAppImageStableLauncherPath
} from './appimage-stable-launcher'
import { ensureLinuxTerminalOrcaCliShimDir } from './linux-terminal-orca-cli-shim'

const created: string[] = []

async function makeFixture(): Promise<{ userDataPath: string; resourcesPath: string }> {
  const root = await mkdtemp(join(tmpdir(), 'orca-terminal-cli-shim-'))
  created.push(root)
  const resourcesPath = join(root, 'resources')
  // The bundled orca-ide launcher must exist for the shim to be written.
  mkdirSync(join(resourcesPath, 'bin'), { recursive: true })
  writeFileSync(join(resourcesPath, 'bin', 'orca-ide'), '#!/usr/bin/env bash\n', 'utf8')
  return { userDataPath: join(root, 'user-data'), resourcesPath }
}

afterEach(async () => {
  await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('ensureLinuxTerminalOrcaCliShimDir', () => {
  it('writes an executable bare-orca shim that execs the bundled orca-ide launcher', async () => {
    const { userDataPath, resourcesPath } = await makeFixture()

    const shimDir = ensureLinuxTerminalOrcaCliShimDir({
      userDataPath,
      resourcesPath,
      appImagePath: null
    })

    expect(shimDir).toBe(join(userDataPath, 'linux-orca-cli-shim'))
    const content = readFileSync(join(shimDir!, 'orca'), 'utf8')
    // Single-quoted so a resources path with shell metacharacters can't break out.
    expect(content).toContain(`exec '${join(resourcesPath, 'bin', 'orca-ide')}' "$@"`)
    const mode = statSync(join(shimDir!, 'orca')).mode & 0o777
    expect(mode & 0o111).not.toBe(0)
  })

  it('reuses the shim path and re-asserts its exec bit', async () => {
    const { userDataPath, resourcesPath } = await makeFixture()
    const options = { userDataPath, resourcesPath, appImagePath: null }

    const first = ensureLinuxTerminalOrcaCliShimDir(options)
    expect(first).not.toBeNull()
    const shimPath = join(first!, 'orca')
    chmodSync(shimPath, 0o644)

    const second = ensureLinuxTerminalOrcaCliShimDir(options)
    expect(second).toBe(first)
    expect(statSync(shimPath).mode & 0o111).not.toBe(0)

    const root = await mkdtemp(join(tmpdir(), 'orca-terminal-cli-shim-2-'))
    created.push(root)
    const otherUserData = join(root, 'user-data')
    mkdirSync(join(otherUserData, 'linux-orca-cli-shim'), { recursive: true })
    writeFileSync(join(otherUserData, 'linux-orca-cli-shim', 'orca'), 'stale contents', 'utf8')
    chmodSync(join(otherUserData, 'linux-orca-cli-shim', 'orca'), 0o644)

    const healed = ensureLinuxTerminalOrcaCliShimDir({
      userDataPath: otherUserData,
      resourcesPath,
      appImagePath: null
    })
    expect(healed).not.toBeNull()
    const healedPath = join(healed!, 'orca')
    expect(readFileSync(healedPath, 'utf8')).toContain('orca-ide')
    expect(statSync(healedPath).mode & 0o111).not.toBe(0)
  })

  it('routes AppImage terminals through the stable cache without extracting', async () => {
    const { userDataPath, resourcesPath } = await makeFixture()
    const appImagePath = join(userDataPath, 'Orca.AppImage')
    await mkdir(userDataPath, { recursive: true })
    await writeFile(appImagePath, '#!/usr/bin/env bash\n', { encoding: 'utf8', mode: 0o755 })
    const cacheRootPath = join(userDataPath, 'cache')
    const liveLauncherPath = join(resourcesPath, 'bin', 'orca-ide')
    writeFileSync(liveLauncherPath, '#!/usr/bin/env bash\nprintf live', 'utf8')
    chmodSync(liveLauncherPath, 0o755)
    const extract = vi.fn()

    const shimDir = ensureLinuxTerminalOrcaCliShimDir({
      userDataPath,
      resourcesPath,
      appImagePath,
      appImageCacheRootPath: cacheRootPath,
      appImageExtractRunner: extract
    })

    const shimPath = join(shimDir!, 'orca')
    const stableLauncherPath = resolveAppImageStableLauncherPath(cacheRootPath)
    const content = readFileSync(shimPath, 'utf8')
    expect(content).toContain(stableLauncherPath)
    expect(content).not.toContain(resourcesPath)
    expect(content).not.toContain(appImagePath)
    await expect(
      runProcess({ program: shimPath, args: [], timeoutMs: 3_000 })
    ).resolves.toMatchObject({ code: 0, stdout: 'live' })
    expect(extract).not.toHaveBeenCalled()
  })

  it('updates restored terminals to the current AppImage mount without rewriting the shim', async () => {
    const { userDataPath, resourcesPath } = await makeFixture()
    const appImagePath = join(userDataPath, 'Orca.AppImage')
    await mkdir(userDataPath, { recursive: true })
    await writeFile(appImagePath, '#!/usr/bin/env bash\n', { encoding: 'utf8', mode: 0o755 })
    const cacheRootPath = join(userDataPath, 'cache')
    const firstLauncher = join(resourcesPath, 'bin', 'orca-ide')
    writeFileSync(firstLauncher, '#!/usr/bin/env bash\nprintf first', 'utf8')
    chmodSync(firstLauncher, 0o755)
    const extract = vi.fn()
    const options = {
      userDataPath,
      resourcesPath,
      appImagePath,
      appImageCacheRootPath: cacheRootPath,
      appImageExtractRunner: extract
    }
    const shimDir = ensureLinuxTerminalOrcaCliShimDir(options)
    const shimPath = join(shimDir!, 'orca')
    const originalShim = readFileSync(shimPath, 'utf8')

    const nextResourcesPath = join(userDataPath, 'next-mount', 'resources')
    const nextLauncher = join(nextResourcesPath, 'bin', 'orca-ide')
    await mkdir(join(nextResourcesPath, 'bin'), { recursive: true })
    await writeFile(nextLauncher, '#!/usr/bin/env bash\nprintf next', { mode: 0o755 })
    await rm(firstLauncher)
    expect(
      ensureLinuxTerminalOrcaCliShimDir({ ...options, resourcesPath: nextResourcesPath })
    ).toBe(shimDir)

    expect(readFileSync(shimPath, 'utf8')).toBe(originalShim)
    expect(readlinkSync(resolveAppImageLauncherEndpointPath(cacheRootPath, 'live'))).toBe(
      nextLauncher
    )
    await expect(
      runProcess({ program: shimPath, args: [], timeoutMs: 3_000 })
    ).resolves.toMatchObject({ code: 0, stdout: 'next' })
    expect(extract).not.toHaveBeenCalled()
  })

  it('waits briefly for a temporarily unavailable live endpoint', async () => {
    const { userDataPath, resourcesPath } = await makeFixture()
    const appImagePath = join(userDataPath, 'Orca.AppImage')
    const cacheRootPath = join(userDataPath, 'cache')
    await mkdir(userDataPath, { recursive: true })
    await writeFile(appImagePath, '#!/usr/bin/env bash\n', { mode: 0o755 })
    const liveLauncher = join(resourcesPath, 'bin', 'orca-ide')
    chmodSync(liveLauncher, 0o755)
    const extract = vi.fn()

    const shimDir = ensureLinuxTerminalOrcaCliShimDir({
      userDataPath,
      resourcesPath,
      appImagePath,
      appImageCacheRootPath: cacheRootPath,
      appImageExtractRunner: extract
    })
    const shimPath = join(shimDir!, 'orca')
    await rm(liveLauncher)
    const invocation = runProcess({ program: shimPath, args: [], timeoutMs: 3_000 })
    setTimeout(() => {
      writeFileSync(liveLauncher, '#!/usr/bin/env bash\nprintf recovered', { mode: 0o755 })
    }, 100)

    await expect(invocation).resolves.toMatchObject({ code: 0, stdout: 'recovered' })
    expect(extract).not.toHaveBeenCalled()
  })

  it('returns null (and does not memoize) when the bundled launcher is missing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-terminal-cli-shim-missing-'))
    created.push(root)
    const userDataPath = join(root, 'user-data')

    const missing = ensureLinuxTerminalOrcaCliShimDir({
      userDataPath,
      resourcesPath: join(root, 'resources'),
      appImagePath: null
    })
    expect(missing).toBeNull()

    // Once the launcher exists (e.g. later probe with real resources), the same
    // userData path succeeds — proving failures are not cached.
    const resourcesPath = join(root, 'resources')
    mkdirSync(join(resourcesPath, 'bin'), { recursive: true })
    writeFileSync(join(resourcesPath, 'bin', 'orca-ide'), '#!/usr/bin/env bash\n', 'utf8')
    const recovered = ensureLinuxTerminalOrcaCliShimDir({
      userDataPath,
      resourcesPath,
      appImagePath: null
    })
    expect(recovered).toBe(join(userDataPath, 'linux-orca-cli-shim'))
  })
})
