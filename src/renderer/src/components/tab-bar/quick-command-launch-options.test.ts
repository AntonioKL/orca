import { describe, expect, it } from 'vitest'
import {
  findMatchingTabQuickCommandOptions,
  resolveRecentQuickCommand,
  selectNewTabMenuQuickCommands
} from './quick-command-launch-options'
import type { HostedTerminalQuickCommand } from '@/hooks/use-terminal-quick-command-hosts'

function hosted(id: string, label: string, command = 'echo hi'): HostedTerminalQuickCommand {
  return {
    command: { id, label, command, appendEnter: true },
    hostId: 'local',
    hostLabel: 'This computer',
    key: `local\0${id}`
  }
}

const repoCommands = [hosted('a', 'Run tests'), hosted('b', 'Build app')]
const globalCommands = [hosted('c', 'Open logs')]

describe('selectNewTabMenuQuickCommands', () => {
  it('caps the unfiltered menu at two entries, repo before global', () => {
    expect(
      selectNewTabMenuQuickCommands(repoCommands, globalCommands, null).map((e) => e.command.id)
    ).toEqual(['a', 'b'])
  })

  it("promotes the group's most recent command to the top without duplicating it", () => {
    expect(
      selectNewTabMenuQuickCommands(repoCommands, globalCommands, 'local\0c').map(
        (e) => e.command.id
      )
    ).toEqual(['c', 'a'])
  })

  it('returns nothing when the menu has no room', () => {
    expect(selectNewTabMenuQuickCommands(repoCommands, globalCommands, null, 0)).toEqual([])
  })
})

describe('resolveRecentQuickCommand', () => {
  it('matches legacy history entries stored as a bare command id', () => {
    expect(resolveRecentQuickCommand(repoCommands, globalCommands, 'b')?.command.id).toBe('b')
  })

  it('falls back to the first repo command when the recent one is gone', () => {
    expect(resolveRecentQuickCommand(repoCommands, globalCommands, 'gone')?.command.id).toBe('a')
  })

  it('has nothing to run without commands', () => {
    expect(resolveRecentQuickCommand([], [], 'a')).toBeNull()
  })
})

describe('findMatchingTabQuickCommandOptions', () => {
  const all = [...repoCommands, ...globalCommands]

  it('matches a label token prefix', () => {
    expect(findMatchingTabQuickCommandOptions('lo', all).map((e) => e.command.id)).toEqual(['c'])
  })

  it('ranks an exact label above a prefix of another label', () => {
    const entries = [hosted('x', 'Build app staging'), hosted('y', 'Build')]
    expect(findMatchingTabQuickCommandOptions('build', entries).map((e) => e.command.id)).toEqual([
      'y',
      'x'
    ])
  })

  // Why: these rows outrank file and URL entries and the first is Enter-activated,
  // so only text the user actually typed toward may select a shell command.
  it('ignores mid-token and single-character matches', () => {
    expect(findMatchingTabQuickCommandOptions('ests', all)).toEqual([])
    expect(findMatchingTabQuickCommandOptions('b', all)).toEqual([])
  })

  it('does not match the command body, so file queries stay file queries', () => {
    const entries = [hosted('p', 'Format', 'prettier --write src/app.ts')]
    expect(findMatchingTabQuickCommandOptions('src/app.ts', entries)).toEqual([])
    expect(findMatchingTabQuickCommandOptions('prettier', entries)).toEqual([])
  })

  it('requires every query token to match', () => {
    expect(findMatchingTabQuickCommandOptions('run docs', all)).toEqual([])
  })

  it('caps how many rows one query can contribute', () => {
    const entries = ['a', 'b', 'c', 'd'].map((id) => hosted(id, `Deploy ${id}`))
    expect(findMatchingTabQuickCommandOptions('deploy', entries)).toHaveLength(3)
  })

  // Why: an empty query lists every command in the quick-commands menu, but the
  // omnibox must not prepend all of them to an unrelated result list.
  it('matches nothing until the user types', () => {
    expect(findMatchingTabQuickCommandOptions('  ', repoCommands)).toEqual([])
  })
})
