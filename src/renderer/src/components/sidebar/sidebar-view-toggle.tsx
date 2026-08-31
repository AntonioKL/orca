import React from 'react'
import { cn } from '@/lib/utils'

type SidebarViewToggleOption = {
  value: string
  label: string
  /** Every label this slot can ever show; reserves width so switching never resizes the tab. */
  widthLabels?: readonly string[]
  sectionTitle?: string
}

type SidebarViewToggleProps = {
  ariaLabel: string
  value: string
  options: readonly [SidebarViewToggleOption, SidebarViewToggleOption]
  onSelect: (value: string) => void
}

/** Two-up segmented control with a sliding pill; widths are frozen so nothing reflows on toggle. */
export function SidebarViewToggle({
  ariaLabel,
  value,
  options,
  onSelect
}: SidebarViewToggleProps): React.JSX.Element {
  const activeIndex = Math.max(
    0,
    options.findIndex((option) => option.value === value)
  )

  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className="relative inline-grid grid-cols-2 items-center rounded-lg border border-black/10 bg-black/[0.06] p-0.5 shadow-2xs dark:border-white/10 dark:bg-black/40"
    >
      <span
        aria-hidden
        className="pointer-events-none absolute inset-y-0.5 left-0.5 w-[calc(50%-2px)] rounded-md border border-black/[0.06] bg-background shadow-xs transition-transform duration-200 ease-out motion-reduce:transition-none dark:border-white/10 dark:bg-worktree-sidebar-accent"
        style={{ transform: `translateX(${activeIndex * 100}%)` }}
      />
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
              'relative z-10 grid rounded-md px-2.5 py-0.5 text-xs outline-none transition-colors duration-200 focus-visible:ring-2 focus-visible:ring-ring/50 motion-reduce:transition-none',
              active
                ? 'font-semibold text-foreground dark:text-worktree-sidebar-foreground'
                : 'font-medium text-worktree-sidebar-foreground/65 hover:text-worktree-sidebar-foreground'
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
          </button>
        )
      })}
    </div>
  )
}
