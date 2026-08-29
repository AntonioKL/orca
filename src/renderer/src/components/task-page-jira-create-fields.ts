import { buildJiraCreateTextAdf } from '@/components/jira-create-adf'
import { buildJiraUserFieldValue } from '../../../shared/jira-user-field-value'
import type { JiraCreateField } from '../../../shared/jira-types'

const JIRA_CREATE_SYSTEM_FIELD_KEYS = new Set(['project', 'issuetype', 'summary', 'description'])

export function isVisibleJiraCreateField(field: JiraCreateField): boolean {
  return field.required && !JIRA_CREATE_SYSTEM_FIELD_KEYS.has(field.key)
}

// Jira returns user fields (reporter, custom user pickers) with no allowedValues,
// so they need a searched picker rather than the option Select or a text box.
export function isJiraUserCreateField(field: JiraCreateField): boolean {
  return field.schema?.type === 'user' || field.schema?.items === 'user'
}

export function getJiraCreateAllowedValueLabel(
  value: NonNullable<JiraCreateField['allowedValues']>[number]
): string {
  return value.name ?? value.value ?? value.id ?? 'Option'
}

export function findJiraCreateAllowedValue(field: JiraCreateField, draftValue: string) {
  return field.allowedValues?.find((value) => {
    return value.id === draftValue || value.value === draftValue || value.name === draftValue
  })
}

export function getJiraCreateOptionPayload(
  value: NonNullable<JiraCreateField['allowedValues']>[number] | undefined,
  fallback: string
): Record<string, string> | string {
  if (value?.id) {
    return { id: value.id }
  }
  if (value?.value) {
    return { value: value.value }
  }
  if (value?.name) {
    return { name: value.name }
  }
  return fallback
}

export function buildJiraCreateFieldValue(field: JiraCreateField, draftValue: string): unknown {
  const trimmed = draftValue.trim()
  if (!trimmed) {
    return undefined
  }
  if (isJiraUserCreateField(field)) {
    if (field.schema?.type === 'array') {
      const users = trimmed
        .split(',')
        .map((part) => buildJiraUserFieldValue(part))
        .filter((user) => user !== undefined)
      return users.length > 0 ? users : undefined
    }
    return buildJiraUserFieldValue(trimmed)
  }
  if (field.schema?.type === 'array') {
    const parts = trimmed
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean)
    if (field.allowedValues?.length) {
      return parts.map((part) =>
        getJiraCreateOptionPayload(findJiraCreateAllowedValue(field, part), part)
      )
    }
    return parts
  }
  if (field.allowedValues?.length) {
    return getJiraCreateOptionPayload(findJiraCreateAllowedValue(field, trimmed), trimmed)
  }
  if (field.schema?.type === 'number') {
    const numberValue = Number(trimmed)
    return Number.isFinite(numberValue) ? numberValue : trimmed
  }
  if (field.schema?.custom?.includes(':textarea') || field.schema?.type === 'textarea') {
    return buildJiraCreateTextAdf(trimmed)
  }
  return trimmed
}

// Names the fields still blank so the dialog can say what is missing instead of
// leaving Create disabled with no explanation.
export function getMissingJiraCreateFieldNames(
  fields: readonly JiraCreateField[],
  values: Record<string, string>
): string[] {
  return fields
    .filter((field) => !(values[field.key] ?? '').trim())
    .map((field) => field.name || field.key)
}

export function buildJiraCreateCustomFields(
  fields: readonly JiraCreateField[],
  values: Record<string, string>
): Record<string, unknown> | undefined {
  const customFields: Record<string, unknown> = {}
  for (const field of fields) {
    const value = buildJiraCreateFieldValue(field, values[field.key] ?? '')
    if (value !== undefined) {
      customFields[field.key] = value
    }
  }
  return Object.keys(customFields).length > 0 ? customFields : undefined
}
