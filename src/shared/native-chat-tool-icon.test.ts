import { describe, expect, it } from 'vitest'
import {
  NATIVE_CHAT_TOOL_ICON_NAMES,
  nativeChatToolCategory,
  nativeChatToolIconName,
  type NativeChatToolCategory
} from './native-chat-tool-icon'

const ALL_CATEGORIES: NativeChatToolCategory[] = [
  'read',
  'search',
  'listFiles',
  'unknown',
  'fileChange',
  'webSearch',
  'mcpToolCall',
  'subAgentActivity'
]

describe('native chat tool icons', () => {
  it('names a glyph for every category in the vocabulary', () => {
    expect(NATIVE_CHAT_TOOL_ICON_NAMES).toEqual({
      read: 'eye',
      search: 'search',
      listFiles: 'folder',
      unknown: 'square-terminal',
      fileChange: 'pencil',
      webSearch: 'globe',
      mcpToolCall: 'plug',
      subAgentActivity: 'bot'
    })
    expect(Object.keys(NATIVE_CHAT_TOOL_ICON_NAMES).sort()).toEqual([...ALL_CATEGORIES].sort())
  })

  it('gives each category a distinct glyph so rows are told apart by icon', () => {
    const glyphs = ALL_CATEGORIES.map((category) => NATIVE_CHAT_TOOL_ICON_NAMES[category])
    expect(new Set(glyphs).size).toBe(glyphs.length)
  })

  it('maps the row words the lanes render to their category', () => {
    expect(nativeChatToolCategory('read')).toBe('read')
    expect(nativeChatToolCategory('search')).toBe('search')
    expect(nativeChatToolCategory('list')).toBe('listFiles')
    expect(nativeChatToolCategory('shell')).toBe('unknown')
    expect(nativeChatToolCategory('edit')).toBe('fileChange')
    expect(nativeChatToolCategory('web search')).toBe('webSearch')
  })

  it('resolves the glyph for each classified row word', () => {
    expect(nativeChatToolIconName('read')).toBe('eye')
    expect(nativeChatToolIconName('search')).toBe('search')
    expect(nativeChatToolIconName('list')).toBe('folder')
    expect(nativeChatToolIconName('shell')).toBe('square-terminal')
    expect(nativeChatToolIconName('edit')).toBe('pencil')
    expect(nativeChatToolIconName('web search')).toBe('globe')
  })

  it('reads a row word regardless of case or surrounding space', () => {
    expect(nativeChatToolIconName('  Read ')).toBe('eye')
    expect(nativeChatToolIconName('WebSearch')).toBe('globe')
  })

  it('falls back to the terminal glyph for a word outside the vocabulary', () => {
    expect(nativeChatToolCategory('apply_patch')).toBeNull()
    expect(nativeChatToolIconName('apply_patch')).toBe('square-terminal')
    expect(nativeChatToolIconName('')).toBe('square-terminal')
  })

  it('does not answer a prototype key with a glyph', () => {
    expect(nativeChatToolCategory('__proto__')).toBeNull()
    expect(nativeChatToolCategory('constructor')).toBeNull()
    expect(nativeChatToolIconName('__proto__')).toBe('square-terminal')
  })
})
