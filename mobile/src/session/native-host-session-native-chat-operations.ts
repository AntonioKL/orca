import type { RpcClient } from '../transport/rpc-client'
import { buildNativeChatSubscriptionId } from '../../../src/shared/native-chat-stream-unsubscribe'
import { isFloatingWorkspaceWorktreeId } from './floating-workspace'
import { isMobileNativeChatTranscriptReadable } from './mobile-native-chat-eligibility'
import { openMobileNativeChatFile } from './mobile-native-chat-open-file'
import { healMobileNativeChatStaleInput } from './mobile-native-chat-stale-input'
import {
  sendMobileNativeChatMessageWithOutcome,
  typeMobileNativeChatCommandWithOutcome,
  type MobileNativeChatSendOutcome
} from './mobile-native-chat-send'
import { rankSuggestions } from './mobile-native-chat-autocomplete'
import { getRepoIdFromMobileWorktreeId } from './mobile-session-route-helpers'
import type {
  HostSessionNativeChatOperations,
  HostSessionNativeChatTarget
} from './host-session-native-chat-operations'

const FILE_RESULT_LIMIT = 16

export function nativeHostSessionNativeChatOperations(
  client: RpcClient
): HostSessionNativeChatOperations {
  let searchSupported: boolean | null = null
  let legacyPaths: string[] | null = null
  let legacyLoad: Promise<string[] | null> | null = null
  return {
    async readability(workspaceId) {
      if (isFloatingWorkspaceWorktreeId(workspaceId)) {
        return true
      }
      const response = await client.sendRequest('repo.list')
      const repos = response.ok
        ? ((response.result as { repos?: { id: string; connectionId?: string | null }[] }).repos ??
          [])
        : []
      const repo = repos.find(
        (candidate) => candidate.id === getRepoIdFromMobileWorktreeId(workspaceId)
      )
      return repo ? isMobileNativeChatTranscriptReadable(repo.connectionId ?? null) : false
    },
    subscribe(target, limit, onEvent) {
      return client.subscribe(
        'nativeChat.subscribe',
        {
          ...nativeChatReadParams(target, limit),
          subscriptionId: buildNativeChatSubscriptionId(target.agent, target.sessionId)
        },
        (value) => onEvent(value as Parameters<typeof onEvent>[0])
      )
    },
    async read(target, limit, beforeOffset) {
      try {
        const response = await client.sendRequest('nativeChat.readSession', {
          ...nativeChatReadParams(target, limit),
          ...(beforeOffset === undefined ? {} : { beforeOffset })
        })
        return response.ok
          ? (response.result as Awaited<ReturnType<HostSessionNativeChatOperations['read']>>)
          : { error: response.error.message }
      } catch {
        return { error: 'Transcript read failed' }
      }
    },
    sendMessage(target, text, deadline, clearInputFirst, resolvedLaunchDraft, typeCommand) {
      if (typeCommand && target.terminalId) {
        return typeMobileNativeChatCommandWithOutcome({
          client,
          terminal: target.terminalId,
          command: text,
          resolvedLaunchDraft,
          deadline,
          ...(target.clientId
            ? { mobileClient: { id: target.clientId, type: 'mobile' as const } }
            : {})
        })
      }
      return sendNative(target, text, true, client, deadline, clearInputFirst, resolvedLaunchDraft)
    },
    prepareCommit(target, deadline) {
      if (!target.terminalId) {
        return Promise.resolve(false)
      }
      return healMobileNativeChatStaleInput({
        client,
        terminal: target.terminalId,
        deviceToken: target.clientId,
        deadline
      })
    },
    respond(target, text, enter, deadline) {
      return sendNative(target, text, enter, client, deadline)
    },
    stop(target, deadline) {
      return sendNative(target, escape(), true, client, deadline)
    },
    async searchFiles(target, query) {
      if (searchSupported !== false) {
        const response = await client.sendRequest('files.searchPaths', {
          worktree: `id:${target.workspaceId}`,
          query,
          limit: FILE_RESULT_LIMIT
        })
        if (response.ok) {
          searchSupported = true
          return extractPaths(response.result)
        }
        if (response.error.code !== 'method_not_found') {
          return []
        }
        searchSupported = false
      }
      if (!legacyPaths) {
        if (!legacyLoad) {
          legacyLoad = client
            .sendRequest('files.list', {
              worktree: `id:${target.workspaceId}`
            })
            .then((response) => (response.ok ? extractPaths(response.result) : null))
            .finally(() => {
              legacyLoad = null
            })
        }
        const paths = await legacyLoad
        if (!paths) {
          return []
        }
        legacyPaths = paths
      }
      return rankSuggestions(legacyPaths, query, FILE_RESULT_LIMIT)
    },
    openFile(target, pathText) {
      return openMobileNativeChatFile({
        client,
        worktreeId: target.workspaceId,
        pathText,
        terminal: target.terminalId
      })
    }
  }
}

function nativeChatReadParams(target: HostSessionNativeChatTarget, limit: number) {
  return {
    agent: target.agent,
    sessionId: target.sessionId,
    limit,
    ...(target.transcriptPath ? { transcriptPath: target.transcriptPath } : {}),
    ...(target.terminalId ? { worktreeId: target.workspaceId, terminal: target.terminalId } : {})
  }
}

function sendNative(
  target: HostSessionNativeChatTarget,
  text: string,
  enter: boolean,
  client: RpcClient,
  deadline?: number,
  clearInputFirst?: boolean,
  resolvedLaunchDraft?: { text: string; createdAt: number }
): Promise<MobileNativeChatSendOutcome> {
  if (!target.terminalId) {
    return Promise.resolve('rejected')
  }
  return sendMobileNativeChatMessageWithOutcome({
    client,
    terminal: target.terminalId,
    text,
    enter,
    clearInputFirst,
    resolvedLaunchDraft,
    deadline,
    ...(target.clientId ? { mobileClient: { id: target.clientId, type: 'mobile' as const } } : {})
  })
}

function escape(): string {
  return String.fromCharCode(27)
}

function extractPaths(result: unknown): string[] {
  const files = (result as { files?: Array<{ relativePath?: string }> }).files ?? []
  return files
    .map((file) => file.relativePath ?? '')
    .filter((path): path is string => path.length > 0)
}
