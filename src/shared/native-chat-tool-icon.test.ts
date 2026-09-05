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
  'subAgentActivity',
  'todoList',
  'other'
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
      subAgentActivity: 'bot',
      todoList: 'list-checks',
      other: 'wrench'
    })
    expect(Object.keys(NATIVE_CHAT_TOOL_ICON_NAMES).sort()).toEqual([...ALL_CATEGORIES].sort())
  })

  it('gives each category a distinct glyph so rows are told apart by icon', () => {
    const glyphs = ALL_CATEGORIES.map((category) => NATIVE_CHAT_TOOL_ICON_NAMES[category])
    expect(new Set(glyphs).size).toBe(glyphs.length)
  })

  it('maps the row words the Codex lane renders to their category', () => {
    expect(nativeChatToolCategory('read')).toBe('read')
    expect(nativeChatToolCategory('search')).toBe('search')
    expect(nativeChatToolCategory('list')).toBe('listFiles')
    expect(nativeChatToolCategory('shell')).toBe('unknown')
    expect(nativeChatToolCategory('apply_patch')).toBe('fileChange')
    expect(nativeChatToolCategory('web search')).toBe('webSearch')
  })

  it('maps the tool names the Claude lane renders verbatim', () => {
    expect(nativeChatToolIconName('Read')).toBe('eye')
    expect(nativeChatToolIconName('Bash')).toBe('square-terminal')
    expect(nativeChatToolIconName('Grep')).toBe('search')
    expect(nativeChatToolIconName('Glob')).toBe('search')
    expect(nativeChatToolIconName('Task')).toBe('bot')
    expect(nativeChatToolIconName('WebFetch')).toBe('globe')
    expect(nativeChatToolIconName('TodoWrite')).toBe('list-checks')
  })

  it('reads the whole edit family from the shared set, not a parallel list', () => {
    for (const name of ['Edit', 'MultiEdit', 'Write', 'str_replace', 'apply_patch']) {
      expect(nativeChatToolCategory(name)).toBe('fileChange')
      expect(nativeChatToolIconName(name)).toBe('pencil')
    }
  })

  it('reads an MCP tool by its prefix, since the row is named after the tool', () => {
    expect(nativeChatToolCategory('mcp__linear__create_issue')).toBe('mcpToolCall')
    expect(nativeChatToolIconName('mcp__playwright__browser_click')).toBe('plug')
    // Not a prefix match: a tool merely mentioning mcp is not an MCP call.
    expect(nativeChatToolCategory('run_mcp__thing')).toBeNull()
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

  it('falls back to the generic tool glyph, not the terminal, outside the vocabulary', () => {
    // Claiming a terminal here would assert a shell ran when nothing says one did.
    expect(nativeChatToolCategory('AskUserQuestion')).toBeNull()
    expect(nativeChatToolIconName('AskUserQuestion')).toBe('wrench')
    expect(nativeChatToolIconName('')).toBe('wrench')
  })

  it('keeps the terminal glyph for a row that really ran a command', () => {
    for (const name of ['shell', 'bash', 'run_terminal_cmd']) {
      expect(nativeChatToolIconName(name)).toBe('square-terminal')
    }
  })

  it('does not answer a prototype key with a glyph', () => {
    expect(nativeChatToolCategory('__proto__')).toBeNull()
    expect(nativeChatToolCategory('constructor')).toBeNull()
    expect(nativeChatToolIconName('__proto__')).toBe('wrench')
  })
})
