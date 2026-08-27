import { homedir } from 'node:os'
import { join } from 'node:path'
import { detectInstalledAgentsWithShellPathHydration } from '../preflight/agent-detection'
import { executeSkillInstallRequest } from '../skills/skill-install-request-service'
import { executeSkillBundleInstallRequest } from '../skills/skill-bundle-install-request-service'
import { SkillUploadSessionService } from '../skills/skill-upload-session-service'
import { SKILL_UPLOAD_STAGING_ROOT_NAME } from '../skills/skill-upload-staging-ownership'
import {
  resolveEnvironmentSkillProviderRoots,
  resolveWslGrokSkillProviderRoot,
  withClaudeSkillProviderRoot
} from '../skills/skill-provider-runtime-roots'
import { getWslHome } from '../wsl'
import { parseWslUncPath } from '../../shared/wsl-paths'
import type { IPtyProvider } from '../providers/types'
import type {
  SkillBundleInstallProgress,
  SkillBundleInstallRequest,
  SkillBundleInstallResult
} from '../../shared/skill-bundle-install-contract'
import type { SkillSshWorkspaceAuthority } from '../../shared/skill-ssh-relay-contract'
import type { SkillInstallDestinationAuthority } from '../skills/skill-install-destinations'
import { installSkillBundleOnSshHost } from '../skills/skill-bundle-ssh-relay-service'
import { installSkillOnSshHost } from '../skills/skill-ssh-relay-service'
import type {
  SkillInstallRequest,
  SkillInstallResult,
  SkillProviderRootOverrides
} from './runtime-skill-types'
import type { RuntimeSkillCommandHost } from './runtime-skill-command-surface'

export class RuntimeSkillInstallCommands {
  private skillUploadSessions: SkillUploadSessionService | null = null
  private skillUploadSessionsDisposed = false
  protected readonly operations = new Map<string, AbortController>()
  protected readonly progress = new Map<string, SkillBundleInstallProgress>()

  constructor(protected readonly host: RuntimeSkillCommandHost) {}

