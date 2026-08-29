import type { SkillInstallDestination } from '../../shared/skill-install-contract'

export function normalizeSshRelaySkillDestination(
  destination: SkillInstallDestination
): SkillInstallDestination {
  return destination.scope === 'global'
    ? { scope: 'global', executionTarget: { kind: 'host' } }
    : destination
}
