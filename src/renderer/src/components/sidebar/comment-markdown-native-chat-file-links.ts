import {
  createNativeChatFileHref,
  routeNativeChatHref
} from '../../../../shared/native-chat-href-routing'
import { extractTerminalFileLinks, type ParsedTerminalFileLink } from '@/lib/terminal-links'

type MarkdownNode = {
  type: string
  value?: string
  url?: string
  children?: MarkdownNode[]
}

const ROOTED_PATH_PREFIX_PATTERN = /^(?:~[\\/]|\.{1,2}[\\/]|[\\/]|[A-Za-z]:[\\/])/

function isLinkifiableFile(link: ParsedTerminalFileLink, requireSeparator: boolean): boolean {
  const hasRootedPrefix = ROOTED_PATH_PREFIX_PATTERN.test(link.pathText)
  const hasLineSuffix = link.line !== null || link.column !== null
  const hasAlphabeticExtension = /\.[\p{L}][\p{L}\p{N}\p{M}_+-]*$/u.test(link.pathText)
  const hasPathExtension = /\.[\p{L}\p{N}][\p{L}\p{N}\p{M}_+-]*$/u.test(link.pathText)
  return (
    (!requireSeparator || /[\\/]/.test(link.pathText)) &&
    (hasRootedPrefix ||
      hasLineSuffix ||
      (requireSeparator ? hasPathExtension : hasAlphabeticExtension)) &&
    routeNativeChatHref(link.displayText).kind === 'file'
  )
}

const SAFE_LEADING_BOUNDARY_PATTERN = /[\s([{'",;]/
const SAFE_TRAILING_BOUNDARY_PATTERN = /[\s)\]}>'",;.:]/

function hasPartialPathBoundary(value: string, link: ParsedTerminalFileLink): boolean {
  const before = value[link.startIndex - 1]
  const after = value[link.endIndex]
  return (
    (before !== undefined && !SAFE_LEADING_BOUNDARY_PATTERN.test(before)) ||
    (after !== undefined && !SAFE_TRAILING_BOUNDARY_PATTERN.test(after))
  )
}

function createFileLinkNode(value: string, child: MarkdownNode): MarkdownNode {
  return {
    type: 'link',
    url: createNativeChatFileHref(value),
    children: [child]
  }
}

// Why: the terminal extractor spans "src/a.ts and src/b.ts" as one spaced path.
// An unrooted span holding a bare word or several linkable tokens is prose
// joining paths, so link the tokens on their own; a spaced folder name keeps
// every token path-shaped and stays one link.
function splitProseJoinedLinks(link: ParsedTerminalFileLink): ParsedTerminalFileLink[] {
  if (ROOTED_PATH_PREFIX_PATTERN.test(link.pathText)) {
    return [link]
  }
  const tokens = Array.from(link.displayText.matchAll(/\S+/g))
  const tokenLinks: ParsedTerminalFileLink[] = []
  for (const match of tokens) {
    const token = match[0]
    const exactLink = extractTerminalFileLinks(token).find(
      (candidate) => candidate.startIndex === 0 && candidate.endIndex === token.length
    )
    if (exactLink && isLinkifiableFile(exactLink, true)) {
      const startIndex = link.startIndex + (match.index ?? 0)
      tokenLinks.push({ ...exactLink, startIndex, endIndex: startIndex + token.length })
    }
  }
  const hasBareWord = tokens.some((match) => !/[\\/.]/.test(match[0]))
  return hasBareWord || tokenLinks.length > 1 ? tokenLinks : [link]
}

function splitTextNode(value: string): MarkdownNode[] {
  const links = extractTerminalFileLinks(value)
    .filter((link) => !hasPartialPathBoundary(value, link))
    .filter((link) => isLinkifiableFile(link, true))
    .flatMap(splitProseJoinedLinks)
  if (links.length === 0) {
    return [{ type: 'text', value }]
  }

  const children: MarkdownNode[] = []
  let cursor = 0
  for (const link of links) {
    if (link.startIndex < cursor) {
      continue
    }
    if (link.startIndex > cursor) {
      children.push({ type: 'text', value: value.slice(cursor, link.startIndex) })
    }
    children.push(createFileLinkNode(link.displayText, { type: 'text', value: link.displayText }))
    cursor = link.endIndex
  }
  if (cursor < value.length) {
    children.push({ type: 'text', value: value.slice(cursor) })
  }
  return children
}

function inlineCodeFileLink(node: MarkdownNode): MarkdownNode | null {
  const value = node.value?.trim()
  if (!value) {
    return null
  }
  const exactLink = extractTerminalFileLinks(value).find(
    (link) => link.startIndex === 0 && link.endIndex === value.length
  )
  return exactLink && isLinkifiableFile(exactLink, false) ? createFileLinkNode(value, node) : null
}

function transformFileLinks(node: MarkdownNode): void {
  if (node.type === 'link') {
    if (node.url && routeNativeChatHref(node.url).kind === 'file') {
      node.url = createNativeChatFileHref(node.url)
    }
    return
  }
  if (!node.children || node.type === 'image') {
    return
  }

  const children: MarkdownNode[] = []
  for (const child of node.children) {
    if (child.type === 'text' && child.value !== undefined) {
      children.push(...splitTextNode(child.value))
      continue
    }
    if (child.type === 'inlineCode') {
      children.push(inlineCodeFileLink(child) ?? child)
      continue
    }
    transformFileLinks(child)
    children.push(child)
  }
  node.children = children
}

export function remarkNativeChatFileLinks(): (tree: MarkdownNode) => void {
  return (tree) => transformFileLinks(tree)
}
