import {
  MobileWebSessionSubscribePayloadSchema,
  MobileWebWorkspaceSubscribePayloadSchema
} from '../../../src/shared/mobile-web/bridge-operation-contract'
import { MobileWebSourceControlSubscribePayloadSchema } from '../../../src/shared/mobile-web/source-control-operation-contract'
import { MobileWebSpeechSubscribePayloadSchema } from '../../../src/shared/mobile-web/speech-operation-contract'
import { executeMobileWebAccountCapability } from './mobile-web-account-capability'
import { executeMobileWebAgentHistoryOperation } from './mobile-web-agent-history-operations'
import {
  mobileWebUserGestureConsumer,
  mobileWebUserGestureWitness
} from './mobile-web-user-gesture-requirement'
import { MobileWebBrokerError } from './mobile-web-broker-error'
import { executeMobileWebBrowserOperation } from './mobile-web-browser-operations'
import type { MobileWebCapabilityExecutionDependencies } from './mobile-web-capability-execution-dependencies'
import { executeMobileWebFileOperation } from './mobile-web-file-operations'
import { executeMobileWebMarkdownOperation } from './mobile-web-markdown-operations'
import { executeMobileWebNavigationOperation } from './mobile-web-navigation-operations'
import { executeMobileWebNativeCapabilityOperation } from './mobile-web-native-capability-operations'
import { executeMobileWebNativeChatCapability } from './mobile-web-native-chat-capability'
import { executeMobileWebProviderOperation } from './mobile-web-provider-review-operations'
import { executeMobileWebProviderReviewDiff } from './mobile-web-provider-review-diff'
import { executeMobileWebSessionOperation } from './mobile-web-session-operations'
import { executeMobileWebSourceControlOperation } from './mobile-web-source-control-operations'
import { executeMobileWebSpeechOperation } from './mobile-web-speech-operations'
import { executeMobileWebTaskReadOperation } from './mobile-web-task-read-operations'
import { executeMobileWebWorkspaceOperation } from './mobile-web-workspace-operations'

