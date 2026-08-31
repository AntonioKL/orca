import { afterEach, describe, expect, it, vi } from 'vitest'
import { access, cp, mkdtemp, readFile, rm, writeFile, mkdir, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  computeWorktreeDependencySeedFingerprint,
  cloneDependencySeedPath,
  defaultWorktreeDependencySeedDependencies,
  createWorktreeDependencySeedFingerprint,
  createDependencySeedContext,
  ensureDependencySeedRoot,
  ensureDependencySeedDirectory,
  getWorktreeDependencySeedRoot,
  hydrateWorktreeDependencies,
  normalizeDependencySeedPath,
  normalizeWorktreeDependencySeedPaths,
  promoteWorktreeDependencySeed,
  readWorktreeDependencySeedInputs,
  type WorktreeDependencySeedArgs
} from './worktree-dependency-seed'
import { withWorktreeDependencySeedLock } from './worktree-dependency-seed-lock'

describe('worktree dependency seed fingerprint', () => {
  const base = {
    setupScript: 'pnpm install\n',
    lockfiles: [{ path: 'pnpm-lock.yaml', bytes: Buffer.from('lock-v1') }],
    platform: 'darwin' as const,
    architecture: 'arm64',
    nodeMajor: 22,
    seedPaths: ['node_modules']
  }

  it('normalizes paths and is independent of input ordering', () => {
    expect(
      normalizeWorktreeDependencySeedPaths([
        './node_modules/',
        'node_modules/.cache',
        'node_modules',
        '../escape',
        'C:\\outside'
      ])
    ).toEqual(['node_modules'])
    const reversed = createWorktreeDependencySeedFingerprint({
      ...base,
      lockfiles: base.lockfiles.toReversed()
    })
    expect(reversed.digest).toBe(computeWorktreeDependencySeedFingerprint(base))
  })

  it('changes when any setup input or runtime dimension changes', () => {
    const original = computeWorktreeDependencySeedFingerprint(base)
    expect(
      computeWorktreeDependencySeedFingerprint({ ...base, setupScript: 'npm install' })
    ).not.toBe(original)
    expect(
      computeWorktreeDependencySeedFingerprint({
        ...base,
        lockfiles: [{ path: 'pnpm-lock.yaml', bytes: Buffer.from('lock-v2') }]
      })
    ).not.toBe(original)
    expect(computeWorktreeDependencySeedFingerprint({ ...base, platform: 'linux' })).not.toBe(
      original
    )
    expect(computeWorktreeDependencySeedFingerprint({ ...base, architecture: 'x64' })).not.toBe(
      original
    )
    expect(computeWorktreeDependencySeedFingerprint({ ...base, nodeMajor: 23 })).not.toBe(original)
  })

  it('canonicalizes leading dot prefixes and preserves relative separators', () => {
    expect(normalizeDependencySeedPath('./foo')).toBe('foo')
    expect(normalizeDependencySeedPath('././foo')).toBe('foo')
    expect(normalizeDependencySeedPath('foo\\bar')).toBe('foo/bar')
    expect(normalizeDependencySeedPath('foo/./bar')).toBeNull()
    expect(normalizeDependencySeedPath('../foo')).toBeNull()
    expect(normalizeDependencySeedPath('C:\\outside')).toBeNull()
  })
})

describe('worktree dependency seed fingerprint inputs', () => {
  const roots: string[] = []

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
  })

  it('reads nested files while refusing symlinked ancestors', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-dependency-seed-inputs-'))
    roots.push(root)
    const nested = join(root, 'nested')
    const outside = join(root, 'outside')
    await mkdir(nested)
    await mkdir(outside)
    await writeFile(join(nested, 'package-lock.json'), 'inside')
    await writeFile(join(outside, 'package-lock.json'), 'outside')
    await symlink(outside, join(root, 'redirect'), 'dir')

    await expect(
      readWorktreeDependencySeedInputs(root, ['./nested/package-lock.json'])
    ).resolves.toEqual([{ path: 'nested/package-lock.json', bytes: expect.any(Uint8Array) }])
    await expect(
      readWorktreeDependencySeedInputs(root, ['redirect/package-lock.json'])
    ).rejects.toThrow(/symlink/u)
  })

  it('ignores missing fingerprint inputs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-dependency-seed-inputs-'))
    roots.push(root)
    await expect(
      readWorktreeDependencySeedInputs(root, ['./missing/package-lock.json'])
    ).resolves.toEqual([])
  })
})

