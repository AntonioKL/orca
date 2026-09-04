// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  NATIVE_CHAT_FILE_HREF_PREFIX,
  routeNativeChatHref
} from '../../../../shared/native-chat-href-routing'
import CommentMarkdown from './CommentMarkdown'

describe('CommentMarkdown link click handler', () => {
  let root: Root | null = null
  let container: HTMLDivElement | null = null

  afterEach(() => {
    if (root) {
      act(() => root?.unmount())
    }
    container?.remove()
    root = null
    container = null
  })

  it('lets callers intercept rendered document links', () => {
    const onLinkClick = vi.fn((event: React.MouseEvent<HTMLElement>) => {
      event.preventDefault()
    })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)

    act(() => {
      root?.render(
        <CommentMarkdown
          variant="document"
          content="[docs](docs/guide.md)"
          onLinkClick={onLinkClick}
        />
      )
    })

    const anchor = container.querySelector<HTMLAnchorElement>('a[href="docs/guide.md"]')
    expect(anchor).not.toBeNull()
    const event = new window.MouseEvent('click', { bubbles: true, cancelable: true })

    act(() => {
      anchor?.dispatchEvent(event)
    })

    expect(onLinkClick).toHaveBeenCalledWith(expect.any(Object), 'docs/guide.md')
    expect(event.defaultPrevented).toBe(true)
  })

  it('sanitizes file URI links unless the caller opts in', () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)

    act(() => {
      root?.render(
        <CommentMarkdown variant="document" content="[source](file:///repo/worktree/src/main.ts)" />
      )
    })

    const anchor = container.querySelector<HTMLAnchorElement>('a')
    expect(anchor).not.toBeNull()
    expect(anchor?.getAttribute('href')).toBeNull()
  })

  it('sanitizes raw HTML file URI links unless the caller opts in', () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)

    act(() => {
      root?.render(
        <CommentMarkdown
          variant="document"
          content='<a href="file:///repo/worktree/src/main.ts">source</a>'
        />
      )
    })

    const anchor = container.querySelector<HTMLAnchorElement>('a')
    expect(anchor).not.toBeNull()
    expect(anchor?.getAttribute('href')).toBeNull()
  })

  it('lets opted-in callers intercept rendered file URI links', () => {
    const onLinkClick = vi.fn()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)

    act(() => {
      root?.render(
        <CommentMarkdown
          variant="document"
          content="[source](file:///repo/worktree/src/main.ts)"
          onLinkClick={onLinkClick}
          allowFileUriLinks
        />
      )
    })

    const anchor = container.querySelector<HTMLAnchorElement>(
      'a[href="file:///repo/worktree/src/main.ts"]'
    )
    expect(anchor).not.toBeNull()
    const event = new window.MouseEvent('click', { bubbles: true, cancelable: true })

    act(() => {
      anchor?.dispatchEvent(event)
    })

    expect(onLinkClick).toHaveBeenCalledWith(
      expect.any(Object),
      'file:///repo/worktree/src/main.ts'
    )
    expect(event.defaultPrevented).toBe(true)
  })

  it('lets callers intercept rendered document images', () => {
    const onLinkClick = vi.fn((event: React.MouseEvent<HTMLElement>) => {
      event.preventDefault()
    })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)

    act(() => {
      root?.render(
        <CommentMarkdown
          variant="document"
          content="![diagram](assets/diagram.png)"
          onLinkClick={onLinkClick}
        />
      )
    })

    const image = container.querySelector<HTMLImageElement>('img[alt="diagram"]')
    expect(image?.getAttribute('src')).toBe('assets/diagram.png')
    const event = new window.MouseEvent('click', { bubbles: true, cancelable: true })

    act(() => {
      image?.dispatchEvent(event)
    })

    expect(onLinkClick).toHaveBeenCalledWith(expect.any(Object), 'assets/diagram.png')
    expect(event.defaultPrevented).toBe(true)
  })

  it('linkifies bare POSIX and Windows document paths without an extension allowlist', () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)

    act(() => {
      root?.render(
        <CommentMarkdown
          variant="document"
          content={String.raw`Open /tmp/sta-6481-explainer.html, docs/review.docx, C:\Reports\final.pages, ./scripts/release, and src/release:12.`}
          onLinkClick={vi.fn()}
          linkifyFilePaths
        />
      )
    })

    const routes = Array.from(container.querySelectorAll<HTMLAnchorElement>('a')).map((anchor) =>
      routeNativeChatHref(anchor.getAttribute('href'))
    )
    expect(routes).toEqual([
      { kind: 'file', pathText: '/tmp/sta-6481-explainer.html', line: null },
      { kind: 'file', pathText: 'docs/review.docx', line: null },
      { kind: 'file', pathText: String.raw`C:\Reports\final.pages`, line: null },
      { kind: 'file', pathText: './scripts/release', line: null },
      { kind: 'file', pathText: 'src/release:12', line: null }
    ])
  })

  it('makes an inline-code file path clickable while preserving code styling', () => {
    const onLinkClick = vi.fn((event: React.MouseEvent<HTMLElement>) => event.preventDefault())
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)

    act(() => {
      root?.render(
        <CommentMarkdown
          variant="document"
          content={'Open `C:\\Reports\\release.docx`.'}
          onLinkClick={onLinkClick}
          linkifyFilePaths
        />
      )
    })

    const code = container.querySelector('code')
    const anchor = code?.closest('a')
    expect(anchor).not.toBeNull()
    expect(routeNativeChatHref(anchor?.getAttribute('href'))).toEqual({
      kind: 'file',
      pathText: String.raw`C:\Reports\release.docx`,
      line: null
    })

    act(() => {
      anchor?.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }))
    })
    expect(onLinkClick).toHaveBeenCalledOnce()
  })

  it('leaves prose-shaped slash tokens and numeric versions unlinked', () => {
    const proseFalsePositives = ['and/or', 'TCP/IP', '24/7', 'N/A', 'km/h', 'A/B test']
    const inlineCodeFalsePositives = ['origin/main', 'v1.2.3', '1.0']
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)

    act(() => {
      root?.render(
        <CommentMarkdown
          variant="document"
          content={`${proseFalsePositives.join(', ')}; ${inlineCodeFalsePositives.map((value) => `\`${value}\``).join(', ')}`}
          onLinkClick={vi.fn()}
          linkifyFilePaths
        />
      )
    })

    expect(container.querySelectorAll('a')).toHaveLength(0)
    for (const value of proseFalsePositives) {
      expect(container.textContent).toContain(value)
    }
    expect(Array.from(container.querySelectorAll('code')).map((code) => code.textContent)).toEqual(
      inlineCodeFalsePositives
    )
  })

  it('prevents the default action for an unresolved internal file href', () => {
    const onLinkClick = vi.fn()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)

    act(() => {
      root?.render(
        <CommentMarkdown
          variant="document"
          content="Open ~/x"
          onLinkClick={onLinkClick}
          linkifyFilePaths
        />
      )
    })

    const anchor = container.querySelector<HTMLAnchorElement>('a')
    expect(anchor?.getAttribute('href')).toMatch(new RegExp(`^${NATIVE_CHAT_FILE_HREF_PREFIX}`))
    const event = new window.MouseEvent('click', { bubbles: true, cancelable: true })

    act(() => {
      anchor?.dispatchEvent(event)
    })

    expect(onLinkClick).toHaveBeenCalledOnce()
    expect(event.defaultPrevented).toBe(true)
  })

  it('normalizes Windows markdown hrefs but leaves fenced paths as source text', () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)

    act(() => {
      root?.render(
        <CommentMarkdown
          variant="document"
          content={[
            String.raw`[report](C:\Reports\summary.pdf)`,
            '',
            '```text',
            '/tmp/not-a-link.html',
            '```'
          ].join('\n')}
          onLinkClick={vi.fn()}
          linkifyFilePaths
        />
      )
    })

    const anchors = container.querySelectorAll<HTMLAnchorElement>('a')
    expect(anchors).toHaveLength(1)
    expect(routeNativeChatHref(anchors[0]?.getAttribute('href'))).toEqual({
      kind: 'file',
      pathText: String.raw`C:\Reports\summary.pdf`,
      line: null
    })
    expect(container.querySelector('pre')?.textContent).toContain('/tmp/not-a-link.html')
  })
})
