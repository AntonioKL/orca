import type React from 'react'
import { ActivityStatusGroupHeader } from './activity-thread-controls'
import type { ActivityThreadGroup } from './activity-thread-types'

export function ActivityThreadStickyHeader({
  group,
  collapsed,
  onToggle
}: {
  group: ActivityThreadGroup
  collapsed: boolean
  onToggle: () => void
}): React.JSX.Element {
  return (
    <div className="absolute inset-x-1.5 top-0 z-10 rounded-md border border-border/60 bg-sidebar/95 shadow-xs backdrop-blur supports-[backdrop-filter]:bg-sidebar/80">
      <ActivityStatusGroupHeader group={group} collapsed={collapsed} onToggle={onToggle} />
    </div>
  )
}
