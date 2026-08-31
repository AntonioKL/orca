import { describe, expect, it } from 'vitest'
import { linearWorkspaceScopeSignature, type LinearConnectionStatus } from './workspace-types'

describe('linearWorkspaceScopeSignature', () => {
  it('ignores status metadata and workspace ordering', () => {
    const first: LinearConnectionStatus = {
      connected: true,
      viewer: { displayName: 'Ada', email: 'ada@example.com', organizationName: 'Alpha' },
      selectedWorkspaceId: 'workspace-1',
      workspaces: [
        {
          id: 'workspace-1',
          organizationId: 'org-1',
          organizationName: 'Alpha',
          displayName: 'Ada',
          email: 'ada@example.com'
        },
        {
          id: 'workspace-2',
          organizationId: 'org-2',
          organizationName: 'Beta',
          displayName: 'Ada',
          email: 'ada@example.com'
        }
      ]
    }
    const second: LinearConnectionStatus = {
      ...first,
      viewer: { ...first.viewer!, organizationName: 'Renamed' },
      workspaces: [
        { ...first.workspaces![1], organizationName: 'Renamed Beta' },
        { ...first.workspaces![0], organizationName: 'Renamed Alpha' }
      ]
    }

    expect(linearWorkspaceScopeSignature(second)).toBe(linearWorkspaceScopeSignature(first))
  })

  it('changes when the selected workspace changes', () => {
    const first: LinearConnectionStatus = {
      connected: true,
      viewer: null,
      selectedWorkspaceId: 'workspace-1'
    }
    const second = { ...first, selectedWorkspaceId: 'workspace-2' }

    expect(linearWorkspaceScopeSignature(second)).not.toBe(linearWorkspaceScopeSignature(first))
  })
})
