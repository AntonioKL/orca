import { describe, expect, it } from 'vitest'
import type { BrowserHistoryEntry } from '../../../shared/browser-workspace-types'
import {
  matchBrowserHistory,
  prepareBrowserHistoryEntries,
  type BrowserHistoryMatchTier
} from './browser-history-match'

const NOW = Date.UTC(2026, 7, 27, 12)
const HOUR = 60 * 60 * 1000

function entry(overrides: Partial<BrowserHistoryEntry> & { url: string }): BrowserHistoryEntry {
  return {
    normalizedUrl: overrides.url.replace(/\/$/, ''),
    title: '',
    lastVisitedAt: NOW,
    visitCount: 1,
    ...overrides
  }
}

function match(
  entries: readonly BrowserHistoryEntry[],
  query: string,
  options: { includeUrlTail?: boolean; limit?: number } = {}
): { tier: BrowserHistoryMatchTier; url: string }[] {
  return matchBrowserHistory({
    prepared: prepareBrowserHistoryEntries(entries),
    query,
    limit: options.limit ?? 10,
    now: NOW,
    ...(options.includeUrlTail === undefined ? {} : { includeUrlTail: options.includeUrlTail })
  }).map((result) => ({ tier: result.tier, url: result.entry.url }))
}

const GIT_CORPUS = [
  entry({ url: 'https://example.com/?ref=git', title: 'Example', visitCount: 50 }),
  entry({ url: 'https://example.org/hooks', title: 'Configure git hooks', visitCount: 50 }),
  entry({ url: 'https://docs.legit.dev/api', title: 'API', visitCount: 50 }),
  entry({ url: 'https://github.com/acme/orca', title: 'acme/orca', visitCount: 50 })
]

describe('browser history match', () => {
  it('orders host-prefix above host-substring above title above url-tail', () => {
    expect(match(GIT_CORPUS, 'git')).toEqual([
      { tier: 'host-prefix', url: 'https://github.com/acme/orca' },
      { tier: 'host-substring', url: 'https://docs.legit.dev/api' },
      { tier: 'title', url: 'https://example.org/hooks' },
      { tier: 'url-tail', url: 'https://example.com/?ref=git' }
    ])
  })

  it('strips scheme and a leading www. before testing the host prefix', () => {
    expect(match([entry({ url: 'https://www.github.com/acme' })], 'git')).toEqual([
      { tier: 'host-prefix', url: 'https://www.github.com/acme' }
    ])
  })

  it('leaves a subdomain match in host-substring rather than host-prefix', () => {
    expect(match([entry({ url: 'https://docs.github.com/actions' })], 'git')).toEqual([
      { tier: 'host-substring', url: 'https://docs.github.com/actions' }
    ])
  })

  it('drops url-tail matches for the omnibox and keeps them for the address bar', () => {
    expect(match(GIT_CORPUS, 'git', { includeUrlTail: false }).map((row) => row.tier)).toEqual([
      'host-prefix',
      'host-substring',
      'title'
    ])
    expect(match(GIT_CORPUS, 'git', { includeUrlTail: true })).toHaveLength(4)
  })

  it('ranks by frecency inside a tier and clamps the visit-count bonus at 50', () => {
    const rows = match(
      [
        entry({
          url: 'https://acme.dev/clamped',
          visitCount: 5000,
          lastVisitedAt: NOW - 23 * HOUR
        }),
        entry({ url: 'https://acme.dev/fresh', visitCount: 50, lastVisitedAt: NOW })
      ],
      'acme'
    )

    expect(rows.map((row) => row.url)).toEqual([
      'https://acme.dev/fresh',
      'https://acme.dev/clamped'
    ])
  })

  it('floors the recency contribution at zero rather than penalising old entries', () => {
    const rows = match(
      [
        entry({
          url: 'https://acme.dev/ancient',
          visitCount: 3,
          lastVisitedAt: NOW - 10_000 * HOUR
        }),
        entry({ url: 'https://acme.dev/old', visitCount: 2, lastVisitedAt: NOW - 100 * HOUR })
      ],
      'acme'
    )

    expect(rows.map((row) => row.url)).toEqual(['https://acme.dev/ancient', 'https://acme.dev/old'])
  })

  it('breaks ties on lastVisitedAt so ordering cannot wobble between renders', () => {
    const tied = [
      entry({ url: 'https://acme.dev/a', visitCount: 1, lastVisitedAt: NOW - 200 * HOUR }),
      entry({ url: 'https://acme.dev/b', visitCount: 1, lastVisitedAt: NOW - 100 * HOUR })
    ]
    const first = match(tied, 'acme')

    expect(first.map((row) => row.url)).toEqual(['https://acme.dev/b', 'https://acme.dev/a'])
    expect(match(tied, 'acme')).toEqual(first)
    expect(match(tied.toReversed(), 'acme')).toEqual(first)
  })

  it('honours the limit and returns the shared empty array when nothing matches', () => {
    expect(match(GIT_CORPUS, 'git', { limit: 2 })).toHaveLength(2)
    const prepared = prepareBrowserHistoryEntries(GIT_CORPUS)
    const missA = matchBrowserHistory({ prepared, query: 'nothing-here', limit: 3, now: NOW })
    const missB = matchBrowserHistory({ prepared, query: 'also-nothing', limit: 3, now: NOW })

    expect(missA).toHaveLength(0)
    // Identity: an empty result must not churn the caller's memos.
    expect(missA).toBe(missB)
    expect(matchBrowserHistory({ prepared, query: '   ', limit: 3, now: NOW })).toBe(missA)
    expect(matchBrowserHistory({ prepared, query: 'git', limit: 0, now: NOW })).toBe(missA)
  })

  it('survives an unparseable url by falling back to url and title matching', () => {
    const broken = entry({ url: 'not a url at all', title: 'Broken' })

    expect(match([broken], 'url at')).toEqual([{ tier: 'url-tail', url: 'not a url at all' }])
    expect(match([broken], 'brok')).toEqual([{ tier: 'title', url: 'not a url at all' }])
  })

  it('agrees with a naive reference scan on which entries match', () => {
    const corpus = Array.from({ length: 300 }, (_, index) =>
      entry({
        url: `https://host-${index % 17}.example${index % 3 === 0 ? '.dev' : '.com'}/path/${index}?q=seg${index % 7}`,
        title: `Page ${index} about topic ${index % 11}`,
        lastVisitedAt: NOW - (index % 90) * HOUR,
        visitCount: index % 120
      })
    )
    for (const query of ['host-3', 'topic 4', 'seg2', 'example.dev', 'zzz']) {
      const lower = query.toLowerCase()
      const reference = corpus
        .filter(
          (item) =>
            item.url.toLowerCase().includes(lower) || item.title.toLowerCase().includes(lower)
        )
        .map((item) => item.url)
        .sort()

      expect(
        match(corpus, query, { limit: corpus.length })
          .map((row) => row.url)
          .sort()
      ).toEqual(reference)
    }
  })
})
