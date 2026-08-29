import { describe, expect, it } from 'vitest'

import {
  buildJiraCreateCustomFields,
  buildJiraCreateFieldValue,
  findJiraCreateAllowedValue,
  getJiraCreateAllowedValueLabel,
  getJiraCreateOptionPayload,
  getJiraUserCreateFieldKeys,
  isJiraUserCreateField,
  isVisibleJiraCreateField
} from './task-page-jira-create-fields'
import { isJiraUserFieldValue } from '../../../shared/jira-user-field-value'
import type { JiraCreateField } from '../../../shared/jira-types'

function field(overrides: Partial<JiraCreateField> = {}): JiraCreateField {
  return { key: 'customfield_1', name: 'Custom', required: true, ...overrides }
}

describe('isVisibleJiraCreateField', () => {
  const cases = [
    { key: 'customfield_1', required: true, expected: true },
    { key: 'customfield_1', required: false, expected: false },
    { key: 'project', required: true, expected: false },
    { key: 'issuetype', required: true, expected: false },
    { key: 'summary', required: true, expected: false },
    { key: 'description', required: true, expected: false },
    // characterization: current behavior — the system-field filter is exact-match
    // and case-sensitive, so a differently-cased key stays visible.
    { key: 'Summary', required: true, expected: true }
  ]

  for (const { key, required, expected } of cases) {
    it(`returns ${expected} for ${key} (required: ${required})`, () => {
      expect(isVisibleJiraCreateField(field({ key, required }))).toBe(expected)
    })
  }
})

describe('getJiraCreateAllowedValueLabel', () => {
  it('prefers name, then value, then id', () => {
    expect(getJiraCreateAllowedValueLabel({ id: 'i', value: 'v', name: 'n' })).toBe('n')
    expect(getJiraCreateAllowedValueLabel({ id: 'i', value: 'v' })).toBe('v')
    expect(getJiraCreateAllowedValueLabel({ id: 'i' })).toBe('i')
  })

  it('falls back to Option when nothing is set', () => {
    expect(getJiraCreateAllowedValueLabel({})).toBe('Option')
  })
})

describe('findJiraCreateAllowedValue', () => {
  const withValues = field({
    allowedValues: [
      { id: 'id-1', value: 'val-1', name: 'Name 1' },
      { id: 'id-2', value: 'val-2', name: 'Name 2' }
    ]
  })

  it('matches on id, value, or name', () => {
    expect(findJiraCreateAllowedValue(withValues, 'id-2')?.id).toBe('id-2')
    expect(findJiraCreateAllowedValue(withValues, 'val-1')?.id).toBe('id-1')
    expect(findJiraCreateAllowedValue(withValues, 'Name 2')?.id).toBe('id-2')
  })

  it('returns undefined when there is no match or no allowed values', () => {
    expect(findJiraCreateAllowedValue(withValues, 'nope')).toBeUndefined()
    expect(findJiraCreateAllowedValue(field(), 'id-1')).toBeUndefined()
  })
})

describe('getJiraCreateOptionPayload', () => {
  it('prefers id, then value, then name', () => {
    expect(getJiraCreateOptionPayload({ id: 'i', value: 'v', name: 'n' }, 'fb')).toEqual({
      id: 'i'
    })
    expect(getJiraCreateOptionPayload({ value: 'v', name: 'n' }, 'fb')).toEqual({ value: 'v' })
    expect(getJiraCreateOptionPayload({ name: 'n' }, 'fb')).toEqual({ name: 'n' })
  })

  it('returns the raw fallback string when the option is absent or empty', () => {
    expect(getJiraCreateOptionPayload(undefined, 'fb')).toBe('fb')
    expect(getJiraCreateOptionPayload({}, 'fb')).toBe('fb')
  })

  it('skips empty-string members', () => {
    // characterization: current behavior — the checks are truthiness-based, so an
    // empty id falls through to the next candidate.
    expect(getJiraCreateOptionPayload({ id: '', value: 'v' }, 'fb')).toEqual({ value: 'v' })
  })
})

describe('buildJiraCreateFieldValue', () => {
  it('returns undefined for blank drafts', () => {
    expect(buildJiraCreateFieldValue(field(), '')).toBeUndefined()
    expect(buildJiraCreateFieldValue(field(), '   ')).toBeUndefined()
  })

  it('trims plain string values', () => {
    expect(buildJiraCreateFieldValue(field(), '  hello  ')).toBe('hello')
  })

  it('splits array fields on commas and drops blanks', () => {
    const arrayField = field({ schema: { type: 'array' } })
    expect(buildJiraCreateFieldValue(arrayField, 'a, b ,, c')).toEqual(['a', 'b', 'c'])
  })

  it('maps array parts through allowed values', () => {
    const arrayField = field({
      schema: { type: 'array' },
      allowedValues: [{ id: 'id-1', name: 'Name 1' }]
    })
    expect(buildJiraCreateFieldValue(arrayField, 'Name 1, other')).toEqual([
      { id: 'id-1' },
      'other'
    ])
  })

  it('maps scalar option fields through allowed values', () => {
    const optionField = field({ allowedValues: [{ id: 'id-1', name: 'Name 1' }] })
    expect(buildJiraCreateFieldValue(optionField, 'Name 1')).toEqual({ id: 'id-1' })
    expect(buildJiraCreateFieldValue(optionField, 'Unknown')).toBe('Unknown')
  })

  it('coerces finite numbers and keeps unparseable text', () => {
    const numberField = field({ schema: { type: 'number' } })
    expect(buildJiraCreateFieldValue(numberField, ' 42 ')).toBe(42)
    expect(buildJiraCreateFieldValue(numberField, 'abc')).toBe('abc')
    // characterization: current behavior — Infinity is not finite, so the trimmed
    // text is kept instead of the coerced number.
    expect(buildJiraCreateFieldValue(numberField, 'Infinity')).toBe('Infinity')
  })

  it('builds an ADF document for textarea fields', () => {
    const custom = field({ schema: { custom: 'com.atlassian.jira:textarea' } })
    expect(buildJiraCreateFieldValue(custom, 'line one\nline two')).toEqual({
      type: 'doc',
      version: 1,
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'line one' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'line two' }] }
      ]
    })
    expect(buildJiraCreateFieldValue(field({ schema: { type: 'textarea' } }), 'x')).toEqual({
      type: 'doc',
      version: 1,
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x' }] }]
    })
  })

  it('prefers allowed values over the number branch', () => {
    // characterization: current behavior — the allowedValues branch runs before the
    // number branch, so the draft stays a string even on a number-typed field.
    const numeric = field({ schema: { type: 'number' }, allowedValues: [{ id: 'id-1' }] })
    expect(buildJiraCreateFieldValue(numeric, '7')).toBe('7')
  })
})

