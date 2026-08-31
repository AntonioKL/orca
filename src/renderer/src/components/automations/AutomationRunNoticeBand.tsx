import React from 'react'
import { AlertTriangle, Info } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { AutomationRunNotice } from './automation-run-content'

export function AutomationRunNoticeBand({
  notice
}: {
  notice: AutomationRunNotice
}): React.JSX.Element {
  const isError = notice.tone === 'error'
  const Icon = isError ? AlertTriangle : Info
  return (
    <div
      role={isError ? 'alert' : 'status'}
      className={cn(
        'flex shrink-0 items-start gap-2 border-b px-4 py-2.5 text-sm',
        isError
          ? 'border-destructive/30 bg-destructive/10 text-destructive'
          : 'border-border/50 bg-muted/40 text-muted-foreground'
      )}
    >
      <Icon className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
      <span className="min-w-0 flex-1">{notice.text}</span>
    </div>
  )
}
