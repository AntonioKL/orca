import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { glob } from 'tinyglobby'
import { isTestFile, stripComments } from './source-scan/source-tree-scan'

const HELPERS = [
  'getAgentLabel',
  'isClaudeAgent',
  'titleHasAgentName',
  'buildAgentNameRe',
  'resolveTerminalTitleAgentType',
  'resolveExplicitTerminalTitleAgentType',
  'resolveCommittedTitleAgentType',
  'resolvePaneAgentOwner',
  'resolveCompatibleAgentTypeForOwner'
] as const

const TEST_SUPPORT_PATHS = new Set([
  'src/renderer/src/components/terminal-pane/pty-connection-test-environment.ts'
])

type Helper = (typeof HELPERS)[number]
type Classification =
  | 'parser-implementation'
  | 'activity-only'
  | 'enum-formatter'
  | 'evidence-producer'
  | 'identity-consumer'
  | 'action-consumer'

type InventoryGroup = {
  helper: Helper
  classification: Classification
  paths: readonly string[]
}

const INVENTORY: readonly InventoryGroup[] = [
  {
    helper: 'getAgentLabel',
    classification: 'enum-formatter',
    paths: [
      'src/renderer/src/components/agent-session-continuation/AgentSessionContinuationDialog.tsx',
      'src/renderer/src/components/automations/AutomationListLocalRows.tsx',
      'src/renderer/src/components/automations/automation-draft-model.ts',
      'src/renderer/src/components/dashboard-popout/AgentMapSnapshotWorkspaceMenu.tsx',
      'src/renderer/src/components/dashboard-popout/AgentMapWorktreeRingNode.tsx',
      'src/renderer/src/components/settings/QuickCommandsList.tsx',
      'src/renderer/src/components/tab-bar/TabBarQuickCommandItem.tsx',
      'src/renderer/src/components/tab-bar/TabBarQuickCommandsMenu.tsx',
      'src/renderer/src/lib/agent-catalog.tsx',
      'src/renderer/src/lib/launch-agent-session-continuation.ts',
      'src/renderer/src/lib/orchestration-skill-coverage.ts'
    ]
  },
  {
    helper: 'getAgentLabel',
    classification: 'identity-consumer',
    paths: ['src/renderer/src/lib/agent-status.ts', 'src/renderer/src/lib/pane-agent-evidence.ts']
  },
  {
    helper: 'getAgentLabel',
    classification: 'parser-implementation',
    paths: [
      'src/shared/agent-detection.ts',
      'src/shared/agent-title-identity.ts',
      'src/shared/agent-title-owner.ts',
      'src/shared/terminal-title-agent-type.ts'
    ]
  },
  {
    helper: 'isClaudeAgent',
    classification: 'action-consumer',
    paths: [
      'src/renderer/src/components/terminal-pane/cache-timer-seeding.ts',
      'src/renderer/src/components/terminal-pane/parked-terminal-byte-watcher.ts',
      'src/renderer/src/components/terminal-pane/pty-connection/agent-task-complete-notify.ts',
      'src/renderer/src/store/terminals/terminal-ephemeral-state.ts'
    ]
  },
  {
    helper: 'isClaudeAgent',
    classification: 'evidence-producer',
    paths: [
      'src/renderer/src/components/terminal-pane/pty-connection/command-inferred-pane-agent.ts'
    ]
  },
  {
    helper: 'isClaudeAgent',
    classification: 'parser-implementation',
    paths: [
      'src/renderer/src/lib/agent-status.ts',
      'src/shared/agent-detection.ts',
      'src/shared/agent-title-identity.ts',
      'src/shared/terminal-title-agent-type.ts'
    ]
  },
  {
    helper: 'titleHasAgentName',
    classification: 'parser-implementation',
    paths: [
      'src/shared/agent-detection.ts',
      'src/shared/agent-name-token-match.ts',
      'src/shared/agent-title-core.ts',
      'src/shared/agent-title-evidence.ts',
      'src/shared/agent-title-identity.ts',
      'src/shared/terminal-title-agent-type.ts'
    ]
  },
  {
    helper: 'titleHasAgentName',
    classification: 'evidence-producer',
    paths: ['src/renderer/src/hooks/ipc-events/agent-status-routing.ts']
  },
  {
    helper: 'buildAgentNameRe',
    classification: 'action-consumer',
    paths: ['src/main/runtime/orchestration/groups.ts']
  },
  {
    helper: 'buildAgentNameRe',
    classification: 'parser-implementation',
    paths: ['src/shared/agent-name-token-match.ts']
  },
  {
    helper: 'resolveTerminalTitleAgentType',
    classification: 'identity-consumer',
    paths: ['src/renderer/src/lib/notes-send-agent-targets.ts']
  },
  {
    helper: 'resolveTerminalTitleAgentType',
    classification: 'parser-implementation',
    paths: ['src/shared/terminal-title-agent-type.ts']
  },
  {
    helper: 'resolveExplicitTerminalTitleAgentType',
    classification: 'identity-consumer',
    paths: [
      'mobile/src/session/mobile-terminal-tab-agent.ts',
      'src/renderer/src/lib/open-tab-occupant-agent.ts',
      'src/renderer/src/lib/pane-agent-evidence.ts',
      'src/renderer/src/lib/use-tab-agent.ts'
    ]
  },
  {
    helper: 'resolveExplicitTerminalTitleAgentType',
    classification: 'parser-implementation',
    paths: ['src/shared/terminal-title-agent-type.ts']
  },
  {
    helper: 'resolveCommittedTitleAgentType',
    classification: 'action-consumer',
    paths: [
      'src/renderer/src/components/native-chat/use-native-chat-toggle-shortcut.ts',
      'src/renderer/src/components/terminal-pane/pty-connection/connect-pane-pty.ts',
      'src/renderer/src/components/terminal-pane/terminal-ctrl-enter.ts',
      'src/renderer/src/components/terminal-pane/terminal-windows-shift-enter.ts',
      'src/renderer/src/components/terminal-pane/use-notification-dispatch.ts'
    ]
  },
  {
    helper: 'resolveCommittedTitleAgentType',
    classification: 'identity-consumer',
    paths: [
      'src/renderer/src/components/tab-bar/tab-bar-item-surface.tsx',
      'src/renderer/src/components/terminal-pane/native-chat-leaf-title-agent.ts',
      'src/renderer/src/components/terminal-pane/pty-connection/pane-agent-identity.ts',
      'src/renderer/src/lib/pane-agent-evidence.ts'
    ]
  },
  {
    helper: 'resolveCommittedTitleAgentType',
    classification: 'evidence-producer',
    paths: [
      'src/renderer/src/components/terminal-pane/pty-connection/command-inferred-pane-agent.ts'
    ]
  },
  {
    helper: 'resolvePaneAgentOwner',
    classification: 'parser-implementation',
    paths: ['src/shared/pane-agent-owner.ts']
  },
  {
    helper: 'resolvePaneAgentOwner',
    classification: 'identity-consumer',
    paths: [
      'src/main/runtime/orca-runtime.ts',
      'src/renderer/src/components/sidebar/worktree-title-derived-agent-rows.ts',
      'src/renderer/src/components/terminal-pane/parked-terminal-command-status.ts',
      'src/renderer/src/components/terminal-pane/pty-connection/shell-command-inference.ts',
      'src/renderer/src/lib/use-tab-agent.ts',
      'src/renderer/src/runtime/web-session-tabs-sync.ts'
    ]
  },
  {
    helper: 'resolveCompatibleAgentTypeForOwner',
    classification: 'parser-implementation',
    paths: ['src/shared/agent-title-owner.ts']
  },
  {
    helper: 'resolveCompatibleAgentTypeForOwner',
    classification: 'identity-consumer',
    paths: [
      'src/main/runtime/orca-runtime.ts',
      'src/renderer/src/components/sidebar/worktree-agent-rows.ts',
      'src/renderer/src/components/sidebar/worktree-title-derived-agent-rows.ts',
      'src/renderer/src/components/terminal-pane/use-notification-dispatch.ts',
      'src/renderer/src/lib/use-tab-agent.ts'
    ]
  },
  {
    helper: 'resolveCompatibleAgentTypeForOwner',
    classification: 'evidence-producer',
    paths: [
      'src/renderer/src/components/terminal-pane/pty-connection/agent-task-complete-notify.ts',
      'src/renderer/src/components/terminal-pane/pty-connection/command-inferred-pane-agent.ts',
      'src/renderer/src/components/terminal-pane/pty-connection/direct-ssh-retry-status.ts',
      'src/renderer/src/components/terminal-pane/pty-connection/terminal-keydown-fit.ts',
      'src/renderer/src/components/terminal-pane/pty-connection/title-spawn-bell.ts'
    ]
  }
]

