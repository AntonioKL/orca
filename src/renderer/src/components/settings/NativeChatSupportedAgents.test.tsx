// @vitest-environment happy-dom

import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { isNativeChatSupportedAgent } from '../../../../shared/native-chat-agent-support'
import { getAgentCatalog } from '@/lib/agent-catalog'
import { NativeChatSupportedAgents } from './NativeChatSupportedAgents'

function getRenderedChips(): { agent: string; label: string }[] {
  const markup = renderToStaticMarkup(<NativeChatSupportedAgents />)
  const container = document.createElement('div')
  container.innerHTML = markup
  return Array.from(container.querySelectorAll('[data-slot="native-chat-supported-agent"]')).map(
    (node) => ({
      agent: node.getAttribute('data-agent') ?? '',
      label: node.textContent?.trim() ?? ''
    })
  )
}

describe('NativeChatSupportedAgents', () => {
  it('lists a chip for exactly the agents native chat supports', () => {
    const chips = getRenderedChips()

    const expected = getAgentCatalog()
      .filter((entry) => isNativeChatSupportedAgent(entry.id))
      .map((entry) => entry.id)

    expect(chips.map((chip) => chip.agent).sort()).toEqual([...expected].sort())
    expect(chips.length).toBeGreaterThan(0)
  })

  it('labels each chip with the catalog agent name', () => {
    for (const chip of getRenderedChips()) {
      const entry = getAgentCatalog().find((candidate) => candidate.id === chip.agent)
      expect(chip.label).toBe(entry?.label)
    }
  })

  it('omits agents native chat cannot render, including OpenCode', () => {
    const rendered = getRenderedChips().map((chip) => chip.agent)

    for (const entry of getAgentCatalog()) {
      if (!isNativeChatSupportedAgent(entry.id)) {
        expect(rendered).not.toContain(entry.id)
      }
    }
    expect(rendered).not.toContain('opencode')
  })
})
