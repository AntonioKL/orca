import {
  Bot,
  Eye,
  Folder,
  Globe,
  ListChecks,
  Pencil,
  Plug,
  Search,
  SquareTerminal,
  Wrench
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  nativeChatToolIconName,
  type NativeChatToolIconName
} from '../../../../shared/native-chat-tool-icon'

/** Glyph name to component. */
const NATIVE_CHAT_TOOL_GLYPHS: Record<NativeChatToolIconName, LucideIcon> = {
  eye: Eye,
  search: Search,
  folder: Folder,
  'square-terminal': SquareTerminal,
  pencil: Pencil,
  globe: Globe,
  plug: Plug,
  bot: Bot,
  'list-checks': ListChecks,
  wrench: Wrench
}

/**
 * The category glyph on a tool row. Decorative — the word beside it is the
 * accessible name — so it is `aria-hidden` and must never render without that
 * word. Fixed 16px slot with a 14px glyph keeps every row left-aligned,
 * including rows whose category this vocabulary doesn't model.
 *
 * The run header resolves its glyph through this same component, so a header and
 * the row it names can never disagree about one tool.
 */
export function NativeChatToolIcon({
  rowWord,
  className
}: {
  /** The word the row renders, which is the row's whole identity. */
  rowWord: string
  className?: string
}): React.JSX.Element {
  const Glyph = NATIVE_CHAT_TOOL_GLYPHS[nativeChatToolIconName(rowWord)]
  return (
    <span className={cn('flex size-4 shrink-0 items-center justify-center', className)}>
      <Glyph aria-hidden className="size-3.5" />
    </span>
  )
}
