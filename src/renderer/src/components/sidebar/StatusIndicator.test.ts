import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { getWorktreeStatusLabel } from '@/lib/worktree-status'
import StatusIndicator, { type Status } from './StatusIndicator'

// Why mock the Radix layer rather than StateIndicatorTooltip: it keeps the real
// tooltip composition under test, so these read the copy a hovering user gets
// instead of a prop handed to a stub.
vi.mock('@/components/ui/tooltip', async () => {
  const { createElement, Fragment } = await import('react')
  return {
    Tooltip: ({ children }: { children: React.ReactNode }) =>
      createElement('span', { 'data-tooltip-root': '' }, children),
    TooltipTrigger: ({ children }: { children: React.ReactNode }) =>
      createElement(Fragment, null, children),
    TooltipContent: ({ children }: { children: React.ReactNode }) =>
      createElement('span', { 'data-tooltip-content': '' }, children)
  }
})

function renderMarkup(status: Status): string {
  return renderToStaticMarkup(React.createElement(StatusIndicator, { status }))
}

function renderDotClassNames(status: Status): string[] {
  const markup = renderMarkup(status)
  const dotClassName = markup.match(/<span class="([^"]*rounded-full[^"]*)"/)?.[1]

  expect(dotClassName).toBeDefined()

  return dotClassName!.split(/\s+/)
}

describe('StatusIndicator', () => {
  it('renders working as a yellow spinner ring', () => {
    const markup = renderMarkup('working')

    expect(markup).toContain('border-yellow-500')
    expect(markup).toContain('border-t-transparent')
    // Why: rotation must come from the compositor-driven CSS animation, not a
    // JS clock writing per-element styles on the input thread (STA-3328).
    expect(markup).toContain('agent-working-spinner')
    expect(markup).toContain('data-agent-spinner')
    // Why: under reduced motion the top border is filled so the static ring
    // reads as a complete marker, not a broken partial spinner (#9515).
    expect(markup).toContain('motion-reduce:border-t-yellow-500')
  })

  it('renders monitoring as a static heartbeat glyph', () => {
    const markup = renderMarkup('monitoring')

    expect(markup).not.toContain('data-state-indicator-tooltip')
    expect(markup).not.toContain(' title=')
    expect(markup).toContain('lucide-activity')
    expect(markup).toContain('text-yellow-500')
    expect(markup).not.toContain('data-agent-spinner')
  })

  it('renders permission as the shared question glyph', () => {
    const markup = renderMarkup('permission')

    expect(markup).toContain('lucide-message-circle-question-mark')
    expect(markup).toContain('text-agent-question')
    expect(markup).not.toContain('text-amber-500')
    expect(markup).not.toContain('data-agent-spinner')
  })

  it('renders active as full emerald dot', () => {
    const classNames = renderDotClassNames('active')

    expect(classNames).toContain('bg-emerald-500')
  })

  it('renders done as an emerald dot', () => {
    const classNames = renderDotClassNames('done')

    expect(classNames).toContain('bg-emerald-500')
  })

  it('renders interrupted distinctly from done', () => {
    const classNames = renderDotClassNames('interrupted')

    expect(classNames).toContain('bg-red-500')
    expect(classNames).not.toContain('bg-emerald-500')
  })

  const ALL_STATUSES = [
    'active',
    'working',
    'monitoring',
    'permission',
    'interrupted',
    'done',
    'inactive'
  ] satisfies Status[]

  it.each(ALL_STATUSES)('labels the %s workspace state on hover', (status) => {
    const markup = renderMarkup(status)

    expect(markup).toContain(`data-tooltip-content="">${getWorktreeStatusLabel(status)}<`)
    // Why: a native title on the glyph would win over any ancestor's title on
    // hover, which is the shadowing regression this indicator already caused.
    expect(markup).not.toContain(' title=')
  })

  // Typecheck-time guard: a new WorktreeStatus member that ALL_STATUSES omits
  // fails `pnpm tc`, so the hover case above can never silently skip a state.
  type UncoveredStatus = Exclude<Status, (typeof ALL_STATUSES)[number]>
  const _allStatusesAreCovered: UncoveredStatus extends never ? true : never = true
  void _allStatusesAreCovered

  // Why this is the whole point: 'active' and 'done' paint the identical
  // emerald dot, so hover copy is the only thing that separates them.
  it('separates the identical active and done dots by hover copy', () => {
    expect(renderDotClassNames('active')).toEqual(renderDotClassNames('done'))
    expect(renderMarkup('active')).toContain('data-tooltip-content="">Active<')
    expect(renderMarkup('done')).toContain('data-tooltip-content="">Done<')
  })

  it('lets an enclosing action own the hover copy', () => {
    const markup = renderToStaticMarkup(
      React.createElement(StatusIndicator, { status: 'working', showTooltip: false })
    )

    expect(markup).not.toContain('data-tooltip-root')
    expect(markup).toContain('data-agent-spinner')
  })
})
