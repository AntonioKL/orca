import { Loader2, RotateCw } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { Button } from '../ui/button'

/**
 * The Advanced pane's inline "this only takes effect at startup" strip.
 *
 * Shared because both settings that need a relaunch — HTTP/1.1 compatibility and Safe Graphics
 * Mode — render the same reason-plus-Restart affordance, and a second copy would drift.
 */
export function SettingsRestartPrompt({
  title,
  description,
  onRestart,
  restarting,
  children
}: {
  title: string
  description: string
  onRestart: () => void
  restarting: boolean
  /** Actions rendered before Restart, e.g. a Cancel that withdraws a still-pending change. */
  children?: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="flex items-center justify-between gap-3 rounded-md border border-border/50 bg-muted/30 px-3 py-2">
      <div className="min-w-0">
        <p className="text-xs font-medium">{title}</p>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {children}
        <Button
          variant="outline"
          size="sm"
          onClick={onRestart}
          disabled={restarting}
          className="gap-1.5"
        >
          {restarting ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <RotateCw className="size-3.5" />
          )}
          {translate('auto.components.settings.SettingsRestartPrompt.restart', 'Restart')}
        </Button>
      </div>
    </div>
  )
}
