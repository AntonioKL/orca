import { Buffer } from 'buffer/'
import {
  MobileWebMarkdownDraftReadPayloadSchema,
  MobileWebMarkdownDraftReadResultSchema,
  MobileWebMarkdownDraftWritePayloadSchema,
  MobileWebMarkdownReadPayloadSchema,
  MobileWebMarkdownReadResultSchema,
  MobileWebMarkdownSavePayloadSchema,
  MobileWebMarkdownSaveResultSchema
} from '../../../src/shared/mobile-web/bridge-operation-contract'
import {
  isMarkdownContentByteLengthOverLimit,
  MOBILE_MARKDOWN_EDIT_MAX_BYTES
} from '../../../src/shared/mobile-markdown-document'
import {
  buildMarkdownDiskFallbackDoc,
  shouldReadMarkdownFromDiskAfterReadTabFailure
} from '../session/mobile-markdown-disk-fallback'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcFailure } from '../transport/types'
import { MobileWebBrokerError } from './mobile-web-broker-error'
import type { MobileWebNativeCapabilityAuthority } from './mobile-web-native-capability-authority'
import type {
  MobileWebHostWorkspaceId,
  MobileWebWorkspaceAuthority
} from './mobile-web-workspace-authority'

type MarkdownOperationArgs = {
  operation: string
  payload: unknown
  client: RpcClient
  workspaceAuthority: MobileWebWorkspaceAuthority
  nativeAuthority: Pick<
    MobileWebNativeCapabilityAuthority,
    'sessionMarkdownDraftRead' | 'sessionMarkdownDraftWrite'
  >
}

type MarkdownTarget = {
  workspaceId: string
  tabId: string
  relativePath: string
}

export async function executeMobileWebMarkdownOperation(
  args: MarkdownOperationArgs
): Promise<unknown> {
  if (args.operation === 'markdownRead') {
    const payload = MobileWebMarkdownReadPayloadSchema.parse(args.payload)
    const hostWorkspaceId = await verifyMarkdownTarget(args, payload)
    return readMarkdown(args.client, payload, hostWorkspaceId)
  }
  if (args.operation === 'markdownSave') {
    const payload = MobileWebMarkdownSavePayloadSchema.parse(args.payload)
    const hostWorkspaceId = await verifyMarkdownTarget(args, payload)
    args.workspaceAuthority.assertHostWorkspaceBinding(payload.workspaceId, hostWorkspaceId)
    return saveMarkdown(args.client, payload, hostWorkspaceId)
  }
  if (args.operation === 'markdownDraftRead') {
    const payload = MobileWebMarkdownDraftReadPayloadSchema.parse(args.payload)
    const hostWorkspaceId = await verifyMarkdownTarget(args, payload)
    if (!args.nativeAuthority.sessionMarkdownDraftRead) {
      throw new MobileWebBrokerError('unsupported_capability')
    }
    const draft = await args.nativeAuthority.sessionMarkdownDraftRead(
      hostWorkspaceId,
      payload.tabId,
      payload.relativePath
    )
    return parseHostResult(
      MobileWebMarkdownDraftReadResultSchema,
      targetResult(payload, {
        draft: draft
          ? {
              contentBase64: encodeMarkdownContent(draft.content),
              baseVersion: draft.baseVersion
            }
          : null
      })
    )
  }
  if (args.operation === 'markdownDraftWrite') {
    const payload = MobileWebMarkdownDraftWritePayloadSchema.parse(args.payload)
    const hostWorkspaceId = await verifyMarkdownTarget(args, payload)
    if (!args.nativeAuthority.sessionMarkdownDraftWrite) {
      throw new MobileWebBrokerError('unsupported_capability')
    }
    args.workspaceAuthority.assertHostWorkspaceBinding(payload.workspaceId, hostWorkspaceId)
    await args.nativeAuthority.sessionMarkdownDraftWrite(
      hostWorkspaceId,
      payload.tabId,
      payload.relativePath,
      payload.draft
        ? {
            content: decodeMarkdownContent(payload.draft.contentBase64),
            baseVersion: payload.draft.baseVersion
          }
        : null
    )
    return null
  }
  throw new MobileWebBrokerError('unsupported_capability')
}

async function verifyMarkdownTarget(
  args: MarkdownOperationArgs,
  target: MarkdownTarget
): Promise<MobileWebHostWorkspaceId> {
  const hostWorkspaceId = args.workspaceAuthority.hostWorkspaceId(target.workspaceId)
  const response = await args.client.sendRequest('session.tabs.list', {
    worktree: `id:${hostWorkspaceId}`
  })
  const result = response.ok && isRecord(response.result) ? response.result : null
  const tab =
    result?.worktree === hostWorkspaceId && Array.isArray(result.tabs)
      ? result.tabs.find(
          (value) =>
            isRecord(value) &&
            value.id === target.tabId &&
            value.type === 'markdown' &&
            value.relativePath === target.relativePath
        )
      : null
  if (!tab) {
    throw new MobileWebBrokerError('not_found')
  }
  return hostWorkspaceId
}

