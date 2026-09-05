// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type {
  NativeChatSubagentEntry,
  NativeChatSubagentGroupBlock,
  NativeChatSubagentState
} from '../../../../shared/native-chat-types'
import { NativeChatSubagentRun, reconcileSubagentRoster } from './NativeChatSubagentRun'
import { NativeChatToolRun } from './NativeChatToolRun'

afterEach(cleanup)

function group(agents: NativeChatSubagentEntry[]): NativeChatSubagentGroupBlock {
  return { type: 'subagent-group', groupId: 'thread:turn-1', agents }
}

describe('NativeChatSubagentRun', () => {
  it('reads as a live spawn while children work', () => {
    render(
      <NativeChatSubagentRun
        block={group([
          { id: 'a', label: 'read', state: 'working' },
          { id: 'b', label: 'search', state: 'completed', tokens: 40661 }
        ])}
        activeTurnIsWorking
      />
    )

    expect(screen.getByText('Kicked off 2 subagents')).toBeInTheDocument()
    expect(screen.getByRole('button')).toHaveTextContent('1 working')
    expect(screen.getByRole('button')).toHaveTextContent('40.7k tokens')
  })

  it('switches to Ran once every child completed', () => {
    render(
      <NativeChatSubagentRun
        block={group([
          { id: 'a', label: 'read', state: 'completed' },
          { id: 'b', label: 'search', state: 'completed' }
        ])}
        activeTurnIsWorking={false}
      />
    )

    expect(screen.getByText('Ran 2 subagents')).toBeInTheDocument()
    expect(screen.getByRole('button')).toHaveTextContent('completed')
  })

  it('shows the worst settled verdict, not the count of finished children', () => {
    render(
      <NativeChatSubagentRun
        block={group([
          { id: 'a', label: 'read', state: 'failed' },
          { id: 'b', label: 'search', state: 'failed' },
          { id: 'c', label: 'list', state: 'completed' }
        ])}
        activeTurnIsWorking={false}
      />
    )

    expect(screen.getByRole('button')).toHaveTextContent('2 failed')
  })

  it('surfaces a failed child while its siblings still work', () => {
    const { container } = render(
      <NativeChatSubagentRun
        block={group([
          { id: 'a', label: 'read', state: 'working' },
          { id: 'b', label: 'search', state: 'working' },
          { id: 'c', label: 'list', state: 'working' },
          { id: 'd', label: 'edit', state: 'failed' }
        ])}
        activeTurnIsWorking
      />
    )

    const row = screen.getByRole('button')
    expect(row).toHaveTextContent('3 working')
    expect(row).toHaveTextContent('+1 failed')
    // The dot carries the failure; the pulse still says the group is in flight.
    expect(container.querySelector('.bg-destructive.animate-pulse')).not.toBeNull()
  })

  it('leaves the dot neutral when nothing has gone wrong', () => {
    const { container } = render(
      <NativeChatSubagentRun
        block={group([
          { id: 'a', label: 'read', state: 'working' },
          { id: 'b', label: 'search', state: 'completed' }
        ])}
        activeTurnIsWorking
      />
    )

    expect(screen.getByRole('button')).not.toHaveTextContent('failed')
    expect(container.querySelector('.bg-destructive')).toBeNull()
  })

  it('reconciles a roster persisted before a restart to unverifiable', () => {
    render(
      <NativeChatSubagentRun
        block={group([{ id: 'a', label: 'read', state: 'working' }])}
        activeTurnIsWorking={false}
      />
    )

    expect(screen.getByRole('button')).toHaveTextContent('unverifiable')
    expect(screen.getByRole('button')).not.toHaveTextContent('working')
  })

  it('leads with the bot glyph, decorative beside the word that names the group', () => {
    const { container } = render(
      <NativeChatSubagentRun
        block={group([{ id: 'a', label: 'read', state: 'working' }])}
        activeTurnIsWorking
      />
    )

    const glyph = container.querySelector('.lucide-bot')
    expect(glyph).not.toBeNull()
    expect(glyph).toHaveAttribute('aria-hidden', 'true')
    // Never icon-only: the word is what carries the accessible name.
    expect(screen.getByRole('button')).toHaveAccessibleName(/Kicked off 1 subagent/)
  })

  it('keeps the same glyph in every state, so a settling row never changes identity', () => {
    const states: NativeChatSubagentState[] = [
      'working',
      'idle',
      'completed',
      'failed',
      'stopped',
      'unverifiable'
    ]

    for (const state of states) {
      const { container } = render(
        <NativeChatSubagentRun
          block={group([{ id: 'a', label: 'read', state }])}
          activeTurnIsWorking={state === 'working'}
        />
      )

      expect(container.querySelectorAll('.lucide-bot')).toHaveLength(1)
      expect(container.querySelector('.lucide-check')).toBeNull()
      expect(container.querySelector('.lucide-users')).toBeNull()
      cleanup()
    }
  })

  it('leaves a live turn working — a settled roster is never asserted early', () => {
    expect(
      reconcileSubagentRoster([{ id: 'a', label: 'read', state: 'working' }], true)
    ).toMatchObject([{ state: 'working' }])
    expect(
      reconcileSubagentRoster([{ id: 'a', label: 'read', state: 'working' }], false)
    ).toMatchObject([{ state: 'unverifiable' }])
  })
})

describe('NativeChatToolRun with a spawn group', () => {
  it('renders a roster with no tool calls without inventing a tool count', () => {
    render(
      <NativeChatToolRun
        blocks={[]}
        subagentGroups={[group([{ id: 'a', label: 'read', state: 'working' }])]}
        expandSignal={false}
        activeTurnIsWorking
      />
    )

    expect(screen.getByText('Kicked off 1 subagent')).toBeInTheDocument()
    expect(screen.queryByText('1 tool call')).toBeNull()
  })

  it('renders the roster alongside the tool activity of its turn', () => {
    render(
      <NativeChatToolRun
        blocks={[{ type: 'tool-call', name: 'shell', input: { command: 'ls' } }]}
        subagentGroups={[group([{ id: 'a', label: 'read', state: 'completed' }])]}
        expandSignal={false}
        activeTurnIsWorking={false}
      />
    )

    expect(screen.getByText('Ran 1 subagent')).toBeInTheDocument()
    expect(screen.getByText('shell ls')).toBeInTheDocument()
  })
})
