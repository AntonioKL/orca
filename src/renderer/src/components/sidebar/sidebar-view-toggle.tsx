import React from 'react'
import { cn } from '@/lib/utils'

type SidebarViewToggleOption = {
  value: string
  label: string
  /** Every label this slot can ever show; reserves width so switching never resizes the tab. */
  widthLabels?: readonly string[]
  sectionTitle?: string
  /** Unread count rendered after the label; hidden at 0. */
  badgeCount?: number
}

type SidebarViewToggleProps = {
  ariaLabel: string
  value: string
  options: readonly SidebarViewToggleOption[]
  onSelect: (value: string) => void
  className?: string
}

/** Two-up segmented control; tab widths stay frozen so nothing reflows on toggle. */
export function SidebarViewToggle({
  ariaLabel,
  value,
  options,
  onSelect,
  className
}: SidebarViewToggleProps): React.JSX.Element {
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className={cn(
        'inline-flex shrink-0 items-center rounded-lg border border-sidebar-border bg-sidebar-accent p-0.5 shadow-xs',
        className
      )}
    >
      {options.map((option) => {
        const active = option.value === value
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={active}
            data-sidebar-section-title={option.sectionTitle}
            onClick={() => onSelect(option.value)}
            className={cn(
              'relative grid grid-cols-1 rounded-md border px-1.5 py-0.5 text-center text-xs outline-none transition-colors duration-200 focus-visible:ring-2 focus-visible:ring-ring/50 motion-reduce:transition-none',
              active
                ? 'border-sidebar-border bg-sidebar font-semibold text-sidebar-foreground shadow-xs'
                : 'border-transparent font-medium text-worktree-sidebar-foreground/65 hover:text-worktree-sidebar-foreground'
            )}
          >
            {(option.widthLabels ?? [option.label]).map((widthLabel) => (
              <span
                key={widthLabel}
                aria-hidden
                className="invisible col-start-1 row-start-1 whitespace-nowrap font-semibold"
              >
                {widthLabel}
              </span>
            ))}
            <span className="col-start-1 row-start-1 inline-flex items-center justify-center gap-1 whitespace-nowrap">
              {option.label}
              {option.badgeCount ? (
                <span className="rounded-full bg-primary px-1.5 py-px text-[10px] font-semibold text-primary-foreground">
                  {option.badgeCount}
                </span>
              ) : null}
            </span>
          </button>
        )
      })}
    </div>
  )
}
