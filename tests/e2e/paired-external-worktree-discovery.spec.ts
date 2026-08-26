import { rmSync } from 'node:fs'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { gitExecFileAsync } from '../../src/main/git/runner'
import { listWorktreesStrict } from '../../src/main/git/worktree'
import { expect, test } from './helpers/orca-app'
import {
  createRuntimeDesktopPairingOffer,
  launchPairedElectronClient,
  type PairedElectronClient
} from './helpers/paired-electron-client'
import { worktreeRow } from './worktree-row-locators'

function equivalentTestPaths(value: string): string[] {
  const normalized = path.normalize(value)
  if (process.platform !== 'darwin') {
    return [normalized]
  }
  return normalized.startsWith('/private/var/')
    ? [normalized, normalized.slice('/private'.length)]
    : [normalized, `/private${normalized}`]
}

function pathsMatch(left: string, right: string): boolean {
  return equivalentTestPaths(left).includes(path.normalize(right))
}

function waitForCatalogWorktree(page: Page, repoId: string, worktreePath: string): Promise<string> {
  return page.evaluate(
    ({ expectedPaths, expectedRepoId }) => {
      const findId = (): string | undefined =>
        window.__store
          ?.getState()
          .allWorktrees()
          .find(
            (worktree) =>
              worktree.repoId === expectedRepoId && expectedPaths.includes(worktree.path)
          )?.id
      const existing = findId()
      if (existing) {
        return existing
      }
      return new Promise<string>((resolve) => {
        const unsubscribe = window.__store!.subscribe(() => {
          const id = findId()
          if (id) {
            unsubscribe()
            resolve(id)
          }
        })
      })
    },
    { expectedPaths: equivalentTestPaths(worktreePath), expectedRepoId: repoId }
  )
}

test('shows an externally created worktree on a paired client without reconnect', async ({
  registerPostElectronShutdownCleanup,
  sharedPage,
  testRepoPath
}, testInfo) => {
  test.setTimeout(120_000)
  const suffix = `${Date.now()}-${testInfo.workerIndex}`
  const branch = `e2e-paired-external-${suffix}`
  const externalPath = path.join(path.dirname(testRepoPath), branch)
  let client: PairedElectronClient | undefined
  let worktreeCreated = false
  registerPostElectronShutdownCleanup(async () => {
    if (worktreeCreated) {
      await gitExecFileAsync(['worktree', 'remove', '--force', externalPath], {
        cwd: testRepoPath
      }).catch(() => undefined)
      await gitExecFileAsync(['branch', '-D', branch], { cwd: testRepoPath }).catch(() => undefined)
    }
    rmSync(externalPath, { recursive: true, force: true })
  })

  try {
    const repos = await sharedPage.evaluate(
      () => window.__store?.getState().repos.map((repo) => ({ id: repo.id, path: repo.path })) ?? []
    )
    const repoId = repos.find((repo) => pathsMatch(repo.path, testRepoPath))?.id
    if (!repoId) {
      throw new Error(`Headed host did not catalog ${testRepoPath}`)
    }
    client = await launchPairedElectronClient(
      await createRuntimeDesktopPairingOffer(sharedPage),
      testInfo,
      'External worktree discovery'
    )
    await client.page.waitForFunction(
      ({ expectedPaths, expectedRepoId }) =>
        window.__store
          ?.getState()
          .allWorktrees()
          .some(
            (worktree) =>
              worktree.repoId === expectedRepoId && expectedPaths.includes(worktree.path)
          ) ?? false,
      { expectedPaths: equivalentTestPaths(testRepoPath), expectedRepoId: repoId }
    )

    const hostCatalogUpdate = waitForCatalogWorktree(sharedPage, repoId, externalPath)
    const clientCatalogUpdate = waitForCatalogWorktree(client.page, repoId, externalPath)
    await gitExecFileAsync(['worktree', 'add', '--quiet', '-b', branch, externalPath], {
      cwd: testRepoPath
    })
    worktreeCreated = true

    expect(
      (await listWorktreesStrict(testRepoPath)).some((worktree) =>
        pathsMatch(worktree.path, externalPath)
      )
    ).toBe(true)
    const [hostWorktreeId, clientWorktreeId] = await Promise.all([
      hostCatalogUpdate,
      clientCatalogUpdate
    ])
    expect(clientWorktreeId).toBe(hostWorktreeId)
    await expect(worktreeRow(sharedPage, hostWorktreeId)).toBeVisible()
    await expect(worktreeRow(client.page, clientWorktreeId)).toBeVisible()
  } finally {
    await client?.dispose()
  }
})
