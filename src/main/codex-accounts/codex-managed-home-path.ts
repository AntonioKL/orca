import { lstatSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { app } from 'electron'
import { isDefinitiveAbsence } from '../../shared/definitive-filesystem-absence'
import { parseWslUncPath } from '../../shared/wsl-paths'
import type { CodexManagedAccount } from '../../shared/managed-account-types'
import { getSystemCodexHomePath } from '../codex/codex-home-paths'
import { runWslProcess, type WslResult, type WslSpec } from '../wsl/wsl-runner'
import {
  assertOwnedCodexManagedHomeVerdict,
  assertOwnedHostCodexManagedHomePath,
  ManagedCodexHomeTemporarilyUnavailableError,
  MISSING_MANAGED_HOME_MESSAGE,
  MISSING_OWNERSHIP_MARKER_MESSAGE,
  UntrustedManagedCodexHomeError,
  type HostCodexManagedHomeVerdict
} from './host-codex-managed-home-ownership'
import {
  ACCOUNT_ID_MISMATCH_MESSAGE,
  buildWslCodexManagedHomeProbeScript,
  classifyWslCodexManagedHomeProbe,
  MARKER_ACCOUNT_MISMATCH_MESSAGE,
  OUTSIDE_MANAGED_ROOT_MESSAGE
} from './wsl-codex-managed-home-probe'
import {
  buildWslManagedHomePreparationScript,
  WSL_PREPARE_UNTRUSTED_EXITS
} from './wsl-codex-managed-home-preparation'

const WSL_MANAGED_HOME_TIMEOUT_MS = 5_000

export class CodexManagedHomePath {
  constructor(private readonly validateWslPath: (distro: string, script: string) => string) {}

  getRoot(): string {
    const root = join(app.getPath('userData'), 'codex-accounts')
    mkdirSync(root, { recursive: true })
    return root
  }

  assertHostOwnership(candidatePath: string, expectedAccountId: string): string {
    return assertOwnedHostCodexManagedHomePath({
      candidatePath,
      managedAccountsRoot: join(app.getPath('userData'), 'codex-accounts'),
      systemCodexHomePath: getSystemCodexHomePath(),
      expectedAccountId
    })
  }

  async ensureForReauthentication(account: CodexManagedAccount): Promise<string> {
    const wslInfo = parseWslUncPath(account.managedHomePath)
    if (wslInfo && process.platform === 'win32') {
      await this.ensureExpectedWslHome(account, wslInfo)
      return this.assert(account.managedHomePath, account.id)
    }

    try {
      return this.assert(account.managedHomePath, account.id)
    } catch (error) {
      if (!this.isMissingHomeError(error)) {
        throw error
      }
      return this.recreateExpectedHostHome(account, error)
    }
  }

  assert(candidatePath: string, expectedAccountId?: string): string {
    const wslInfo = parseWslUncPath(candidatePath)
    if (!wslInfo) {
      return assertOwnedHostCodexManagedHomePath({
        candidatePath,
        managedAccountsRoot: this.getRoot(),
        systemCodexHomePath: getSystemCodexHomePath(),
        expectedAccountId
      })
    }
    // Why: the spelling of the persisted path is a fact the host already holds,
    // so a mismatch is dispositive without asking the guest anything.
    if (
      !wslInfo.linuxPath.includes('/.local/share/orca/codex-accounts/') ||
      !wslInfo.linuxPath.endsWith('/home')
    ) {
      throw new UntrustedManagedCodexHomeError(OUTSIDE_MANAGED_ROOT_MESSAGE)
    }
    if (
      expectedAccountId !== undefined &&
      !wslInfo.linuxPath.endsWith(`/.local/share/orca/codex-accounts/${expectedAccountId}/home`)
    ) {
      throw new UntrustedManagedCodexHomeError(ACCOUNT_ID_MISMATCH_MESSAGE)
    }
    if (process.platform === 'win32') {
      return this.assertWindowsWslPath(wslInfo, expectedAccountId)
    }
    return assertOwnedCodexManagedHomeVerdict(
      this.resolveMountedWslVerdict(candidatePath, wslInfo.linuxPath, expectedAccountId)
    )
  }

  private recreateExpectedHostHome(account: CodexManagedAccount, originalError: unknown): string {
    const expectedPath = join(this.getRoot(), account.id, 'home')
    if (!this.pathsEqual(account.managedHomePath, expectedPath)) {
      throw originalError
    }
    // Why: re-auth may recreate a lost empty home, but only at the exact Orca-owned path persisted for this account.
    mkdirSync(expectedPath, { recursive: true })
    writeFileSync(join(expectedPath, '.orca-managed-home'), `${account.id}\n`, 'utf-8')
    return this.assert(expectedPath, account.id)
  }

  private async ensureExpectedWslHome(
    account: CodexManagedAccount,
    wslInfo: { distro: string; linuxPath: string }
  ): Promise<void> {
    if (
      account.managedHomeRuntime !== 'wsl' ||
      account.wslDistro !== wslInfo.distro ||
      account.wslLinuxHomePath !== wslInfo.linuxPath ||
      !wslInfo.linuxPath.endsWith(`/.local/share/orca/codex-accounts/${account.id}/home`)
    ) {
      return
    }
    const result = await this.runManagedHomePreparation({
      distro: wslInfo.distro,
      loginPath: 'none',
      script: buildWslManagedHomePreparationScript(wslInfo.linuxPath, account.id),
      shell: 'bash',
      timeoutMs: WSL_MANAGED_HOME_TIMEOUT_MS
    })
    if (result.timedOut) {
      throw new ManagedCodexHomeTemporarilyUnavailableError(undefined, {
        cause: new Error(
          `Preparing the managed Codex home in WSL ${wslInfo.distro} timed out after ${WSL_MANAGED_HOME_TIMEOUT_MS}ms.`
        )
      })
    }
    // Why: 41/42 mean the path is not this account's home; re-auth must refuse
    // rather than write credentials into someone else's directory. Every other
    // non-zero exit — a cold distro, a missing shell, a 9p hiccup — proves
    // nothing about ownership and must not read as a trust failure (STA-5616).
    const untrustedReason =
      typeof result.code === 'number' ? WSL_PREPARE_UNTRUSTED_EXITS.get(result.code) : undefined
    if (untrustedReason !== undefined) {
      throw new UntrustedManagedCodexHomeError(untrustedReason)
    }
    if (result.code !== 0) {
      throw new ManagedCodexHomeTemporarilyUnavailableError(undefined, {
        cause: new Error(
          `Preparing the managed Codex home in WSL ${wslInfo.distro} exited with code ${String(result.code)}.`
        )
      })
    }
  }

  /**
   * Why: `runWslProcess` rejects outright when `wsl.exe` cannot be launched —
   * the canonical "could not check". Awaiting it bare let that rejection reach
   * callers as a raw spawn error, or as a wrapper's non-Error string, so nothing
   * downstream could recognise it as an unproven observation.
   */
  private async runManagedHomePreparation(spec: WslSpec): Promise<WslResult> {
    try {
      return await runWslProcess(spec)
    } catch (error) {
      throw new ManagedCodexHomeTemporarilyUnavailableError(undefined, { cause: error })
    }
  }

  private assertWindowsWslPath(
    wslInfo: { distro: string; linuxPath: string },
    expectedAccountId?: string
  ): string {
    const script = buildWslCodexManagedHomeProbeScript(wslInfo.linuxPath, expectedAccountId)
    let stdout: string
    try {
      stdout = this.validateWslPath(wslInfo.distro, script)
    } catch (error) {
      // Why: the guest reports its observation on a tagged line and always exits
      // 0, so a throw here is the runner failing — never evidence about the home.
      return assertOwnedCodexManagedHomeVerdict(
        classifyWslCodexManagedHomeProbe({ ran: false, error }, wslInfo.distro)
      )
    }
    return assertOwnedCodexManagedHomeVerdict(
      classifyWslCodexManagedHomeProbe({ ran: true, stdout }, wslInfo.distro)
    )
  }

  /**
   * The same gate for a WSL home reached through a mount rather than `wsl.exe`.
   * Reads go through `statSync`/`lstatSync` rather than `existsSync` so an EPERM
   * or EIO cannot be folded into "does not exist" (STA-4422's collapse).
   */
  private resolveMountedWslVerdict(
    candidatePath: string,
    linuxPath: string,
    expectedAccountId?: string
  ): HostCodexManagedHomeVerdict {
    if (linuxPath.split('/').includes('..')) {
      return { kind: 'untrusted', reason: OUTSIDE_MANAGED_ROOT_MESSAGE }
    }
    try {
      statSync(candidatePath)
    } catch (error) {
      if (isDefinitiveAbsence(error)) {
        return { kind: 'untrusted', reason: MISSING_MANAGED_HOME_MESSAGE }
      }
      return { kind: 'indeterminate', error }
    }
    const markerPath = join(candidatePath, '.orca-managed-home')
    let markerContents: string
    try {
      if (!lstatSync(markerPath).isFile()) {
        return { kind: 'untrusted', reason: MISSING_OWNERSHIP_MARKER_MESSAGE }
      }
      markerContents = readFileSync(markerPath, 'utf-8')
    } catch (error) {
      if (isDefinitiveAbsence(error)) {
        return { kind: 'untrusted', reason: MISSING_OWNERSHIP_MARKER_MESSAGE }
      }
      return { kind: 'indeterminate', error }
    }
    if (expectedAccountId !== undefined && markerContents.trim() !== expectedAccountId) {
      return { kind: 'untrusted', reason: MARKER_ACCOUNT_MISMATCH_MESSAGE }
    }
    return { kind: 'owned', homePath: candidatePath }
  }

  private isMissingHomeError(error: unknown): boolean {
    return error instanceof Error && error.message === MISSING_MANAGED_HOME_MESSAGE
  }

  private pathsEqual(left: string, right: string): boolean {
    const resolvedLeft = resolve(left)
    const resolvedRight = resolve(right)
    return process.platform === 'win32'
      ? resolvedLeft.toLowerCase() === resolvedRight.toLowerCase()
      : resolvedLeft === resolvedRight
  }
}
