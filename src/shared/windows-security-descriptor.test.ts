import { describe, expect, it } from 'vitest'
import { parseSddlDacl, resolveSddlSid } from './windows-security-descriptor'

const USER_SID = 'S-1-5-21-432636774-4279371817-3971399515-1001'

describe('parseSddlDacl', () => {
  it('reads a hardened file descriptor as icacls /save emits it', () => {
    const dacl = parseSddlDacl(`D:PAI(A;;FA;;;BA)(A;;FA;;;SY)(A;;FA;;;${USER_SID})`)

    expect(dacl?.isProtected).toBe(true)
    expect(dacl?.aces).toEqual([
      { type: 'A', flags: [], rights: 'FA', sid: 'S-1-5-32-544' },
      { type: 'A', flags: [], rights: 'FA', sid: 'S-1-5-18' },
      { type: 'A', flags: [], rights: 'FA', sid: USER_SID }
    ])
  })

  it('reads the inheritable flags a hardened directory carries', () => {
    const dacl = parseSddlDacl('D:PAI(A;OICI;FA;;;SY)')

    expect(dacl?.aces[0]!.flags).toEqual(['OI', 'CI'])
  })

  it('reports an unprotected descriptor and its inherited rules', () => {
    const dacl = parseSddlDacl(`D:(A;ID;FA;;;SY)(A;ID;FA;;;${USER_SID})`)

    expect(dacl?.isProtected).toBe(false)
    expect(dacl?.aces.map((ace) => ace.flags)).toEqual([['ID'], ['ID']])
  })

  // `OICIID` is three tokens, not a string to search: a substring test for 'ID' would also fire on
  // flag runs that merely happen to contain those letters in sequence.
  it('splits a flag run into two-letter tokens', () => {
    expect(parseSddlDacl('D:P(A;OICIID;FA;;;SY)')?.aces[0]!.flags).toEqual(['OI', 'CI', 'ID'])
    expect(parseSddlDacl('D:P(A;OICI;FA;;;SY)')?.aces[0]!.flags).not.toContain('ID')
  })

  it('stops at a trailing SACL rather than absorbing its entries', () => {
    const dacl = parseSddlDacl('D:P(A;;FA;;;SY)S:AI(AU;SAFA;FA;;;WD)')

    expect(dacl?.aces).toHaveLength(1)
    expect(dacl?.aces[0]!.sid).toBe('S-1-5-18')
  })

  it('finds the DACL after an owner and group whose aliases end in D', () => {
    const dacl = parseSddlDacl('O:WDG:WDD:P(A;;FA;;;SY)')

    expect(dacl?.isProtected).toBe(true)
    expect(dacl?.aces[0]!.sid).toBe('S-1-5-18')
  })

  it('returns null when there is no DACL', () => {
    expect(parseSddlDacl('O:BAG:BA')).toBeNull()
  })

  it('returns null for a truncated ACE rather than guessing its fields', () => {
    expect(parseSddlDacl('D:P(A;;FA)')).toBeNull()
  })
})

describe('resolveSddlSid', () => {
  it('resolves the aliases icacls substitutes for well-known SIDs', () => {
    expect(resolveSddlSid('WD')).toBe('S-1-1-0')
    expect(resolveSddlSid('BA')).toBe('S-1-5-32-544')
    expect(resolveSddlSid('SY')).toBe('S-1-5-18')
    expect(resolveSddlSid('AU')).toBe('S-1-5-11')
  })

  it('passes a raw SID through unchanged', () => {
    expect(resolveSddlSid(USER_SID)).toBe(USER_SID)
  })

  // An unknown alias must not silently compare equal to anything expected.
  it('passes an unrecognized alias through instead of dropping it', () => {
    expect(resolveSddlSid('ZZ')).toBe('ZZ')
  })
})
