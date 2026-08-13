import React, { useRef } from 'react'
import { Plus, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import type {
  AutomationRun,
  ExternalAutomationAction,
  ExternalAutomationJob,
  ExternalAutomationManager
} from '../../../../shared/automations-types'
import type { AutomationHostFilter } from '../../../../shared/automation-host-filter'
import type { SshConnectionState } from '../../../../shared/ssh-types'
import type { ProjectHostSetup } from '../../../../shared/project-types'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'
import type { RuntimeStatus } from '../../../../shared/runtime-types'
import type { TaskSourceHostAvailability } from '../task-source-context-summary'
import type { AutomationRowAction } from './automation-captured-owner'
import type { AutomationHostTarget } from './automation-host-client'
import { clampAutomationListSearchQueryInput } from './automation-list-search'
import {
  getAutomationListArrowNavigationTarget,
  type AutomationListArrowKey
} from './automation-list-keyboard-navigation'
import type { AutomationListRow } from './automation-list-row-identity'
import type { AutomationPaneTab } from './automation-page-state'
import { AutomationListSearchField } from './AutomationListSearchField'
import { getAutomationTemplates, type AutomationTemplate } from './automation-templates'
import type { ExternalAutomationListEntry } from './external-automation-list-entries'
import type { ExternalAutomationScope } from './external-automation-scope-client'
import { AutomationListLocalRows } from './AutomationListLocalRows'
import { AutomationListExternalRows } from './AutomationListExternalRows'
import { AutomationListHostGroups } from './AutomationListHostGroups'
import { filterAutomationHostGroups } from './automation-host-list-rows'
import { AutomationHostPicker } from './AutomationHostPicker'
import { AutomationHostFilterNotice, AutomationHostLoadSummary } from './AutomationHostFilterNotice'
import { AutomationListEmptyView } from './AutomationListEmptyView'
import { resolveAutomationListEmptyState } from './automation-list-empty-state'
import type { AutomationListSearchCounts } from './use-automation-list-search'
import type { AutomationHostCatalogView } from './use-automation-host-catalog'
import type { AutomationHostRecoveryAction } from './automation-host-status-descriptors'
import type { AutomationHostCatalogEntry } from './automation-host-catalog-types'
import { useAutomationListFocusRecovery } from './use-automation-list-focus-recovery'
import { AUTOMATIONS_TABLE_GRID_CLASS } from './automations-table-layout'
import { LIST_TABLE_CONTAINER_CLASS, LIST_TABLE_HEADER_CLASS } from '@/lib/list-table-layout'
import { translate } from '@/i18n/i18n'

const TEMPLATE_EMPTY_STATES: ReadonlySet<string> = new Set(['host-empty', 'all-hosts-empty'])
const EMPTY_AUTOMATION_RUNS: ReadonlyMap<string, AutomationRun> = new Map()

type AutomationsListPanelProps = {
  hasListItems: boolean
  hasFilteredListItems: boolean
  listSearchQuery: string
  isListSearchQueryTooLarge: boolean
  onListSearchQueryChange: (query: string) => void
  searchCounts: AutomationListSearchCounts
  hostCatalog: AutomationHostCatalogView
  externalManagersListed: boolean
  externalScopeNotice: string | null
  externalManagersUncheckedNotice: string | null
  onSelectHost: (filter: AutomationHostFilter) => void
  onRecoverHost: (
    action: AutomationHostRecoveryAction,
    entry?: AutomationHostCatalogEntry | null
  ) => void
  filteredRows: readonly AutomationListRow[]
  filteredExternalAutomationEntries: readonly ExternalAutomationListEntry[]
  selectedRowKey: string | null
  selectedExternalKey: string | null
  selectedExternal?: ExternalAutomationListEntry | null
  relativeNow: number
  repoMap: ReadonlyMap<string, Repo>
  worktreeMap: ReadonlyMap<string, Worktree>
  repoForRow?: (row: AutomationListRow) => Repo | undefined
  worktreeForRow?: (row: AutomationListRow, repo: Repo | undefined) => Worktree | undefined
  projectHostSetups: readonly ProjectHostSetup[]
  sshConnectionStates: ReadonlyMap<string, Pick<SshConnectionState, 'status'>>
  runtimeStatusByEnvironmentId: ReadonlyMap<
    string,
    { status: RuntimeStatus | null; checkedAt: number }
  >
  hostTargetFor: (row: AutomationListRow) => AutomationHostTarget | null
  automationSourceHostAvailabilityByRowKey: ReadonlyMap<string, TaskSourceHostAvailability[]>
  hostLabelById?: ReadonlyMap<string, string>
  isActionEnabled: (row: AutomationListRow, action: AutomationRowAction) => boolean
  externalActionKey: string | null
  selectAutomationRow: (rowKey: string | null) => void
  selectExternalKey: (externalKey: string | null) => void
  setActivePaneTab: (tab: AutomationPaneTab) => void
  runNow: (row: AutomationListRow) => void
  openEditDialog: (row: AutomationListRow) => void
  toggleAutomation: (row: AutomationListRow) => void
  requestDeleteAutomation: (row: AutomationListRow) => void
  requestExternalAction: (
    manager: ExternalAutomationManager,
    job: ExternalAutomationJob,
    action: ExternalAutomationAction,
    scope: ExternalAutomationScope
  ) => void
  openEditExternalDialog: (
    manager: ExternalAutomationManager,
    job: ExternalAutomationJob,
    scope: ExternalAutomationScope
  ) => void
  openCreateDialog: (template?: AutomationTemplate) => void
  canCreateAutomation: boolean
  onOpenDetail: () => void
  onRefresh: () => void
  isRefreshing: boolean
}

export function AutomationsListPanel(props: AutomationsListPanelProps): React.JSX.Element {
  const {
    hasListItems,
    hasFilteredListItems,
    listSearchQuery,
    isListSearchQueryTooLarge,
    onListSearchQueryChange,
    searchCounts,
    hostCatalog,
    externalManagersListed,
    externalScopeNotice,
    externalManagersUncheckedNotice,
    onSelectHost,
    onRecoverHost,
    filteredRows,
    filteredExternalAutomationEntries,
    selectedRowKey,
    selectedExternalKey,
    relativeNow,
    repoMap,
    worktreeMap,
    repoForRow,
    worktreeForRow,
    projectHostSetups,
    sshConnectionStates,
    runtimeStatusByEnvironmentId,
    hostTargetFor,
    automationSourceHostAvailabilityByRowKey,
    hostLabelById,
    isActionEnabled,
    externalActionKey,
    selectAutomationRow,
    selectExternalKey,
    setActivePaneTab,
    runNow,
    openEditDialog,
    toggleAutomation,
    requestDeleteAutomation,
    requestExternalAction,
    openEditExternalDialog,
    openCreateDialog,
    canCreateAutomation,
    onOpenDetail,
    onRefresh,
    isRefreshing
  } = props
  const listRef = useRef<HTMLDivElement>(null)
  const pickerRef = useRef<HTMLDivElement>(null)
  const pendingKeyboardScrollRef = useRef(false)
  const rowKeys = React.useMemo(() => filteredRows.map((row) => row.key), [filteredRows])
  const visibleRowKeys = React.useMemo(() => new Set(rowKeys), [rowKeys])
  const visibleItems = React.useMemo(
    () => [
      ...filteredRows.map((row) => ({ kind: 'local' as const, id: row.key })),
      ...filteredExternalAutomationEntries.map((entry) => ({ kind: 'external' as const, id: entry.key }))
    ],
    [filteredExternalAutomationEntries, filteredRows]
  )
  useAutomationListFocusRecovery({ rowKeys, containerRef: listRef, fallbackRef: pickerRef })
  const handleSearchArrowNavigate = React.useCallback(
    (key: AutomationListArrowKey) => {
      const next = getAutomationListArrowNavigationTarget({
        items: visibleItems,
        selectedId: selectedRowKey,
        selectedExternalKey,
        key
      })
      if (!next) {
        return
      }
      const alreadySelected =
        next.kind === 'local'
          ? selectedExternalKey === null && selectedRowKey === next.id
          : selectedExternalKey === next.id
      if (alreadySelected) {
        listRef.current?.querySelector('[data-current="true"]')?.scrollIntoView({ block: 'nearest' })
        return
      }
      pendingKeyboardScrollRef.current = true
      if (next.kind === 'local') {
        selectExternalKey(null)
        selectAutomationRow(next.id)
      } else {
        selectAutomationRow(null)
        selectExternalKey(next.id)
        setActivePaneTab('overview')
      }
    },
    [
      selectAutomationRow,
      selectExternalKey,
      selectedExternalKey,
      selectedRowKey,
      setActivePaneTab,
      visibleItems
    ]
  )
  React.useEffect(() => {
    if (!pendingKeyboardScrollRef.current) {
      return
    }
    pendingKeyboardScrollRef.current = false
    listRef.current?.querySelector('[data-current="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [selectedExternalKey, selectedRowKey])
  const emptyStateInput = {
    resolution: hostCatalog.resolution,
    ...searchCounts,
    externalManagersListed
  }
  const emptyState = resolveAutomationListEmptyState(emptyStateInput)
  const rowProps = {
    selectedRowKey,
    isSelectedLocal: selectedExternalKey === null,
    lastRunByAutomationId: EMPTY_AUTOMATION_RUNS,
    relativeNow,
    repoMap,
    worktreeMap,
    repoForRow,
    worktreeForRow,
    projectHostSetups,
    sshConnectionStates,
    runtimeStatusByEnvironmentId,
    hostTargetFor,
    automationSourceHostAvailabilityByRowKey,
    hostLabelById,
    isActionEnabled,
    onSelect: (rowKey: string) => {
      selectExternalKey(null)
      selectAutomationRow(rowKey)
      onOpenDetail()
    },
    onRunNow: runNow,
    onEdit: openEditDialog,
    onToggle: toggleAutomation,
    onDelete: requestDeleteAutomation
  }

  return (
    <section
      className="flex min-h-0 flex-1 flex-col overflow-hidden px-3 pb-4 md:px-5"
      data-contextual-tour-target="automations-list"
    >
      <div className="flex shrink-0 items-end justify-between gap-3 pb-4">
        <div className="flex min-w-0 flex-1 items-end gap-2">
          <div ref={pickerRef} className="w-48 shrink-0">
            <AutomationHostPicker
              entries={hostCatalog.entries}
              resolution={hostCatalog.resolution}
              onSelect={onSelectHost}
            />
          </div>
          <AutomationListSearchField
            className="w-full max-w-xs"
            query={listSearchQuery}
            isTooLarge={isListSearchQueryTooLarge}
            onQueryChange={(query) =>
              onListSearchQueryChange(clampAutomationListSearchQueryInput(query))
            }
            onClear={() => onListSearchQueryChange('')}
            onArrowNavigate={handleSearchArrowNavigate}
          />
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={translate(
                  'auto.components.automations.AutomationsPage.19a6e30eae',
                  'Refresh automations'
                )}
                onClick={onRefresh}
                disabled={isRefreshing}
                className="shrink-0 border border-border bg-background shadow-none hover:bg-muted/50"
              >
                <RefreshCw className={cn('size-4', isRefreshing && 'animate-spin')} />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={6}>
              {translate(
                'auto.components.automations.AutomationsPage.19a6e30eae',
                'Refresh automations'
              )}
            </TooltipContent>
          </Tooltip>
        </div>
        <Button
          type="button"
          size="sm"
          className="shrink-0"
          onClick={() => openCreateDialog()}
          disabled={!canCreateAutomation}
          data-contextual-tour-target="automations-create"
        >
          <Plus className="size-4" />
          {translate('auto.components.automations.AutomationsPage.newAutomation', 'New Automation')}
        </Button>
      </div>

      <AutomationHostFilterNotice
        resolution={hostCatalog.resolution}
        onRecover={(action) => onRecoverHost(action)}
        className="mb-2"
      />
      <AutomationHostLoadSummary {...hostCatalog.loadCounts} />
      {externalManagersUncheckedNotice ? (
        <p className="pb-2 text-[11px] text-muted-foreground" data-external-managers="unchecked">
          {externalManagersUncheckedNotice}
        </p>
      ) : null}
      {externalScopeNotice && hasFilteredListItems ? (
        <p className="pb-2 text-[11px] text-muted-foreground" data-scope-note="populated">
          {externalScopeNotice}
        </p>
      ) : null}

      <div
        ref={listRef}
        className={cn(
          'scrollbar-sleek min-h-0 flex-1 overflow-auto',
          LIST_TABLE_CONTAINER_CLASS
        )}
      >
        {hasFilteredListItems ? (
          <>
            <div className={cn(AUTOMATIONS_TABLE_GRID_CLASS, LIST_TABLE_HEADER_CLASS)}>
              <span>
                {translate('auto.components.automations.AutomationsPage.tableName', 'Name')}
              </span>
              <span>
                {translate('auto.components.automations.AutomationDetail.18763ded26', 'Schedule')}
              </span>
              <span>
                {translate('auto.components.automations.AutomationsPage.tableProject', 'Project')}
              </span>
              <span>
                {translate('auto.components.automations.AutomationDetail.578ff46987', 'Next run')}
              </span>
              <span>
                {translate('auto.components.automations.AutomationsPage.tableLastRun', 'Last run')}
              </span>
              <span>
                {translate('auto.components.automations.AutomationsPage.tableStatus', 'Status')}
              </span>
              <span className="text-center">
                {translate('auto.components.automations.AutomationDetail.2df8970cd5', 'Agent')}
              </span>
              <span className="sr-only">
                {translate('auto.components.automations.AutomationsPage.tableActions', 'Actions')}
              </span>
            </div>
            <div className="divide-y divide-border/50">
              {hostCatalog.rows.groups.length > 0 ? (
                <AutomationListHostGroups
                  {...rowProps}
                  groups={filterAutomationHostGroups(hostCatalog.rows.groups, visibleRowKeys)}
                  searchActive={searchCounts.searchActive}
                  onRecover={onRecoverHost}
                />
              ) : (
                <AutomationListLocalRows {...rowProps} rows={filteredRows} />
              )}
              <AutomationListExternalRows
                entries={filteredExternalAutomationEntries}
                selectedExternalKey={selectedExternalKey}
                relativeNow={relativeNow}
                sshConnectionStates={sshConnectionStates}
                externalActionKey={externalActionKey}
                onSelect={(entryKey) => {
                  selectAutomationRow(null)
                  selectExternalKey(entryKey)
                  setActivePaneTab('overview')
                  onOpenDetail()
                }}
                onRequestAction={requestExternalAction}
                onEdit={openEditExternalDialog}
              />
            </div>
          </>
        ) : (
          <AutomationListEmptyView
            {...emptyStateInput}
            onRecover={(action) => onRecoverHost(action)}
          />
        )}

        {!hasListItems && TEMPLATE_EMPTY_STATES.has(emptyState.kind) ? (
          <div className="mx-auto grid max-w-2xl gap-2 p-4">
            <div className="px-1 pb-1 text-sm font-medium">
              {translate(
                'auto.components.automations.AutomationsPage.d207ab4c25',
                'Start from a template'
              )}
            </div>
            {getAutomationTemplates().map((template) => (
              <button
                key={template.id}
                type="button"
                onClick={() => openCreateDialog(template)}
                className="rounded-md border border-border/70 bg-background px-3 py-2 text-left shadow-xs transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
              >
                <div className="text-[11px] font-medium uppercase text-muted-foreground">
                  {template.category}
                </div>
                <div className="mt-1 text-sm font-medium">{template.label}</div>
                <div className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                  {template.description}
                </div>
              </button>
            ))}
            <Button
              type="button"
              variant="outline"
              className="mt-1 w-full justify-start"
              onClick={() => openCreateDialog()}
            >
              <Plus className="size-4" />
              {translate('auto.components.automations.AutomationsPage.25060635c6', 'Add new')}
            </Button>
          </div>
        ) : null}
      </div>
    </section>
  )
}
