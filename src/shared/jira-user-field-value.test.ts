import { describe, expect, it } from 'vitest'

import {
  buildJiraUserFieldValue,
  isJiraUserFieldValue,
  resolveJiraUserFieldValue,
  resolveJiraUserFieldValues
} from './jira-user-field-value'

describe('buildJiraUserFieldValue', () => {
  it('wraps a trimmed identifier and drops blank input', () => {
    expect(buildJiraUserFieldValue('  5abc  ')).toEqual({ accountId: '5abc' })
    expect(buildJiraUserFieldValue('   ')).toBeUndefined()
  })
})

describe('isJiraUserFieldValue', () => {
  const cases: [string, unknown, boolean][] = [
    ['marker', { accountId: '5abc' }, true],
    ['blank accountId', { accountId: '  ' }, false],
    ['option payload', { id: '5abc' }, false],
    ['bare string', '5abc', false],
    ['array', [{ accountId: '5abc' }], false],
    ['null', null, false]
  ]
  for (const [label, value, expected] of cases) {
    it(`returns ${expected} for a ${label}`, () => {
      expect(isJiraUserFieldValue(value)).toBe(expected)
    })
  }
})

describe('resolveJiraUserFieldValue', () => {
  it('sends Cloud an accountId under id', () => {
    expect(resolveJiraUserFieldValue({ accountId: '5abc' }, undefined)).toEqual({ id: '5abc' })
    expect(resolveJiraUserFieldValue({ accountId: '5abc' }, 'cloud')).toEqual({ id: '5abc' })
  })

  it('sends Server/DC a username under name, because it has no accountId', () => {
    expect(resolveJiraUserFieldValue({ accountId: 'ada' }, 'server')).toEqual({ name: 'ada' })
  })
})

describe('resolveJiraUserFieldValues', () => {
  it('resolves each entry of a multi-user field', () => {
    expect(
      resolveJiraUserFieldValues([{ accountId: '5abc' }, { accountId: '5def' }], 'cloud')
    ).toEqual([{ id: '5abc' }, { id: '5def' }])
  })

  it('leaves non-user values untouched', () => {
    expect(resolveJiraUserFieldValues({ id: 'opt-1' }, 'cloud')).toEqual({ id: 'opt-1' })
    expect(resolveJiraUserFieldValues('plain text', 'server')).toBe('plain text')
    expect(resolveJiraUserFieldValues(7, 'cloud')).toBe(7)
    expect(resolveJiraUserFieldValues([{ value: 'a' }], 'server')).toEqual([{ value: 'a' }])
  })
})