  protected userDataPath(): string {
    return this.host.getUserDataPath()
  }
  protected requireUploads(): SkillUploadSessionService {
    if (this.skillUploadSessionsDisposed) {
      throw new Error('skill-upload-service-disposed')
    }
    this.skillUploadSessions ??= new SkillUploadSessionService(
      join(this.userDataPath(), 'skill-installs', SKILL_UPLOAD_STAGING_ROOT_NAME)
    )
    return this.skillUploadSessions
  }
  async disposeSkillUploadSessions(): Promise<void> {
    this.skillUploadSessionsDisposed = true
    const sessions = this.skillUploadSessions
    this.skillUploadSessions = null
    await sessions?.dispose()
  }
  protected async sshTarget(
    destination: SkillInstallRequest['destination']
  ): Promise<{ provider: () => IPtyProvider; workspace?: SkillSshWorkspaceAuthority } | null> {
    if (destination.scope === 'global') {
      const target = destination.executionTarget
      if (target?.kind !== 'ssh') {
        return null
      }
      return { provider: () => this.requireSsh(target.connectionId) }
    }
    if (destination.worktreeId) {
      const repo = this.host
        .listRepos()
        .find((candidate) => candidate.id === destination.worktreeId!.split('::')[0])
      if (!repo?.connectionId) {
        return null
      }
      const worktree = await this.host.showManagedWorktree(`id:${destination.worktreeId}`)
      return {
        provider: () => this.requireSsh(repo.connectionId!),
        workspace: { kind: 'worktree', id: worktree.id, path: worktree.path }
      }
    }
    const folder = this.host
      .listFolderWorkspaces()
      .find((candidate) => candidate.id === destination.folderWorkspaceId)
    return folder?.connectionId
      ? {
          provider: () => this.requireSsh(folder.connectionId!),
          workspace: { kind: 'folder', id: folder.id, path: folder.folderPath }
        }
      : null
  }
  protected requireSsh(connectionId: string): IPtyProvider {
    const provider = this.host.getSshProvider(connectionId)
    if (!provider?.requestHostRpc) {
      throw new Error('skill-install-ssh-relay-unavailable')
    }
    return provider
  }
  protected async roots(destination: {
    scope: 'global' | 'workspace'
    homeDirectory: string
    workspaceDirectory?: string
    wslDistro?: string
  }): Promise<SkillProviderRootOverrides> {
    if (destination.scope !== 'global') {
      return {}
    }
    const grok = destination.wslDistro
      ? await resolveWslGrokSkillProviderRoot(destination.wslDistro)
      : null
    const roots = destination.wslDistro
      ? grok
        ? { grok }
        : {}
      : resolveEnvironmentSkillProviderRoots()
    const config = this.host.getClaudeConfigDirectory?.(
      destination.wslDistro
        ? { runtime: 'wsl', wslDistro: destination.wslDistro }
        : { runtime: 'host' }
    )
    return withClaudeSkillProviderRoot(roots, config)
  }
  protected authority(): SkillInstallDestinationAuthority {
    const runtimeId = this.host.getRuntimeId()
    return {
      environmentId: runtimeId,
      homeDirectory: homedir(),
      resolveWorktree: async (id) => {
        const worktree = await this.host.showManagedWorktree(`id:${id}`).catch(() => null)
        if (!worktree || worktree.id !== id) {
          return null
        }
        const projectRuntime = this.host.resolveProjectRuntimeForWorktree?.(id)
        return {
          id,
          path: worktree.path,
          ...(projectRuntime?.status === 'resolved' &&
          projectRuntime.runtime?.kind === 'wsl' &&
          projectRuntime.runtime.distro
            ? { wslDistro: projectRuntime.runtime.distro }
            : {})
        }
      },
      resolveFolderWorkspace: async (id) => {
        const workspace = this.host.listFolderWorkspaces().find((candidate) => candidate.id === id)
        if (!workspace) {
          return null
        }
        const wsl = parseWslUncPath(workspace.folderPath)
        return {
          id,
          path: workspace.folderPath,
          ...(wsl ? { wslDistro: wsl.distro } : {})
        }
      },
      resolveWsl: async (distro) => {
        if (process.platform !== 'win32') {
          return null
        }
        const homeDirectory = getWslHome(distro)
        return homeDirectory ? { homeDirectory } : null
      }
    }
  }
  private async executeInstall(
    request: SkillInstallRequest,
    signal: AbortSignal
  ): Promise<SkillInstallResult> {
    const target = await this.sshTarget(request.destination)
    if (target) {
      return installSkillOnSshHost({
        provider: target.provider,
        userDataPath: this.userDataPath(),
        request: {
          ...request,
          destination:
            request.destination.scope === 'global'
              ? { scope: 'global', executionTarget: { kind: 'host' } }
              : request.destination
        },
        workspace: target.workspace,
        requireHttps: this.host.isPackaged(),
        signal
      })
    }
    await this.host.skillTransactionRecovery
    const origins = ['https://storage.googleapis.com']
    if (!this.host.isPackaged() && process.env.ORCA_SKILL_PACKAGE_DOWNLOAD_ORIGINS) {
      origins.push(
        ...process.env.ORCA_SKILL_PACKAGE_DOWNLOAD_ORIGINS.split(',')
          .map((value) => value.trim())
          .filter(Boolean)
      )
    }
    return executeSkillInstallRequest(request, {
      authority: this.authority(),
      stateDirectory: this.userDataPath(),
      allowedDownloadOrigins: [...new Set(origins)],
      requireHttps: this.host.isPackaged(),
      resolveStagedUpload: (uploadId, identity) => this.requireUploads().take(uploadId, identity),
      detectProviders: detectInstalledAgentsWithShellPathHydration,
      resolveProviderRootOverrides: (destination) => this.roots(destination),
      signal
    })
  }
  async installSharedSkillRequest(
    request: SkillInstallRequest,
    signal?: AbortSignal
  ): Promise<SkillInstallResult> {
    if (this.operations.has(request.operationId)) {
      throw new Error('skill-install-operation-in-progress')
    }
    const controller = new AbortController()
    const abort = () => controller.abort()
    if (signal?.aborted) {
      abort()
    } else {
      signal?.addEventListener('abort', abort, { once: true })
    }
    this.operations.set(request.operationId, controller)
    try {
      return await this.executeInstall(request, controller.signal)
    } finally {
      signal?.removeEventListener('abort', abort)
      if (this.operations.get(request.operationId) === controller) {
        this.operations.delete(request.operationId)
      }
    }
  }
  async installSharedSkillBundleRequest(
    request: SkillBundleInstallRequest,
    signal?: AbortSignal,
    onProgress?: (progress: SkillBundleInstallProgress) => void
  ): Promise<SkillBundleInstallResult> {
    if (this.operations.has(request.operationId)) {
      throw new Error('skill-install-operation-in-progress')
    }
    const controller = new AbortController()
    const abort = () => controller.abort()
    signal?.addEventListener('abort', abort, { once: true })
    this.operations.set(request.operationId, controller)
    const report = (value: SkillBundleInstallProgress) => {
      this.progress.set(request.operationId, value)
      try {
        onProgress?.(value)
      } catch {}
    }
    try {
      const target = await this.sshTarget(request.destination)
      if (target) {
        return await installSkillBundleOnSshHost({
          provider: target.provider,
          userDataPath: this.userDataPath(),
          request,
          workspace: target.workspace,
          requireHttps: this.host.isPackaged(),
          signal: controller.signal,
          onProgress: report
        })
      }
      await this.host.skillTransactionRecovery
      const origins = ['https://storage.googleapis.com']
      if (!this.host.isPackaged() && process.env.ORCA_SKILL_PACKAGE_DOWNLOAD_ORIGINS) {
        origins.push(
          ...process.env.ORCA_SKILL_PACKAGE_DOWNLOAD_ORIGINS.split(',')
            .map((value) => value.trim())
            .filter(Boolean)
        )
      }
      return await executeSkillBundleInstallRequest(request, {
        authority: this.authority(),
        stateDirectory: this.userDataPath(),
        allowedDownloadOrigins: [...new Set(origins)],
        requireHttps: this.host.isPackaged(),
        resolveStagedUpload: (uploadId, identity) => this.requireUploads().take(uploadId, identity),
        detectProviders: detectInstalledAgentsWithShellPathHydration,
        resolveProviderRootOverrides: (destination) => this.roots(destination),
        signal: controller.signal,
        onProgress: report
      })
    } finally {
      signal?.removeEventListener('abort', abort)
      if (this.operations.get(request.operationId) === controller) {
        this.operations.delete(request.operationId)
      }
      this.progress.delete(request.operationId)
    }
  }
  getSharedSkillInstallProgress(operationId: string) {
    return this.progress.get(operationId) ?? null
  }
  cancelSharedSkillInstall(operationId: string): boolean {
    const operation = this.operations.get(operationId)
    operation?.abort()
    return Boolean(operation)
  }
}