const DIRECT_SINGLE_SOURCE_SURFACES: readonly {
  path: string
  classification: Classification
  marker: string
}[] = [
  {
    path: 'src/renderer/src/components/automations/automation-run-completion-evidence.ts',
    classification: 'action-consumer',
    marker: 'hasAutomationRunCompletionEvidence'
  },
  {
    path: 'src/renderer/src/components/terminal-pane/terminal-renderer-policy.ts',
    classification: 'identity-consumer',
    marker: 'resolveGeminiCompatFallback'
  },
  {
    path: 'src/renderer/src/components/terminal-pane/terminal-title-evidence.ts',
    classification: 'identity-consumer',
    marker: 'resolvePaneTitleDecision'
  },
  {
    path: 'src/renderer/src/components/terminal/terminal-close-copy-kind.ts',
    classification: 'identity-consumer',
    marker: 'resolveLeafCloseCopyKind'
  },
  {
    path: 'src/main/runtime/orchestration/mailbox-pointer-delivery.ts',
    classification: 'action-consumer',
    marker: 'isCursorAgentTitle'
  },
  {
    path: 'src/main/providers/local-pty-provider.ts',
    classification: 'action-consumer',
    marker: 'launchAgent'
  },
  {
    path: 'src/renderer/src/components/terminal-pane/pty-connection/pane-serializer-settle.ts',
    classification: 'action-consumer',
    marker: 'sendStartupDraftPaste'
  },
  {
    path: 'src/renderer/src/lib/active-agent-note-send.ts',
    classification: 'action-consumer',
    marker: 'sendNotesToActiveAgentSession'
  },
  {
    path: 'src/renderer/src/components/native-chat/native-chat-runtime-send.ts',
    classification: 'action-consumer',
    marker: 'sendNativeChatMessage'
  },
  {
    path: 'mobile/src/session/mobile-native-chat-send.ts',
    classification: 'action-consumer',
    marker: 'sendMobileNativeChatMessageWithOutcome'
  },
  {
    path: 'mobile/src/session/mobile-native-chat-image-send.ts',
    classification: 'action-consumer',
    marker: 'pasteMobileNativeChatImagePaths'
  },
  {
    path: 'mobile/src/session/pr-ai-triage-launch.ts',
    classification: 'action-consumer',
    marker: 'createTerminalAndSendPrompt'
  }
]

