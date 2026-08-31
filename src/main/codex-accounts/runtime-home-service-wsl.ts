import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join, win32 as pathWin32 } from 'node:path'
import { quotePosixShell } from '../../shared/wsl-login-shell-command'
import { WSL_CODEX_RUNTIME_HOME_SEGMENTS } from '../pty/codex-home-wsl-env'
import { parseWslUncPath } from '../../shared/wsl-paths'
import {
  getWslSelectionKey,
  getSelectedCodexAccountIdForTarget,
  normalizeCodexRuntimeSelection,
  setSelectedCodexAccountIdForTarget,
  type CodexAccountSelectionTarget
} from './runtime-selection'
import { getDefaultWslDistro, getWslHome } from '../wsl'
import { writeFileAtomically } from './fs-utils'
import type { CodexManagedAccount } from '../../shared/managed-account-types'
import { CodexRuntimeHomeWslCore } from './runtime-home-service-wsl-core'
import { prepareWslRuntimeSeedConfig } from './runtime-home-service-wsl-seed-config'

export abstract class CodexRuntimeHomeWsl extends CodexRuntimeHomeWslCore {
  protected getPreparedWslRateLimitHomePath(target: CodexAccountSelectionTarget): string | null {
    const distro = target.wslDistro?.trim()
    if (distro) {
      const settings = this.store.getSettings()
      const selectedAccountId = getSelectedCodexAccountIdForTarget(settings, target)
      if (selectedAccountId === null) {
        // Why: the system-default account changes outside Orca, so read its real home directly to avoid a stale cached runtime copy.
        return this.getWslSystemCodexHomePath(target)
      }
      const cachedRuntimeHomePath = this.wslRuntimeHomePathByDistro.get(distro)
      if (
        cachedRuntimeHomePath &&
        this.lastSyncedWslAccountIdByDistro.has(distro) &&
        this.lastSyncedWslAccountIdByDistro.get(distro) === selectedAccountId
      ) {
        // Why: RateLimitService resolves provenance twice per poll; stay path-only so it doesn't block main on UNC reads and a wsl.exe probe.
        return cachedRuntimeHomePath
      }
    }
    return this.syncWslRuntimeForCurrentSelection(target)
  }

