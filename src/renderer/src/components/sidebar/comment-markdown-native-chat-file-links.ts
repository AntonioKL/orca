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

function isLinkifiableFile(link: ParsedTerminalFileLink, requireSeparator: boolean): boolean {
  return (
    (!requireSeparator || /[\\/]/.test(link.pathText)) &&
    routeNativeChatHref(link.displayText).kind === 'file'
  )
}

function createFileLinkNode(value: string, child: MarkdownNode): MarkdownNode {
  return {
    type: 'link',
    url: createNativeChatFileHref(value),
    children: [child]
  }
}

function splitTextNode(value: string): MarkdownNode[] {
  const links = extractTerminalFileLinks(value).filter((link) => isLinkifiableFile(link, true))
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
