import React from 'react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import {
  recoveryActionLabel,
  type AutomationHostRecoveryAction
} from './automation-host-status-descriptors'
import type { AutomationOwnerConflict } from './automation-owner-action-runner'
import type { AutomationActionBlock } from './automation-captured-owner'

/**
 * An owner conflict shown where the user was working, not as a toast: the
 * request performed nothing, so the message has to survive long enough to be
 * read and acted on. It offers a recovery action only when one exists — a host
 * that was deregistered gets a plain explanation rather than a button that
 * cannot help.
 */

type AutomationOwnerNotice = {
  message: string
  recovery: AutomationHostRecoveryAction | null
}

export function ownerConflictNotice(conflict: AutomationOwnerConflict): AutomationOwnerNotice {
  return { message: conflict.message, recovery: conflict.recovery }
}

export function actionBlockNotice(block: AutomationActionBlock): AutomationOwnerNotice {
  return { message: block.message, recovery: block.recovery }
}

type AutomationOwnerConflictNoticeProps = {
  notice: AutomationOwnerNotice | null
  onRecover?: (action: AutomationHostRecoveryAction) => void
  onDismiss?: () => void
  className?: string
}

export function AutomationOwnerConflictNotice({
  notice,
  onRecover,
  onDismiss,
  className
}: AutomationOwnerConflictNoticeProps): React.JSX.Element | null {
  if (!notice) {
    return null
  }
  const recovery = notice.recovery
  return (
    <div
      role="alert"
      data-testid="automation-owner-conflict"
      className={cn(
        'flex flex-wrap items-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-xs text-muted-foreground',
        className
      )}
    >
      <span className="min-w-0 flex-1">{notice.message}</span>
      {recovery && onRecover ? (
        <Button type="button" variant="outline" size="xs" onClick={() => onRecover(recovery)}>
          {recoveryActionLabel(recovery)}
        </Button>
      ) : null}
      {onDismiss ? (
        <Button type="button" variant="ghost" size="xs" onClick={onDismiss}>
          {translate('auto.components.automations.ownerConflict.dismiss', 'Dismiss')}
        </Button>
      ) : null}
    </div>
  )
}