  protected syncWslRuntimeForCurrentSelection(target: CodexAccountSelectionTarget): string | null {
    if (process.platform !== 'win32') {
      return null
    }

    const wslTarget = this.resolveWslDefaultTarget(target)
    const settings = this.store.getSettings()
    const activeAccount = this.getActiveAccount(
      settings.codexManagedAccounts,
      getSelectedCodexAccountIdForTarget(settings, wslTarget)
    )
    const distro = wslTarget.wslDistro?.trim() || activeAccount?.wslDistro || getDefaultWslDistro()
    if (!distro) {
      return null
    }

    const runtimeHomePath = this.getWslRuntimeHomePath(distro)
    if (!runtimeHomePath) {
      return null
    }
    this.wslRuntimeHomePathByDistro.set(distro, runtimeHomePath)

    mkdirSync(runtimeHomePath, { recursive: true })
    this.safeMigrateLegacyWslActiveHomePointer(distro, runtimeHomePath)
    this.seedWslRuntimeHome(runtimeHomePath, activeAccount, distro)

    const runtimeAuthPath = join(runtimeHomePath, 'auth.json')
    const previousWslAccountId = this.lastSyncedWslAccountIdByDistro.get(distro) ?? null
    if (previousWslAccountId) {
      if (this.skipNextReadBackForAccountId === previousWslAccountId) {
        this.skipNextReadBackForAccountId = null
      } else {
        const previousWslAccount = this.getActiveAccount(
          settings.codexManagedAccounts,
          previousWslAccountId
        )
        if (previousWslAccount) {
          this.readBackRefreshedTokensFromPath(runtimeAuthPath, {
            updateLastWrittenAuthJson: true,
            lastWrittenAuthJson: this.lastWrittenWslAuthJsonByDistro.get(distro) ?? null,
            setLastWrittenAuthJson: (contents) => {
              this.lastWrittenWslAuthJsonByDistro.set(distro, contents)
            },
            expectedAccountId: previousWslAccount.id
          })
        }
      }
    }

    const activeAuthPath = activeAccount ? join(activeAccount.managedHomePath, 'auth.json') : null
    if (activeAccount && activeAuthPath && existsSync(activeAuthPath)) {
      const activeAuth = readFileSync(activeAuthPath, 'utf-8')
      this.writeRuntimeAuthAtPath(runtimeAuthPath, activeAuth)
      this.lastWrittenWslAuthJsonByDistro.set(distro, activeAuth)
      this.lastSyncedWslAccountIdByDistro.set(distro, activeAccount.id)
      return runtimeHomePath
    }
    if (activeAccount && activeAuthPath) {
      console.warn(
        '[codex-runtime-home] Active WSL managed account is missing auth.json, restoring system default'
      )
      this.store.updateSettings({
        activeCodexManagedAccountId: settings.activeCodexManagedAccountId,
        activeCodexManagedAccountIdsByRuntime: setSelectedCodexAccountIdForTarget(
          normalizeCodexRuntimeSelection(settings),
          null,
          wslTarget
        )
      })
    }

    const systemAuthPath = this.getWslSystemCodexAuthPath({ runtime: 'wsl', wslDistro: distro })
    if (systemAuthPath && existsSync(systemAuthPath)) {
      const systemAuth = readFileSync(systemAuthPath, 'utf-8')
      const mirroredSystemDefaultAuth = this.lastWrittenWslAuthJsonByDistro.get(distro) ?? null
      const runtimeAuth = existsSync(runtimeAuthPath)
        ? readFileSync(runtimeAuthPath, 'utf-8')
        : null
      if (
        runtimeAuth !== null &&
        runtimeAuth !== systemAuth &&
        this.runtimeAuthMatchesSystemDefaultIdentity(runtimeAuth, systemAuth) &&
        ((mirroredSystemDefaultAuth !== null && systemAuth === mirroredSystemDefaultAuth) ||
          (mirroredSystemDefaultAuth === null &&
            this.runtimeAuthIsFresher(runtimeAuth, systemAuth)))
      ) {
        // Why: WSL baselines are lost on restart, so a same-identity fresher runtime auth is a token refresh; copy it back before mirroring ~/.codex.
        this.writeRuntimeAuthAtPath(systemAuthPath, runtimeAuth)
        this.lastWrittenWslAuthJsonByDistro.set(distro, runtimeAuth)
        this.lastSyncedWslAccountIdByDistro.set(distro, null)
        return runtimeHomePath
      }
      this.writeRuntimeAuthAtPath(runtimeAuthPath, systemAuth)
      this.lastWrittenWslAuthJsonByDistro.set(distro, systemAuth)
      this.lastSyncedWslAccountIdByDistro.set(distro, null)
      return runtimeHomePath
    }

    rmSync(runtimeAuthPath, { force: true })
    this.lastWrittenWslAuthJsonByDistro.set(distro, null)
    this.lastSyncedWslAccountIdByDistro.set(distro, null)
    return runtimeHomePath
  }

  protected getWslRuntimeHomePath(distro: string): string | null {
    const home = getWslHome(distro)
    return home ? this.joinWslPath(home, ...WSL_CODEX_RUNTIME_HOME_SEGMENTS) : null
  }

  protected safeReadBackActiveWslAccountBeforeRestart(
    account: CodexManagedAccount,
    selectedDistroKey: string
  ): void {
    try {
      this.readBackActiveWslAccountBeforeRestart(account, selectedDistroKey)
    } catch (error) {
      console.warn('[codex-runtime-home] Failed to preserve WSL Codex auth before restart:', error)
    }
  }

  protected readBackActiveWslAccountBeforeRestart(
    account: CodexManagedAccount,
    selectedDistroKey: string
  ): void {
    const distro =
      selectedDistroKey === getWslSelectionKey(null)
        ? account.wslDistro?.trim()
        : selectedDistroKey.trim() || account.wslDistro?.trim()
    if (!distro) {
      return
    }

    const runtimeHomePath = this.wslRuntimeHomePathByDistro.get(distro)
    if (!runtimeHomePath) {
      return
    }

    this.readBackRefreshedTokensFromPath(join(runtimeHomePath, 'auth.json'), {
      updateLastWrittenAuthJson: true,
      lastWrittenAuthJson: this.lastWrittenWslAuthJsonByDistro.get(distro) ?? null,
      setLastWrittenAuthJson: (contents) => {
        this.lastWrittenWslAuthJsonByDistro.set(distro, contents)
      },
      expectedAccountId: account.id
    })
  }