describe('buildJiraCreateCustomFields', () => {
  it('returns undefined when every field resolves to undefined', () => {
    expect(buildJiraCreateCustomFields([field({ key: 'a' })], {})).toBeUndefined()
    expect(buildJiraCreateCustomFields([], { a: 'x' })).toBeUndefined()
  })

  it('collects only the fields with values, keyed by field key', () => {
    const fields = [field({ key: 'a' }), field({ key: 'b' }), field({ key: 'c' })]
    expect(buildJiraCreateCustomFields(fields, { a: 'one', b: '  ', c: 'three' })).toEqual({
      a: 'one',
      c: 'three'
    })
  })

  it('treats a missing draft entry as blank', () => {
    expect(buildJiraCreateCustomFields([field({ key: 'a' })], { other: 'x' })).toBeUndefined()
  })
})

describe('isJiraUserCreateField', () => {
  const cases: [string, JiraCreateField['schema'], boolean][] = [
    ['a single user field', { type: 'user' }, true],
    ['a multi-user field', { type: 'array', items: 'user' }, true],
    ['a user picker custom field', { type: 'user', custom: 'com.atlassian:userpicker' }, true],
    ['an option field', { type: 'option' }, false],
    ['a label array', { type: 'array', items: 'string' }, false],
    ['an untyped field', undefined, false]
  ]

  for (const [label, schema, expected] of cases) {
    it(`returns ${expected} for ${label}`, () => {
      expect(isJiraUserCreateField(field({ schema }))).toBe(expected)
    })
  }
})

describe('buildJiraCreateFieldValue for user fields', () => {
  // Jira Cloud rejects a bare string reporter with "Reporter is required." — the
  // value has to leave the renderer as a user marker for the host to resolve.
  it('wraps a picked account id instead of sending it as text', () => {
    const reporter = field({ key: 'reporter', name: 'Reporter', schema: { type: 'user' } })
    expect(buildJiraCreateFieldValue(reporter, '5abc')).toEqual({ accountId: '5abc' })
  })

  it('wraps every entry of a multi-user field', () => {
    const participants = field({
      key: 'customfield_100',
      schema: { type: 'array', items: 'user' }
    })
    expect(buildJiraCreateFieldValue(participants, '5abc, 5def')).toEqual([
      { accountId: '5abc' },
      { accountId: '5def' }
    ])
  })

  it('drops a blank user field so create never sends an empty reporter', () => {
    const reporter = field({ key: 'reporter', schema: { type: 'user' } })
    expect(buildJiraCreateFieldValue(reporter, '   ')).toBeUndefined()
    expect(
      buildJiraCreateFieldValue(field({ schema: { type: 'array', items: 'user' } }), ' , ')
    ).toBeUndefined()
  })

  // The host recognizes the marker with this same predicate before rewriting it
  // to Jira's per-deployment user shape.
  it('produces a value the host recognizes as a user field', () => {
    const reporter = field({ key: 'reporter', schema: { type: 'user' } })
    expect(isJiraUserFieldValue(buildJiraCreateFieldValue(reporter, '5abc'))).toBe(true)
    expect(isJiraUserFieldValue(buildJiraCreateFieldValue(field({}), 'plain'))).toBe(false)
  })

  it('carries the reporter through the create payload builder', () => {
    const reporter = field({ key: 'reporter', schema: { type: 'user' } })
    expect(buildJiraCreateCustomFields([reporter], { reporter: '5abc' })).toEqual({
      reporter: { accountId: '5abc' }
    })
  })
})

// The host rewrites the {accountId} marker only for the keys named here, so this
// list is the whole reason a lookalike value on another field survives untouched.
describe('getJiraUserCreateFieldKeys', () => {
  it('names only the fields Jira declares as users, single and array alike', () => {
    expect(
      getJiraUserCreateFieldKeys([
        field({ key: 'reporter', schema: { type: 'user' } }),
        field({ key: 'customfield_watchers', schema: { type: 'array', items: 'user' } }),
        field({ key: 'customfield_opt', schema: { type: 'option' } }),
        field({ key: 'customfield_text', schema: { type: 'string' } }),
        field({ key: 'customfield_untyped' })
      ])
    ).toEqual(['reporter', 'customfield_watchers'])
  })

  it('names nothing when the issue type has no user field', () => {
    expect(getJiraUserCreateFieldKeys([field({ key: 'customfield_opt' })])).toEqual([])
  })
})