async function readMarkdown(
  client: RpcClient,
  payload: MarkdownTarget & { tabIsDirty: boolean },
  hostWorkspaceId: string
) {
  const response = await client.sendRequest('markdown.readTab', {
    worktree: `id:${hostWorkspaceId}`,
    tabId: payload.tabId
  })
  if (!response.ok) {
    if (!shouldReadMarkdownFromDiskAfterReadTabFailure(response as RpcFailure)) {
      throw new MobileWebBrokerError('host_error')
    }
    return readMarkdownFallback(client, payload, hostWorkspaceId)
  }
  const result = response.result
  if (
    !isRecord(result) ||
    result.tabId !== payload.tabId ||
    result.relativePath !== payload.relativePath ||
    typeof result.content !== 'string' ||
    typeof result.version !== 'string' ||
    typeof result.isDirty !== 'boolean' ||
    typeof result.editable !== 'boolean'
  ) {
    throw new MobileWebBrokerError('host_error')
  }
  return parseHostResult(
    MobileWebMarkdownReadResultSchema,
    targetResult(payload, {
      contentBase64: encodeMarkdownContent(result.content),
      baseVersion: result.version,
      editable: result.editable,
      stale: result.isDirty,
      ...(typeof result.readOnlyReason === 'string'
        ? { readOnlyReason: result.readOnlyReason }
        : {})
    })
  )
}

async function readMarkdownFallback(
  client: RpcClient,
  payload: MarkdownTarget & { tabIsDirty: boolean },
  hostWorkspaceId: string
) {
  const response = await client.sendRequest('files.read', {
    worktree: `id:${hostWorkspaceId}`,
    relativePath: payload.relativePath
  })
  const result = response.ok ? response.result : null
  if (
    !isRecord(result) ||
    result.worktree !== hostWorkspaceId ||
    result.relativePath !== payload.relativePath ||
    typeof result.content !== 'string' ||
    typeof result.truncated !== 'boolean'
  ) {
    throw new MobileWebBrokerError('host_error')
  }
  const fallback = buildMarkdownDiskFallbackDoc({
    content: result.content,
    truncated: result.truncated,
    tabIsDirty: payload.tabIsDirty
  })
  return parseHostResult(
    MobileWebMarkdownReadResultSchema,
    targetResult(payload, {
      contentBase64: encodeMarkdownContent(fallback.content),
      baseVersion: fallback.baseVersion,
      editable: fallback.editable,
      stale: fallback.stale === true,
      readOnlyReason: fallback.readOnlyReason
    })
  )
}

async function saveMarkdown(
  client: RpcClient,
  payload: MarkdownTarget & { baseVersion: string; contentBase64: string },
  hostWorkspaceId: string
) {
  const response = await client.sendRequest('markdown.saveTab', {
    worktree: `id:${hostWorkspaceId}`,
    tabId: payload.tabId,
    baseVersion: payload.baseVersion,
    content: decodeMarkdownContent(payload.contentBase64)
  })
  if (!response.ok) {
    const failure = response as RpcFailure
    if (failure.error.code === 'conflict' || failure.error.message === 'conflict') {
      throw new MobileWebBrokerError('conflict')
    }
    throw new MobileWebBrokerError('host_error')
  }
  const result = response.result
  if (
    !isRecord(result) ||
    result.tabId !== payload.tabId ||
    result.isDirty !== false ||
    typeof result.content !== 'string' ||
    typeof result.version !== 'string'
  ) {
    throw new MobileWebBrokerError('host_error')
  }
  return parseHostResult(
    MobileWebMarkdownSaveResultSchema,
    targetResult(payload, {
      contentBase64: encodeMarkdownContent(result.content),
      baseVersion: result.version
    })
  )
}

function encodeMarkdownContent(content: string): string {
  if (isMarkdownContentByteLengthOverLimit(content, MOBILE_MARKDOWN_EDIT_MAX_BYTES)) {
    throw new MobileWebBrokerError('host_error')
  }
  return Buffer.from(content, 'utf8').toString('base64')
}

function decodeMarkdownContent(contentBase64: string): string {
  const bytes = Buffer.from(contentBase64, 'base64')
  const content = bytes.toString('utf8')
  if (
    bytes.byteLength > MOBILE_MARKDOWN_EDIT_MAX_BYTES ||
    !Buffer.from(content, 'utf8').equals(bytes)
  ) {
    throw new MobileWebBrokerError('invalid_request')
  }
  return content
}

function targetResult(target: MarkdownTarget, result: Record<string, unknown>) {
  return {
    workspaceId: target.workspaceId,
    tabId: target.tabId,
    relativePath: target.relativePath,
    ...result
  }
}

function parseHostResult<T>(
  schema: { safeParse(value: unknown): { success: boolean; data?: T } },
  value: unknown
): T {
  const parsed = schema.safeParse(value)
  if (!parsed.success) {
    throw new MobileWebBrokerError('host_error')
  }
  return parsed.data as T
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