describe('pane agent identity inventory ratchet', () => {
  it('classifies every legacy helper definition, import, and callsite in src and mobile/src', async () => {
    const files = await glob(['src/**/*.{ts,tsx}', 'mobile/src/**/*.{ts,tsx}'], {
      ignore: ['**/*.test.*', '**/*.spec.*']
    })
    const actual: string[] = []
    for (const path of files) {
      if (isTestFile(path) || TEST_SUPPORT_PATHS.has(path)) {
        continue
      }
      const rawSource = readFileSync(join(process.cwd(), path), 'utf8')
      if (!HELPERS.some((helper) => rawSource.includes(helper))) {
        continue
      }
      const source = stripComments(rawSource)
      for (const helper of HELPERS) {
        if (new RegExp(`\\b${helper}\\b`).test(source)) {
          actual.push(`${helper}\0${path}`)
        }
      }
    }
    const expected = INVENTORY.flatMap(({ helper, paths }) =>
      paths.map((path) => `${helper}\0${path}`)
    )
    expect(actual.sort()).toEqual(expected.sort())
  })

  it('pins direct single-source identity and action branches outside named helpers', () => {
    for (const site of DIRECT_SINGLE_SOURCE_SURFACES) {
      const source = stripComments(readFileSync(join(process.cwd(), site.path), 'utf8'))
      expect({
        path: site.path,
        classification: site.classification,
        hasMarker: source.includes(site.marker)
      }).toEqual({ path: site.path, classification: site.classification, hasMarker: true })
    }
  })
})
