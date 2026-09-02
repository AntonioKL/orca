import React from 'react'
import { cn } from '@/lib/utils'

type SidebarViewToggleOption = {
  value: string
  label: string
  /** Every label this slot can ever show; reserves width so switching never resizes the tab. */
  widthLabels?: readonly string[]
  sectionTitle?: string
  /** Trailing count pill; folded into the accessible name so "Agents 3" reads as one control. */
  badgeCount?: number
  renderWrapper?: (button: React.ReactNode) => React.ReactNode
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
      {options.map((option, index) => {
        const active = option.value === value
        const badgeCount = option.badgeCount ?? 0
        const button = (
          <button
            key={option.value}
            type="button"
            role="radio"
            tabIndex={active ? 0 : -1}
            aria-checked={active}
            aria-label={badgeCount > 0 ? `${option.label} ${badgeCount}` : undefined}
            data-sidebar-section-title={option.sectionTitle}
            onClick={() => {
              if (!active) {
                onSelect(option.value)
              }
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
                e.preventDefault()
                const next = options[(index + 1) % options.length]
                if (next) {
                  onSelect(next.value)
                }
              } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
                e.preventDefault()
                const prev = options[(index - 1 + options.length) % options.length]
                if (prev) {
                  onSelect(prev.value)
                }
              }
            }}
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
            <span className="col-start-1 row-start-1 whitespace-nowrap">{option.label}</span>
            {badgeCount > 0 ? (
              <span
                aria-hidden
                className="pointer-events-none absolute -top-1.5 -right-1.5 rounded-full bg-primary px-1 text-[9px] font-semibold leading-3.5 text-primary-foreground"
              >
                {badgeCount}
              </span>
            ) : null}
          </button>
        )

        return option.renderWrapper ? (
          <React.Fragment key={option.value}>{option.renderWrapper(button)}</React.Fragment>
        ) : (
          button
        )
      })}
    </div>
  )
}