export async function executeMobileWebCapabilityRequest(
  args: MobileWebCapabilityExecutionDependencies
): Promise<unknown> {
  const request = args.request
  if (request.mode === 'once' && request.capability === 'native') {
    return executeMobileWebNativeCapabilityOperation({
      operation: request.operation,
      payload: request.payload,
      authority: args.nativeAuthority,
      browserAuthority: args.browserAuthority,
      workspaceAuthority: args.workspaceAuthority,
      consumeRecentUserGesture: mobileWebUserGestureConsumer(args.navigationAuthority),
      hasRecentUserGesture: mobileWebUserGestureWitness(args.navigationAuthority)
    })
  }
  if (request.capability === 'nativeChat') {
    return executeMobileWebNativeChatCapability(args, request)
  }
  if (request.mode === 'once' && request.capability === 'navigation') {
    return executeMobileWebNavigationOperation({
      requestId: request.requestId,
      operation: request.operation,
      payload: request.payload,
      authority: args.navigationAuthority
    })
  }
  if (request.mode === 'once' && request.capability === 'agentHistory') {
    return executeMobileWebAgentHistoryOperation(args)
  }
  if (request.capability === 'account') {
    return executeMobileWebAccountCapability(args)
  }
  if (
    request.mode === 'subscription' &&
    request.capability === 'browser' &&
    request.operation === 'subscribe'
  ) {
    args.browserStreams.start({
      requestId: request.requestId,
      subscriptionId: request.subscriptionId,
      payload: request.payload,
      client: args.connectedClient()
    })
    return null
  }
  if (request.mode === 'once' && request.capability === 'browser') {
    return executeMobileWebBrowserOperation({
      operation: request.operation,
      payload: request.payload,
      client: args.connectedClient(),
      workspaceAuthority: args.workspaceAuthority,
      browserAuthority: args.browserAuthority
    })
  }
  if (
    request.mode === 'once' &&
    (request.capability === 'workspace' || request.capability === 'settings')
  ) {
    const result = await executeMobileWebWorkspaceOperation({
      capability: request.capability,
      operation: request.operation,
      payload: request.payload,
      client: args.connectedClient(),
      authority: args.workspaceAuthority,
      snapshots: args.workspaceSnapshots,
      consumeRecentUserGesture: mobileWebUserGestureConsumer(args.navigationAuthority)
    })
    if (request.capability === 'workspace' && request.operation === 'activate') {
      args.terminalArtifactAuthority.clear()
    }
    return result
  }
  if (
    request.mode === 'subscription' &&
    request.capability === 'workspace' &&
    request.operation === 'subscribe'
  ) {
    MobileWebWorkspaceSubscribePayloadSchema.parse(request.payload)
    args.workspaceSubscriptions.start({
      requestId: request.requestId,
      subscriptionId: request.subscriptionId,
      client: args.connectedClient()
    })
    return null
  }
  if (request.mode === 'once' && request.capability === 'session') {
    const result = await executeMobileWebSessionOperation({
      operation: request.operation,
      payload: request.payload,
      requestId: request.requestId,
      client: args.connectedClient(),
      workspaceAuthority: args.workspaceAuthority,
      browserAuthority: args.browserAuthority,
      nativeChatAuthority: args.nativeChatAuthority
    })
    if (
      request.operation === 'create' ||
      request.operation === 'createAgent' ||
      request.operation === 'createQuickCommand' ||
      request.operation === 'createBrowser' ||
      request.operation === 'activate' ||
      request.operation === 'close'
    ) {
      args.terminalArtifactAuthority.clear()
    }
    return result
  }
  if (
    request.mode === 'subscription' &&
    request.capability === 'session' &&
    request.operation === 'subscribe'
  ) {
    const payload = MobileWebSessionSubscribePayloadSchema.parse(request.payload)
    const hostWorkspaceId = args.workspaceAuthority.hostWorkspaceId(payload.workspaceId)
    args.sessionSubscriptions.start({
      requestId: request.requestId,
      subscriptionId: request.subscriptionId,
      pageWorkspaceId: payload.workspaceId,
      hostWorkspaceId,
      client: args.connectedClient()
    })
    return null
  }
  if (
    request.mode === 'subscription' &&
    request.capability === 'terminal' &&
    request.operation === 'subscribe'
  ) {
    await args.terminalStreams.start({
      requestId: request.requestId,
      subscriptionId: request.subscriptionId,
      payload: request.payload,
      client: args.connectedClient(),
      isRequestActive: args.isRequestActive
    })
    return null
  }
  if (request.mode === 'once' && request.capability === 'terminal') {
    return args.terminalStreams.handle(
      request.payload,
      args.connectedClient(),
      mobileWebUserGestureConsumer(args.navigationAuthority)
    )
  }
  if (request.mode === 'once' && request.capability === 'file') {
    const client = args.connectedClient()
    if (request.operation.startsWith('markdown')) {
      return executeMobileWebMarkdownOperation({
        ...args,
        ...request,
        client
      })
    }
    if (request.operation === 'resolveTerminalPath') {
      return args.terminalArtifactAuthority.resolve(
        request.payload,
        client,
        args.workspaceAuthority
      )
    }
    if (request.operation === 'readTerminalArtifactChunk') {
      return args.terminalArtifactAuthority.readChunk(request.payload, client)
    }
    if (request.operation === 'releaseTerminalArtifact') {
      return args.terminalArtifactAuthority.release(request.payload)
    }
    return executeMobileWebFileOperation({
      operation: request.operation,
      payload: request.payload,
      client,
      workspaceAuthority: args.workspaceAuthority
    })
  }
  if (request.mode === 'once' && request.capability === 'provider') {
    if (request.operation === 'reviewDiff') {
      return executeMobileWebProviderReviewDiff(
        request.payload,
        args.connectedClient(),
        args.workspaceAuthority
      )
    }
    return executeMobileWebProviderOperation({
      operation: request.operation,
      payload: request.payload,
      client: args.connectedClient(),
      workspaceAuthority: args.workspaceAuthority
    })
  }
  if (request.mode === 'once' && request.capability === 'sourceControl') {
    if (request.operation === 'generateCommitMessage') {
      return args.commitMessageGeneration.generate({
        requestId: request.requestId,
        payload: request.payload,
        client: args.connectedClient(),
        workspaceAuthority: args.workspaceAuthority
      })
    }
    if (request.operation === 'cancelCommitMessageGeneration') {
      return args.commitMessageGeneration.cancel(
        request.payload,
        args.connectedClient(),
        args.workspaceAuthority
      )
    }
    return executeMobileWebSourceControlOperation({
      operation: request.operation,
      payload: request.payload,
      client: args.connectedClient(),
      workspaceAuthority: args.workspaceAuthority,
      branchComparePager: args.sourceControlBranchCompare,
      requestId: request.requestId,
      terminalClientId: args.terminalClientId
    })
  }
  if (
    request.mode === 'subscription' &&
    request.capability === 'speech' &&
    request.operation === 'subscribe'
  ) {
    MobileWebSpeechSubscribePayloadSchema.parse(request.payload)
    args.speechAuthority.subscribe({
      requestId: request.requestId,
      subscriptionId: request.subscriptionId,
      post: (sequence, event) => args.postSpeechEvent(request.subscriptionId, sequence, event)
    })
    return null
  }
  if (request.mode === 'once' && request.capability === 'speech') {
    return executeMobileWebSpeechOperation({
      operation: request.operation,
      payload: request.payload,
      client: args.connectedClient(),
      authority: args.speechAuthority,
      consumeRecentUserGesture: mobileWebUserGestureConsumer(args.navigationAuthority)
    })
  }
  if (request.mode === 'once' && request.capability === 'task') {
    return executeMobileWebTaskReadOperation({
      operation: request.operation,
      payload: request.payload,
      client: args.connectedClient(),
      authority: args.workspaceAuthority,
      targetAuthority: args.taskTargetAuthority,
      projectTable: args.taskProjectTable
    })
  }
  if (
    request.mode === 'subscription' &&
    request.capability === 'sourceControl' &&
    request.operation === 'subscribe'
  ) {
    const payload = MobileWebSourceControlSubscribePayloadSchema.parse(request.payload)
    const hostWorkspaceId = args.workspaceAuthority.hostWorkspaceId(payload.workspaceId)
    args.sourceControlSubscriptions.start({
      requestId: request.requestId,
      subscriptionId: request.subscriptionId,
      pageWorkspaceId: payload.workspaceId,
      hostWorkspaceId,
      client: args.connectedClient()
    })
    return null
  }
  throw new MobileWebBrokerError('unsupported_capability')
}
