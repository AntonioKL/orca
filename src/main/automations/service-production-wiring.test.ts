import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('automation production agent-launch gate wiring', () => {
  const source = readFileSync(join(process.cwd(), 'src/main/index.ts'), 'utf8')

  it('classifies the resolved agent before desktop and headless dispatch', () => {
    const serviceStart = source.indexOf('automations = new AutomationService(store, {')
    const dispatcherStart = source.indexOf('headlessDispatcher:', serviceStart)
    const classifierStart = source.indexOf('classifyAgentLaunch:', serviceStart)

    expect(serviceStart).toBeGreaterThanOrEqual(0)
    expect(classifierStart).toBeGreaterThan(serviceStart)
    expect(classifierStart).toBeLessThan(dispatcherStart)
    expect(source.slice(classifierStart, dispatcherStart)).toContain(
      'runtimeService.classifyAgentLaunchForAutomation('
    )
    expect(source.slice(classifierStart, dispatcherStart)).toContain('target.cwd')
  })
})
