import { useMemo, useState } from 'react'
import { Play } from 'lucide-react'
import { useAppStore } from '@/store'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  createTerminalQuickCommandDraft,
  TerminalQuickCommandDialog
} from '@/components/terminal-quick-commands/TerminalQuickCommandDialog'
import { runQuickCommandInNewTab } from '@/lib/run-quick-command-in-new-tab'
import type { TerminalQuickCommand } from '../../../../shared/terminal-quick-command-types'
import { useConfirmationDialog } from '@/components/confirmation-dialog-context'
import { translate } from '@/i18n/i18n'
import { TabBarQuickCommandsMenu } from './TabBarQuickCommandsMenu'
import { resolveRecentQuickCommand } from './quick-command-launch-options'
import type { HostedTerminalQuickCommand } from '@/hooks/use-terminal-quick-command-hosts'
import { useVisibleTerminalQuickCommands } from '@/hooks/use-visible-terminal-quick-commands'
import { getRepoExecutionHostId, type ExecutionHostId } from '../../../../shared/execution-host'

type TabBarQuickCommandsButtonProps = {
  worktreeId: string
  groupId: string
}

export function TabBarQuickCommandsButton({
  worktreeId,
  groupId
}: TabBarQuickCommandsButtonProps): React.JSX.Element | null {
  const recentByGroup = useAppStore((s) => s.recentQuickCommandIdByGroup)
  const {
    executionHostId,
    globalCommands,
    hosts,
    refreshRemoteHost,
    remoteHostLoadFailed,
    remoteHostPending,
    repoCommands,
    repoId,
    repos
  } = useVisibleTerminalQuickCommands(worktreeId)
  const confirm = useConfirmationDialog()

  const recentId = recentByGroup[groupId] ?? null
  const mostRecent = useMemo(
    () => resolveRecentQuickCommand(repoCommands, globalCommands, recentId),
    [repoCommands, globalCommands, recentId]
  )

  const [editor, setEditor] = useState<
    | { mode: 'add'; command: TerminalQuickCommand; hostId: ExecutionHostId }
    | { mode: 'edit'; command: TerminalQuickCommand; hostId: ExecutionHostId }
    | null
  >(null)

  const totalVisible = repoCommands.length + globalCommands.length
  const hasAnyCommands = totalVisible > 0
  const defaultHostId = hosts.some((host) => host.hostId === executionHostId)
    ? executionHostId
    : hosts[0].hostId

  const addRepoCommand = (hostId: ExecutionHostId): void => {
    setEditor({
      mode: 'add',
      hostId,
      command: createTerminalQuickCommandDraft({
        type: 'repo',
        repoId: repoId ?? ''
      })
    })
  }

  const handleSaveCommand = (next: TerminalQuickCommand): void => {
    if (editor) {
      void useAppStore.getState().upsertTerminalQuickCommand(editor.hostId, next)
    }
  }

  const handleDeleteCommand = async (entry: HostedTerminalQuickCommand): Promise<void> => {
    const { command } = entry
    const confirmed = await confirm({
      title: translate(
        'auto.components.tab.bar.TabBarQuickCommandsButton.e8e1a52edb',
        'Delete "{{value0}}"?',
        { value0: command.label }
      ),
      description: translate(
        'auto.components.tab.bar.TabBarQuickCommandsButton.3220e2da27',
        'This quick command will be removed from your saved list.'
      ),
      confirmLabel: translate(
        'auto.components.tab.bar.TabBarQuickCommandsButton.be8f0ff166',
        'Delete'
      ),
      confirmVariant: 'destructive'
    })
    if (!confirmed) {
      return
    }
    void useAppStore.getState().deleteTerminalQuickCommand(entry.hostId, command.id)
  }

  const handleRun = (entry: HostedTerminalQuickCommand): void => {
    runQuickCommandInNewTab({
      command: entry.command,
      worktreeId,
      groupId,
      historyId: entry.key
    })
  }
  const editorRepos = editor?.hostId.startsWith('runtime:')
    ? repos.filter((repo) => getRepoExecutionHostId(repo) === editor.hostId)
    : repos

  // Why: hidden in folder-mode worktrees (no repoId) and floating terminals.
  // Without a repoId the button can't represent a repo-scoped run target, and
  // global-only mode would be confusing in a context that doesn't belong to a
  // repo at all.
  if (!repoId) {
    return null
  }

  // Empty state: single button that opens the dialog directly.
  if (!hasAnyCommands && hosts.length === 1 && !remoteHostPending) {
    return (
      <>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={() => addRepoCommand(defaultHostId)}
              className="my-auto flex h-7 shrink-0 items-center gap-1 rounded-md px-1.5 text-muted-foreground hover:bg-accent/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              aria-label={translate(
                'auto.components.tab.bar.TabBarQuickCommandsButton.8f1e971966',
                'Add quick command'
              )}
            >
              <Play className="size-3.5" />
              <span className="text-[12px] font-medium">
                {translate(
                  'auto.components.tab.bar.TabBarQuickCommandsButton.a2c7a33831',
                  'Command'
                )}
              </span>
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={6}>
            {translate(
              'auto.components.tab.bar.TabBarQuickCommandsButton.1d411fb6a5',
              'Save a quick command for this repo'
            )}
          </TooltipContent>
        </Tooltip>
        <TerminalQuickCommandDialog
          open={editor !== null}
          mode={editor?.mode ?? 'add'}
          command={editor?.command ?? createTerminalQuickCommandDraft({ type: 'repo', repoId })}
          repos={editorRepos}
          onOpenChange={(open) => !open && setEditor(null)}
          onSave={handleSaveCommand}
        />
      </>
    )
  }

  return (
    <>
      <TabBarQuickCommandsMenu
        repoCommands={repoCommands}
        globalCommands={globalCommands}
        mostRecent={mostRecent}
        addHosts={hosts}
        hostLoadFailed={remoteHostLoadFailed}
        hostOwnershipPending={remoteHostPending}
        onMenuOpen={refreshRemoteHost}
        onAddCommand={addRepoCommand}
        onEditCommand={(entry) =>
          setEditor({
            mode: 'edit',
            command: entry.command,
            hostId: entry.hostId
          })
        }
        onDeleteCommand={(entry) => void handleDeleteCommand(entry)}
        onRunCommand={handleRun}
      />
      <TerminalQuickCommandDialog
        open={editor !== null}
        mode={editor?.mode ?? 'add'}
        command={editor?.command ?? createTerminalQuickCommandDraft({ type: 'repo', repoId })}
        repos={editorRepos}
        onOpenChange={(open) => !open && setEditor(null)}
        onSave={handleSaveCommand}
      />
    </>
  )
}
