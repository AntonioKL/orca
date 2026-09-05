import { Bot, Eye, Folder, Globe, Pencil, Plug, Search, SquareTerminal } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  NATIVE_CHAT_TOOL_ICON_NAMES,
  nativeChatToolIconName,
  type NativeChatToolCategory,
  type NativeChatToolIconName
} from '../../../../shared/native-chat-tool-icon'

/** Glyph name to component. Exported so a call site that places the icon itself
 *  (the run header's active slot) resolves it by lookup, not by constructing a
 *  component mid-render. */
export const NATIVE_CHAT_TOOL_GLYPHS: Record<NativeChatToolIconName, LucideIcon> = {
  eye: Eye,
  search: Search,
  folder: Folder,
  'square-terminal': SquareTerminal,
  pencil: Pencil,
  globe: Globe,
  plug: Plug,
  bot: Bot
}

/**
 * The category glyph on a tool row. Decorative — the word beside it is the
 * accessible name — so it is `aria-hidden` and must never render without that
 * word. Fixed 16px slot with a 14px glyph keeps every row left-aligned,
 * including rows whose category this vocabulary doesn't model.
 */
export function NativeChatToolIcon({
  rowWord,
  category,
  className
}: {
  /** The word the row renders. Ignored when `category` is given. */
  rowWord: string
  /** For rows named after a tool or agent rather than their category. */
  category?: NativeChatToolCategory
  className?: string
}): React.JSX.Element {
  const Glyph =
    NATIVE_CHAT_TOOL_GLYPHS[
      category ? NATIVE_CHAT_TOOL_ICON_NAMES[category] : nativeChatToolIconName(rowWord)
    ]
  return (
    <span className={cn('flex size-4 shrink-0 items-center justify-center', className)}>
      <Glyph aria-hidden className="size-3.5" />
    </span>
  )
}