describe('worktree dependency seed hydration and promotion', () => {
  const roots: string[] = []

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
  })

  async function fixture(): Promise<{
    root: string
    repo: string
    worktree: string
    seedRoot: string
    cloneDarwinPath: NonNullable<WorktreeDependencySeedArgs['dependencies']>['cloneDarwinPath']
  }> {
    const root = await mkdtemp(join(tmpdir(), 'orca-dependency-seed-'))
    roots.push(root)
    const repo = join(root, 'repo')
    const worktree = join(root, 'first')
    const seedRoot = join(root, 'seeds')
    await mkdir(repo, { recursive: true })
    await mkdir(join(worktree, 'node_modules'), { recursive: true })
    await writeFile(join(repo, 'pnpm-lock.yaml'), 'lock-v1')
    await writeFile(join(worktree, 'pnpm-lock.yaml'), 'lock-v1')
    await writeFile(join(worktree, 'node_modules', 'package.js'), 'module.exports = 1\n')
    const cloneDarwinPath = async (source: string, target: string, sourceIsDirectory: boolean) => {
      await cp(source, target, { recursive: sourceIsDirectory })
    }
    return { root, repo, worktree, seedRoot, cloneDarwinPath }
  }

  function args(
    fixtureData: Awaited<ReturnType<typeof fixture>>,
    worktreePath = fixtureData.worktree
  ) {
    return {
      repo: fixtureData.repo,
      worktreePath,
      setupScript: 'pnpm install\n',
      declaredSeedPaths: ['node_modules'],
      platform: 'darwin' as const,
      architecture: 'arm64',
      nodeMajor: 22,
      seedRoot: fixtureData.seedRoot,
      dependencies: { cloneDarwinPath: fixtureData.cloneDarwinPath }
    }
  }

  it('promotes a private tree, hydrates a fresh worktree, and preserves copy isolation', async () => {
    const data = await fixture()
    await expect(promoteWorktreeDependencySeed(args(data))).resolves.toMatchObject({
      status: 'promoted',
      paths: ['node_modules']
    })
    const second = join(data.root, 'second')
    await mkdir(second)
    await writeFile(join(second, 'pnpm-lock.yaml'), 'lock-v1')
    await expect(hydrateWorktreeDependencies(args(data, second))).resolves.toMatchObject({
      status: 'hydrated',
      paths: ['node_modules']
    })
    await writeFile(join(second, 'node_modules', 'package.js'), 'changed\n')
    await expect(readFile(join(data.worktree, 'node_modules', 'package.js'), 'utf8')).resolves.toBe(
      'module.exports = 1\n'
    )
  })

  it('misses changed fingerprints and never overwrites an existing target', async () => {
    const data = await fixture()
    await promoteWorktreeDependencySeed(args(data))
    const changed = join(data.root, 'changed')
    await mkdir(join(changed, 'node_modules'), { recursive: true })
    await writeFile(join(changed, 'pnpm-lock.yaml'), 'lock-v2')
    await expect(hydrateWorktreeDependencies(args(data, changed))).resolves.toMatchObject({
      status: 'miss'
    })

    const existing = join(data.root, 'existing')
    await mkdir(join(existing, 'node_modules'), { recursive: true })
    await writeFile(join(existing, 'pnpm-lock.yaml'), 'lock-v1')
    await writeFile(join(existing, 'node_modules', 'package.js'), 'local\n')
    await expect(hydrateWorktreeDependencies(args(data, existing))).resolves.toMatchObject({
      status: 'existing',
      paths: []
    })
    await expect(readFile(join(existing, 'node_modules', 'package.js'), 'utf8')).resolves.toBe(
      'local\n'
    )
  })

  it('rejects a marker whose fingerprint seed paths were tampered with', async () => {
    const data = await fixture()
    await promoteWorktreeDependencySeed(args(data))
    const digest = computeWorktreeDependencySeedFingerprint({
      setupScript: 'pnpm install\n',
      lockfiles: [{ path: 'pnpm-lock.yaml', bytes: Buffer.from('lock-v1') }],
      platform: 'darwin',
      architecture: 'arm64',
      nodeMajor: 22,
      seedPaths: ['node_modules']
    })
    const markerPath = join(data.seedRoot, digest, 'seed.json')
    const marker = JSON.parse(await readFile(markerPath, 'utf8'))
    marker.fingerprint.seedPaths = []
    await writeFile(markerPath, JSON.stringify(marker))
    const target = join(data.root, 'tampered')
    await mkdir(target)
    await writeFile(join(target, 'pnpm-lock.yaml'), 'lock-v1')
    await expect(hydrateWorktreeDependencies(args(data, target))).resolves.toMatchObject({
      status: 'miss'
    })
  })

  it('treats malformed marker paths as a cache miss', async () => {
    const data = await fixture()
    await promoteWorktreeDependencySeed(args(data))
    const entries = await (await import('node:fs/promises')).readdir(data.seedRoot)
    const markerPath = join(data.seedRoot, entries[0], 'seed.json')
    const marker = JSON.parse(await readFile(markerPath, 'utf8'))
    marker.paths = [null]
    await writeFile(markerPath, JSON.stringify(marker))

    const target = join(data.root, 'malformed-marker-target')
    await mkdir(target)
    await writeFile(join(target, 'pnpm-lock.yaml'), 'lock-v1')
    await expect(hydrateWorktreeDependencies(args(data, target))).resolves.toMatchObject({
      status: 'miss'
    })
  })

  it('refuses a target parent symlink instead of writing outside the target root', async () => {
    const data = await fixture()
    const outside = join(data.root, 'outside')
    const targetRoot = join(data.root, 'target-root')
    await mkdir(outside)
    await mkdir(targetRoot)
    await symlink(outside, join(targetRoot, 'redirect'))

    const source = join(data.worktree, 'node_modules', 'package.js')
    const target = join(targetRoot, 'redirect', 'copied.js')
    await expect(
      cloneDependencySeedPath(
        source,
        target,
        'darwin',
        { ...defaultWorktreeDependencySeedDependencies, cloneDarwinPath: async () => undefined },
        targetRoot,
        data.worktree
      )
    ).rejects.toThrow(/symlink/u)
    await expect(readFile(join(outside, 'copied.js'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT'
    })
  })

  it('refuses a source parent symlink instead of importing outside the source root', async () => {
    const data = await fixture()
    const sourceRoot = join(data.root, 'source-root')
    const outside = join(data.root, 'outside-source')
    const targetRoot = join(data.root, 'target-root')
    await mkdir(sourceRoot)
    await mkdir(outside)
    await mkdir(targetRoot)
    await writeFile(join(outside, 'secret.js'), 'secret\n')
    await symlink(outside, join(sourceRoot, 'redirect'))

    await expect(
      cloneDependencySeedPath(
        join(sourceRoot, 'redirect', 'secret.js'),
        join(targetRoot, 'copied.js'),
        'darwin',
        { ...defaultWorktreeDependencySeedDependencies, cloneDarwinPath: async () => undefined },
        targetRoot,
        sourceRoot
      )
    ).rejects.toThrow(/symlink/u)
  })

  it('refuses a nested dependency symlink that escapes the worktree', async () => {
    const data = await fixture()
    const outside = join(data.root, 'nested-outside')
    await mkdir(outside)
    await writeFile(join(outside, 'secret.js'), 'secret\n')
    await symlink(outside, join(data.worktree, 'node_modules', 'redirect'), 'dir')

    await expect(promoteWorktreeDependencySeed(args(data))).resolves.toMatchObject({
      status: 'failed'
    })
    const seedEntries = await (
      await import('node:fs/promises')
    )
      .readdir(data.seedRoot)
      .catch(() => [])
    expect(seedEntries.some((entry) => entry === 'seed.json')).toBe(false)
  })

  it('keeps default clone roots from trusting symlink ancestors', async () => {
    const data = await fixture()
    const sourceAlias = join(data.root, 'source-alias')
    const targetRoot = join(data.root, 'default-target')
    const targetAlias = join(data.root, 'target-alias')
    await symlink(data.worktree, sourceAlias, 'dir')
    await mkdir(targetRoot)
    await symlink(targetRoot, targetAlias, 'dir')
    const dependencies = {
      ...defaultWorktreeDependencySeedDependencies,
      cloneDarwinPath: async () => undefined
    }

    await expect(
      cloneDependencySeedPath(
        join(sourceAlias, 'node_modules', 'package.js'),
        join(targetRoot, 'copied.js'),
        'darwin',
        dependencies
      )
    ).rejects.toThrow(/symlink/u)
    await expect(
      cloneDependencySeedPath(
        join(data.worktree, 'node_modules', 'package.js'),
        join(targetAlias, 'copied.js'),
        'darwin',
        dependencies
      )
    ).rejects.toThrow(/symlink/u)
  })

  it('fails open when copy-on-write is unavailable and does not publish a marker', async () => {
    const data = await fixture()
    const cloneDarwinPath = vi.fn(async () => {
      throw new Error('not APFS')
    })
    await expect(
      promoteWorktreeDependencySeed(args({ ...data, cloneDarwinPath }))
    ).resolves.toMatchObject({ status: 'failed' })
    const seedRootEntries = await (
      await import('node:fs/promises')
    )
      .readdir(data.seedRoot)
      .catch(() => [])
    expect(seedRootEntries.some((entry) => entry === 'seed.json')).toBe(false)
  })

  it('serializes concurrent promotions for one seed entry', async () => {
    const data = await fixture()
    let active = 0
    let maximum = 0
    const cloneDarwinPath = async (source: string, target: string, sourceIsDirectory: boolean) => {
      active += 1
      maximum = Math.max(maximum, active)
      await new Promise((resolve) => setTimeout(resolve, 5))
      await cp(source, target, { recursive: sourceIsDirectory })
      active -= 1
    }
    const [first, second] = await Promise.all([
      promoteWorktreeDependencySeed(args({ ...data, cloneDarwinPath })),
      promoteWorktreeDependencySeed(args({ ...data, cloneDarwinPath }))
    ])
    expect(maximum).toBe(1)
    expect([first.status, second.status].sort()).toEqual(['existing', 'promoted'])
  })

  it('keeps the default store beside the worktree and allows an explicit root', () => {
    const defaultRoot = getWorktreeDependencySeedRoot('/repo', '/workspace/feature')
    expect(defaultRoot).toContain(join('workspace', '.orca-dependency-seeds'))
    expect(getWorktreeDependencySeedRoot('/repo', '/workspace/feature', '/tmp/seeds')).toBe(
      '/tmp/seeds'
    )
  })

  it('fails closed when the explicit seed root is a symlink', async () => {
    const data = await fixture()
    const realRoot = join(data.root, 'real-seeds')
    const aliasRoot = join(data.root, 'seed-alias')
    await mkdir(realRoot)
    await symlink(realRoot, aliasRoot, 'dir')

    const context = await createDependencySeedContext({
      ...args(data),
      seedRoot: aliasRoot
    })
    expect(context).not.toBeNull()
    await expect(ensureDependencySeedRoot(context!)).rejects.toThrow(/symlink/u)
    await expect(
      promoteWorktreeDependencySeed({ ...args(data), seedRoot: aliasRoot })
    ).resolves.toMatchObject({
      status: 'failed'
    })
    await expect((await import('node:fs/promises')).readdir(realRoot)).resolves.toEqual([])
  })

  it('fails closed when the generated store parent is a symlink', async () => {
    const data = await fixture()
    const redirectedParent = join(data.root, 'redirected-seeds')
    const generatedParent = join(data.root, '.orca-dependency-seeds')
    await mkdir(redirectedParent)
    await symlink(redirectedParent, generatedParent, 'dir')

    const result = await promoteWorktreeDependencySeed({
      ...args(data),
      seedRoot: join(generatedParent, 'repo-hash')
    })
    expect(result.status).toBe('failed')
    await expect((await import('node:fs/promises')).readdir(redirectedParent)).resolves.toEqual([])
  })

  it('creates missing seed components but rejects a nested symlink redirect', async () => {
    const data = await fixture()
    const nested = join(data.root, 'new', 'nested', 'seed-root')
    await expect(ensureDependencySeedDirectory(nested)).resolves.toBe(nested)

    // macOS presents /tmp as /private/tmp; the system alias must not make a
    // normal seed path unusable while caller-controlled links remain blocked.
    const tempAliasRoot = await mkdtemp('/tmp/orca-dependency-seed-alias-')
    roots.push(tempAliasRoot)
    await expect(ensureDependencySeedDirectory(join(tempAliasRoot, 'nested'))).resolves.toBe(
      join(tempAliasRoot, 'nested')
    )

    const real = join(data.root, 'real-parent')
    const alias = join(data.root, 'alias-parent')
    await mkdir(real)
    await symlink(real, alias, 'dir')
    const redirected = join(alias, 'child', 'seed-root')
    await expect(ensureDependencySeedDirectory(redirected)).rejects.toThrow(/symlink/u)
    await expect(access(join(real, 'child'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('worktree dependency seed lock', () => {
  it('queues operations by key while allowing different keys to proceed', async () => {
    const events: string[] = []
    let release!: () => void
    const blocker = new Promise<void>((resolve) => {
      release = resolve
    })
    const first = withWorktreeDependencySeedLock('same', async () => {
      events.push('first:start')
      await blocker
      events.push('first:end')
    })
    const second = withWorktreeDependencySeedLock('same', async () => {
      events.push('second:start')
    })
    const other = withWorktreeDependencySeedLock('other', async () => {
      events.push('other:start')
    })
    await other
    expect(events).toEqual(['first:start', 'other:start'])
    release()
    await Promise.all([first, second])
    expect(events).toEqual(['first:start', 'other:start', 'first:end', 'second:start'])
  })

  it('creates a filesystem lock for absolute seed keys', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-dependency-seed-lock-'))
    const lockKey = join(root, 'entry')
    let releaseOperation!: () => void
    const operationBlocked = new Promise<void>((resolve) => {
      releaseOperation = resolve
    })
    try {
      const running = withWorktreeDependencySeedLock(lockKey, async () => {
        await vi.waitFor(async () => {
          await access(`${lockKey}.lock`)
        })
        await operationBlocked
      })
      await vi.waitFor(async () => {
        await access(`${lockKey}.lock`)
      })
      expect(await access(`${lockKey}.lock`)).toBeUndefined()
      releaseOperation()
      await running
      await expect(access(`${lockKey}.lock`)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      releaseOperation()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('locks a stable root before an entry exists', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-dependency-seed-lock-root-'))
    const entry = join(root, 'missing-entry')
    let releaseOperation!: () => void
    const operationBlocked = new Promise<void>((resolve) => {
      releaseOperation = resolve
    })
    try {
      const running = withWorktreeDependencySeedLock(
        entry,
        async () => {
          await operationBlocked
        },
        root
      )
      await vi.waitFor(async () => {
        await access(`${root}.lock`)
      })
      await expect(access(entry)).rejects.toMatchObject({ code: 'ENOENT' })
      releaseOperation()
      await running
      await expect(access(`${root}.lock`)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      releaseOperation()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects a symlinked lock path instead of following it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-dependency-seed-lock-link-'))
    const entry = join(root, 'entry')
    const outside = join(root, 'outside')
    await mkdir(entry)
    await mkdir(outside)
    await symlink(outside, `${entry}.lock`, 'dir')
    try {
      await expect(withWorktreeDependencySeedLock(entry, async () => undefined)).rejects.toThrow(
        /symlink/u
      )
      await expect((await import('node:fs/promises')).readdir(outside)).resolves.toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