  protected safeMigrateLegacyWslActiveHomePointer(distro: string, runtimeHomePath: string): void {
    try {
      this.migrateLegacyWslActiveHomePointer(distro, runtimeHomePath)
    } catch (error) {
      console.warn('[codex-runtime-home] Failed to migrate legacy WSL active Codex home:', error)
    }
  }

  protected migrateLegacyWslActiveHomePointer(distro: string, runtimeHomePath: string): void {
    const runtimeWsl = parseWslUncPath(runtimeHomePath)
    if (!runtimeWsl?.linuxPath.endsWith('/codex-runtime-home/home')) {
      return
    }
    const activeLinuxPath = runtimeWsl.linuxPath.replace(
      /\/codex-runtime-home\/home$/,
      '/codex-runtime-home/active/wsl/home'
    )
    const nextLinuxPath = `${activeLinuxPath}.next-${process.pid}-${Date.now()}`
    const activeLinuxParentPath = this.dirnameLinuxPath(activeLinuxPath)
    // Why: login-shell cleanup turns `exit 0` into status 1, so fall through.
    execFileSync(
      'wsl.exe',
      [
        '-d',
        distro,
        '--exec',
        'bash',
        '-lc',
        [
          'set -e',
          `if [ ! -e ${quotePosixShell(activeLinuxPath)} ] && [ ! -L ${quotePosixShell(activeLinuxPath)} ]; then :`,
          `elif [ -e ${quotePosixShell(activeLinuxPath)} ] && [ ! -L ${quotePosixShell(activeLinuxPath)} ]; then :`,
          'else',
          `mkdir -p ${quotePosixShell(activeLinuxParentPath)}`,
          `rm -rf -- ${quotePosixShell(nextLinuxPath)}`,
          `ln -s -- ${quotePosixShell(runtimeWsl.linuxPath)} ${quotePosixShell(nextLinuxPath)}`,
          `mv -Tf -- ${quotePosixShell(nextLinuxPath)} ${quotePosixShell(activeLinuxPath)}`,
          'fi'
        ].join('\n')
      ],
      // wsl.exe is console-subsystem: without this a GUI-launched Orca flashes
      // a conhost and steals foreground for up to the timeout (#10488).
      { stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000, windowsHide: true }
    )
  }

  protected dirnameLinuxPath(value: string): string {
    const index = value.lastIndexOf('/')
    return index > 0 ? value.slice(0, index) : '/'
  }

  protected joinWslPath(basePath: string, ...segments: string[]): string {
    return parseWslUncPath(basePath)
      ? pathWin32.join(basePath, ...segments)
      : join(basePath, ...segments)
  }

  protected resolveWslDefaultTarget(
    target: CodexAccountSelectionTarget
  ): CodexAccountSelectionTarget {
    if (target.runtime !== 'wsl' || target.wslDistro?.trim()) {
      return target
    }
    const defaultDistro = getDefaultWslDistro()
    return defaultDistro ? { runtime: 'wsl', wslDistro: defaultDistro } : target
  }

  protected getWslSystemCodexAuthPath(target: CodexAccountSelectionTarget): string | null {
    const home = this.getWslSystemCodexHomePath(target)
    return home ? this.joinWslPath(home, 'auth.json') : null
  }

  protected seedWslRuntimeHome(
    runtimeHomePath: string,
    activeAccount: CodexManagedAccount | null,
    distro: string
  ): void {
    const runtimeConfigPath = join(runtimeHomePath, 'config.toml')
    if (existsSync(runtimeConfigPath)) {
      return
    }

    const candidateHomes = [
      activeAccount?.managedHomePath,
      this.getWslSystemCodexHomePath({ runtime: 'wsl', wslDistro: distro })
    ].filter((value): value is string => Boolean(value))
    for (const homePath of candidateHomes) {
      const configPath = join(homePath, 'config.toml')
      if (existsSync(configPath)) {
        writeFileAtomically(
          runtimeConfigPath,
          prepareWslRuntimeSeedConfig(readFileSync(configPath, 'utf-8'), homePath)
        )
        return
      }
    }
  }
}
