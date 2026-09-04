import type { MobileWebBridgeErrorCode } from '../../../src/shared/mobile-web/bridge-contract'
import { MobileWebAccountSubscriptions } from './mobile-web-account-subscriptions'
import type { MobileWebBrowserAuthority } from './mobile-web-browser-authority'
import { MobileWebBrowserStreams } from './mobile-web-browser-streams'
import type { MobileWebBrokerMessageSender } from './mobile-web-broker-message-sender'
import { MobileWebSessionSubscriptions } from './mobile-web-session-subscriptions'
import type { MobileWebNativeChatAuthority } from './mobile-web-native-chat-authority'
import { MobileWebNativeChatSubscriptions } from './mobile-web-native-chat-subscriptions'
import { MobileWebSourceControlSubscriptions } from './mobile-web-source-control-subscriptions'
import type { MobileWebWorkspaceAuthority } from './mobile-web-workspace-authority'
import { MobileWebWorkspaceSubscriptions } from './mobile-web-workspace-subscriptions'

export class MobileWebCapabilitySubscriptions {
  readonly account: MobileWebAccountSubscriptions
  readonly browser: MobileWebBrowserStreams
  readonly nativeChat: MobileWebNativeChatSubscriptions
  readonly session: MobileWebSessionSubscriptions
  readonly sourceControl: MobileWebSourceControlSubscriptions
  readonly workspace: MobileWebWorkspaceSubscriptions

  constructor(args: {
    isActive: () => boolean
    messages: MobileWebBrokerMessageSender
    browserAuthority: MobileWebBrowserAuthority
    nativeChatAuthority: MobileWebNativeChatAuthority
    workspaceAuthority: MobileWebWorkspaceAuthority
  }) {
    const postEvent = (subscriptionId: string, sequence: number, event: unknown) =>
      args.messages.event(subscriptionId, sequence, event)
    const postError = (requestId: string, code: MobileWebBridgeErrorCode, retryable: boolean) =>
      args.messages.error(requestId, code, retryable)
    this.account = new MobileWebAccountSubscriptions({ isActive: args.isActive, postEvent })
    this.browser = new MobileWebBrowserStreams({
      isActive: args.isActive,
      workspaceAuthority: args.workspaceAuthority,
      browserAuthority: args.browserAuthority,
      postEvent
    })
    this.nativeChat = new MobileWebNativeChatSubscriptions({
      isActive: args.isActive,
      nativeChatAuthority: args.nativeChatAuthority,
      workspaceAuthority: args.workspaceAuthority,
      postEvent
    })
    this.session = new MobileWebSessionSubscriptions({
      isActive: args.isActive,
      postError,
      browserAuthority: args.browserAuthority,
      nativeChatAuthority: args.nativeChatAuthority,
      postEvent
    })
    this.sourceControl = new MobileWebSourceControlSubscriptions({
      isActive: args.isActive,
      workspaceAuthority: args.workspaceAuthority,
      postEvent
    })
    this.workspace = new MobileWebWorkspaceSubscriptions({ isActive: args.isActive, postEvent })
  }

  countForOperation(operationKey: string): number {
    return (
      this.account.countForOperation(operationKey) +
      this.browser.countForOperation(operationKey) +
      this.nativeChat.countForOperation(operationKey) +
      this.session.countForOperation(operationKey) +
      this.sourceControl.countForOperation(operationKey) +
      this.workspace.countForOperation(operationKey)
    )
  }

  cancel(subscriptionId: string): string | null {
    return (
      this.account.cancel(subscriptionId) ??
      this.browser.cancel(subscriptionId) ??
      this.nativeChat.cancel(subscriptionId) ??
      this.session.cancel(subscriptionId) ??
      this.sourceControl.cancel(subscriptionId) ??
      this.workspace.cancel(subscriptionId)
    )
  }

  cancelByRequest(requestId: string): void {
    this.account.cancelByRequest(requestId)
    this.browser.cancelByRequest(requestId)
    this.nativeChat.cancelByRequest(requestId)
    this.session.cancelByRequest(requestId)
    this.sourceControl.cancelByRequest(requestId)
    this.workspace.cancelByRequest(requestId)
  }

  dispose(): void {
    this.account.dispose()
    this.browser.dispose()
    this.nativeChat.dispose()
    this.session.dispose()
    this.sourceControl.dispose()
    this.workspace.dispose()
  }
}
