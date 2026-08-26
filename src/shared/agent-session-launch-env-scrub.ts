export function scrubAgentSessionRecordLaunchEnv(value: unknown): {
  value: unknown
  changed: boolean
} {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { value, changed: false }
  }
  const record = value as Record<string, unknown>
  if (!Object.hasOwn(record, 'launchEnv')) {
    return { value, changed: false }
  }
  const { launchEnv: _discarded, ...rest } = record
  return { value: rest, changed: true }
}
