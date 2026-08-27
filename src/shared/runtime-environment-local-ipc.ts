export const RUNTIME_ENVIRONMENT_LOCAL_ID_KEY = '__orcaLocalEnvironmentId'

export type RuntimeEnvironmentLocalIpcMetadata = {
  [RUNTIME_ENVIRONMENT_LOCAL_ID_KEY]?: string
}

export function withRuntimeEnvironmentLocalIpcMetadata<T extends object>(
  value: T,
  environmentId: string
): T & Required<RuntimeEnvironmentLocalIpcMetadata> {
  return { ...value, [RUNTIME_ENVIRONMENT_LOCAL_ID_KEY]: environmentId }
}

export function getRuntimeEnvironmentLocalId(
  value: RuntimeEnvironmentLocalIpcMetadata
): string | undefined {
  const environmentId = value[RUNTIME_ENVIRONMENT_LOCAL_ID_KEY]
  return typeof environmentId === 'string' && environmentId.length > 0 ? environmentId : undefined
}

export function stripRuntimeEnvironmentLocalIpcMetadata<T extends object>(
  value: T & RuntimeEnvironmentLocalIpcMetadata
): T {
  if (!(RUNTIME_ENVIRONMENT_LOCAL_ID_KEY in value)) {
    return value
  }
  const publicValue = { ...value }
  delete publicValue[RUNTIME_ENVIRONMENT_LOCAL_ID_KEY]
  return publicValue
}
