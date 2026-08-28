import { describe, expect, it } from 'vitest'
import {
  getCodeBlockLanguageLabel,
  getCodeBlockLanguages,
  isKnownCodeBlockLanguage
} from './rich-markdown-code-block-languages'

describe('rich markdown code block languages', () => {
  it('caches the resolved list so repeated renders skip i18next lookups', () => {
    expect(getCodeBlockLanguages()).toBe(getCodeBlockLanguages())
  })

  it('exposes a plain-text entry for unset fences and never blank labels', () => {
    const languages = getCodeBlockLanguages()

    expect(languages.some((language) => language.value === '')).toBe(true)
    expect(languages.every((language) => language.label.length > 0)).toBe(true)
  })

  it('labels known languages and passes unknown fences through verbatim', () => {
    expect(getCodeBlockLanguageLabel('')).toBe('Plain text')
    expect(getCodeBlockLanguageLabel('rust')).toBe('Rust')
    expect(getCodeBlockLanguageLabel('c')).toBe('C')
    // Why: a fence may name any language; the collapsed <select> still has to show it.
    expect(getCodeBlockLanguageLabel('brainfuck')).toBe('brainfuck')
  })

  it('reports membership for the unknown-language fallback option', () => {
    expect(isKnownCodeBlockLanguage('rust')).toBe(true)
    expect(isKnownCodeBlockLanguage('brainfuck')).toBe(false)
  })
})
