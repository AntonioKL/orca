/**
 * The category vocabulary for native-chat tool rows, and the one glyph each
 * category keeps. A row is `icon + word + argument`: the icon is decorative and
 * the word carries identity, so a renderer must never draw the glyph alone.
 *
 * The glyph is fixed per category across running/completed/failed — only tone
 * changes, plus a trailing mark on failure. A row that swapped glyphs when it
 * finished would read as changing identity.
 */
export type NativeChatToolCategory =
  | 'read'
  | 'search'
  | 'listFiles'
  | 'unknown'
  | 'fileChange'
  | 'webSearch'
  | 'mcpToolCall'
  | 'subAgentActivity'

/** lucide glyph ids. Spelled the same by `lucide-react` and `lucide-react-native`,
 *  so desktop and mobile can resolve one name to their own component. */
export type NativeChatToolIconName =
  | 'eye'
  | 'search'
  | 'folder'
  | 'square-terminal'
  | 'pencil'
  | 'globe'
  | 'plug'
  | 'bot'

/** Category to glyph. All eight are named now, though only the classified shell
 *  categories reach a row today; MCP and web-search rows land separately. */
export const NATIVE_CHAT_TOOL_ICON_NAMES: Record<NativeChatToolCategory, NativeChatToolIconName> = {
  read: 'eye',
  search: 'search',
  listFiles: 'folder',
  unknown: 'square-terminal',
  fileChange: 'pencil',
  webSearch: 'globe',
  mcpToolCall: 'plug',
  subAgentActivity: 'bot'
}

/**
 * Row word to category. Keyed by the word a lane actually renders, not by the
 * protocol type, because that word is all a row model carries. `mcpToolCall` and
 * `subAgentActivity` are absent by design — those rows are named after the tool
 * or the agent, so their renderer passes the category itself.
 * A `Map`, not an object: an object index answers `__proto__` with a truthy value.
 */
const CATEGORY_BY_ROW_WORD = new Map<string, NativeChatToolCategory>([
  ['read', 'read'],
  ['search', 'search'],
  ['list', 'listFiles'],
  ['shell', 'unknown'],
  ['edit', 'fileChange'],
  ['web search', 'webSearch'],
  ['websearch', 'webSearch']
])

/** The category a row word names, or null when the lane emitted something this
 *  vocabulary doesn't model yet. */
export function nativeChatToolCategory(rowWord: string): NativeChatToolCategory | null {
  return CATEGORY_BY_ROW_WORD.get(rowWord.trim().toLowerCase()) ?? null
}

/** The glyph for a row word. Never empty: an unmodelled word gets the terminal
 *  glyph so rows stay left-aligned when a lane ships a type we don't name. */
export function nativeChatToolIconName(rowWord: string): NativeChatToolIconName {
  return NATIVE_CHAT_TOOL_ICON_NAMES[nativeChatToolCategory(rowWord) ?? 'unknown']
}
