import { useCallback, useRef, useState, type RefObject } from 'react'
import { AlertCircle, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import type { DocPreviewFileFailure } from '../../../../../shared/doc-preview-scheme'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'

function requestedDirectory(relativePath: string): string {
  const separator = relativePath.lastIndexOf('/')
  return separator === -1 ? '.' : relativePath.slice(0, separator)
}

function requestedDirectoryLabel(relativePath: string, worktreeRoot: string | null): string {
  const directory = requestedDirectory(relativePath)
  return directory === '.' && worktreeRoot ? worktreeRoot : directory
}

function reportAuthorizationFailure(): void {
  toast.error(
    translate(
      'auto.components.editor.HtmlDocPreview.directoryAuthorizationFailed',
      'Could not allow access to this directory.'
    )
  )
}

export function useDocPreviewDirectoryAccess({
  grantId,
  reloadRef
}: {
  grantId: string | null
  reloadRef: RefObject<(() => void) | null>
}): {
  request: DocPreviewFileFailure | null
  busy: boolean
  offer: (failure: DocPreviewFileFailure) => void
  reset: () => void
  dismiss: () => void
  allow: () => Promise<void>
} {
  const [request, setRequest] = useState<DocPreviewFileFailure | null>(null)
  const [busy, setBusy] = useState(false)
  const dismissedDirectoriesRef = useRef(new Set<string>())
  const offer = useCallback((failure: DocPreviewFileFailure) => {
    if (!dismissedDirectoriesRef.current.has(requestedDirectory(failure.relativePath))) {
      setRequest((current) => current ?? failure)
    }
  }, [])
  const reset = useCallback(() => {
    setRequest(null)
    setBusy(false)
    dismissedDirectoriesRef.current.clear()
  }, [])
  const dismiss = useCallback(() => {
    if (request) {
      dismissedDirectoriesRef.current.add(requestedDirectory(request.relativePath))
    }
    setRequest(null)
  }, [request])
  const allow = useCallback(async () => {
    if (!request || !grantId || busy) {
      return
    }
    setBusy(true)
    try {
      if (!(await window.api.docPreview.authorizeDirectory(grantId, request.relativePath))) {
        reportAuthorizationFailure()
        return
      }
      setRequest(null)
      reloadRef.current?.()
    } catch {
      reportAuthorizationFailure()
    } finally {
      setBusy(false)
    }
  }, [busy, grantId, reloadRef, request])
  return { request, busy, offer, reset, dismiss, allow }
}

export function DocPreviewDirectoryAccessBanner({
  request,
  busy,
  worktreeRoot,
  onDismiss,
  onAllow
}: {
  request: DocPreviewFileFailure
  busy: boolean
  worktreeRoot: string | null
  onDismiss: () => void
  onAllow: () => Promise<void>
}): React.JSX.Element {
  return (
    <div className="flex shrink-0 items-center gap-2 border-b px-2 py-1 text-xs" role="status">
      <AlertCircle className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 text-muted-foreground">
        {translate(
          'auto.components.editor.HtmlDocPreview.directoryAccessRequest',
          'This preview wants to read files in {{path}}.',
          { path: requestedDirectoryLabel(request.relativePath, worktreeRoot) }
        )}
      </span>
      <Button type="button" variant="ghost" size="xs" disabled={busy} onClick={onDismiss}>
        {translate('auto.components.editor.HtmlDocPreview.dismissAccessRequest', 'Dismiss')}
      </Button>
      <Button type="button" size="xs" disabled={busy} onClick={() => void onAllow()}>
        {busy ? <Loader2 className="size-3 animate-spin" /> : null}
        {/* "folder", not "once": approval covers the whole directory for as long as this preview stays open */}
        {translate('auto.components.editor.HtmlDocPreview.allowDirectory', 'Allow folder')}
      </Button>
    </div>
  )
}
