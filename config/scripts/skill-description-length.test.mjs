import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parse } from 'yaml'
import { describe, expect, it } from 'vitest'

// Why: the Agent Skills spec caps `description` at 1,024 characters after YAML folding, and
// conforming installers reject a skill over it (#17935). Every skills/*/SKILL.md must fit.
const SKILLS_ROOT = resolve(import.meta.dirname, '../../skills')
const MAX_DESCRIPTION_LENGTH = 1024

function readDescription(skillText) {
  const frontmatter = /^---\n([\s\S]*?)\n---\n/u.exec(skillText)?.[1] ?? ''
  return parse(frontmatter)?.description ?? ''
}

describe('bundled skill descriptions', () => {
  it('stay within the Agent Skills 1024-character limit', () => {
    const skills = readdirSync(SKILLS_ROOT, { withFileTypes: true }).filter((entry) =>
      entry.isDirectory()
    )
    expect(skills.length).toBeGreaterThan(0)

    const violations = skills.flatMap((entry) => {
      const description = readDescription(
        readFileSync(join(SKILLS_ROOT, entry.name, 'SKILL.md'), 'utf8')
      )
      if (!description.trim()) {
        return [`${entry.name}: missing description`]
      }
      return description.length > MAX_DESCRIPTION_LENGTH
        ? [`${entry.name}: ${description.length} chars (limit ${MAX_DESCRIPTION_LENGTH})`]
        : []
    })
    expect(violations).toEqual([])
  })
})
