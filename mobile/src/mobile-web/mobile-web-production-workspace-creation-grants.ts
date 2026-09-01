import type { MobileWebBridgeShellMessage } from '../../../src/shared/mobile-web/bridge-contract'

type MobileWebWorkspaceCreationOperationGrant = Extract<
  MobileWebBridgeShellMessage,
  { type: 'init' }
>['grants'][number]

const READ_LIMITS = {
  maxRequestBytes: 1024,
  maxResponseBytes: 128 * 1024,
  maxConcurrent: 2,
  rateCapacity: 8,
  rateRefillPerSecond: 2
} as const

const CREATE_LIMITS = {
  maxRequestBytes: 64 * 1024,
  maxResponseBytes: 2 * 1024,
  maxConcurrent: 1,
  rateCapacity: 2,
  rateRefillPerSecond: 0.1
} as const

export const MOBILE_WEB_PRODUCTION_WORKSPACE_CREATION_GRANTS = [
  { capability: 'workspace', operation: 'creationRepositories', limits: READ_LIMITS },
  { capability: 'workspace', operation: 'creationRetiredNames', limits: READ_LIMITS },
  { capability: 'workspace', operation: 'creationSettings', limits: READ_LIMITS },
  { capability: 'workspace', operation: 'creationTrustedHooks', limits: READ_LIMITS },
  { capability: 'workspace', operation: 'creationGitLabAvailability', limits: READ_LIMITS },
  { capability: 'workspace', operation: 'creationLinearAvailability', limits: READ_LIMITS },
  { capability: 'workspace', operation: 'creationSshState', limits: READ_LIMITS },
  {
    capability: 'workspace',
    operation: 'creationSshConnect',
    limits: { ...READ_LIMITS, maxConcurrent: 1, rateCapacity: 3, rateRefillPerSecond: 0.25 }
  },
  { capability: 'workspace', operation: 'creationDetectAgents', limits: READ_LIMITS },
  { capability: 'workspace', operation: 'creationRepoHooks', limits: READ_LIMITS },
  { capability: 'workspace', operation: 'creationRuntimeCapabilities', limits: READ_LIMITS },
  { capability: 'workspace', operation: 'creationSparsePresets', limits: READ_LIMITS },
  {
    capability: 'workspace',
    operation: 'creationSaveSparsePreset',
    limits: { ...READ_LIMITS, maxRequestBytes: 64 * 1024, maxConcurrent: 1 }
  },
  {
    capability: 'workspace',
    operation: 'creationPersistTrust',
    limits: {
      maxRequestBytes: 128 * 1024,
      maxResponseBytes: 128 * 1024,
      maxConcurrent: 1,
      rateCapacity: 4,
      rateRefillPerSecond: 0.5
    }
  },
  {
    capability: 'workspace',
    operation: 'creationSearchGitHub',
    limits: { ...READ_LIMITS, maxRequestBytes: 4096 }
  },
  {
    capability: 'workspace',
    operation: 'creationSearchGitLab',
    limits: { ...READ_LIMITS, maxRequestBytes: 4096 }
  },
  {
    capability: 'workspace',
    operation: 'creationSearchLinear',
    limits: { ...READ_LIMITS, maxRequestBytes: 4096 }
  },
  {
    capability: 'workspace',
    operation: 'creationSearchBranches',
    limits: { ...READ_LIMITS, maxRequestBytes: 4096 }
  },
  { capability: 'workspace', operation: 'creationResolveRepoSlug', limits: READ_LIMITS },
  { capability: 'workspace', operation: 'creationLookupGitHub', limits: READ_LIMITS },
  {
    capability: 'workspace',
    operation: 'creationLookupGitHubRepo',
    limits: { ...READ_LIMITS, maxRequestBytes: 4096 }
  },
  {
    capability: 'workspace',
    operation: 'creationLookupGitLab',
    limits: { ...READ_LIMITS, maxRequestBytes: 4096 }
  },
  {
    capability: 'workspace',
    operation: 'creationResolvePrBase',
    limits: { ...READ_LIMITS, maxRequestBytes: 4096 }
  },
  {
    capability: 'workspace',
    operation: 'creationResolveMrBase',
    limits: { ...READ_LIMITS, maxRequestBytes: 4096 }
  },
  { capability: 'workspace', operation: 'creationCreateBlank', limits: CREATE_LIMITS },
  { capability: 'workspace', operation: 'creationCreateFromSource', limits: CREATE_LIMITS }
] as const satisfies readonly MobileWebWorkspaceCreationOperationGrant[]
