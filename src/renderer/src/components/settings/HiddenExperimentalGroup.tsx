import { useState } from 'react'
import { Label } from '../ui/label'
import { Switch } from '../ui/switch'
import {
  isTerminalRenderDesyncSentinelArmed,
  setTerminalRenderDesyncSentinelArmed
} from '../terminal-pane/terminal-render-desync-trigger'
import { translate } from '@/i18n/i18n'

// Why: anything in this group is deliberately unfinished or staff-only. The
// orange treatment (header tint, label colors) is the shared visual signal
// for hidden-experimental items so future entries inherit the same
// affordance without another round of styling decisions.
export function HiddenExperimentalGroup(): React.JSX.Element {
  const [renderDiagnosticsArmed, setRenderDiagnosticsArmed] = useState(
    isTerminalRenderDesyncSentinelArmed
  )
  const onRenderDiagnosticsChange = (armed: boolean): void => {
    setTerminalRenderDesyncSentinelArmed(armed)
    setRenderDiagnosticsArmed(armed)
  }
  return (
    <section className="space-y-3 rounded-lg border border-orange-500/40 bg-orange-500/5 p-3">
      <div className="space-y-0.5">
        <h4 className="text-sm font-semibold text-orange-500 dark:text-orange-300">
          {translate(
            'auto.components.settings.HiddenExperimentalGroup.3e9e827ca5',
            'Hidden experimental'
          )}
        </h4>
        <p className="text-xs text-orange-500/80 dark:text-orange-300/80">
          {translate(
            'auto.components.settings.HiddenExperimentalGroup.232cf83de8',
            'Unlisted toggles for internal testing. Nothing here is supported.'
          )}
        </p>
      </div>

      <div className="flex items-start justify-between gap-4 rounded-md border border-orange-500/30 bg-orange-500/10 px-3 py-2.5">
        <div className="min-w-0 shrink space-y-0.5">
          <Label className="text-orange-600 dark:text-orange-300">
            {translate(
              'auto.components.settings.HiddenExperimentalGroup.b09f24a51d',
              'Terminal render diagnostics'
            )}
          </Label>
          <p className="text-xs text-orange-600/80 dark:text-orange-300/80">
            {translate(
              'auto.components.settings.HiddenExperimentalGroup.7c4e18d2f6',
              'Arms the bold-glitch capture gestures on this machine: Cmd/Ctrl-click a terminal starts a sampling burst; add Shift to capture pane evidence to disk.'
            )}
          </p>
        </div>
        <Switch
          aria-label={translate(
            'auto.components.settings.HiddenExperimentalGroup.b09f24a51d',
            'Terminal render diagnostics'
          )}
          checked={renderDiagnosticsArmed}
          className="border-orange-500/40 data-[state=unchecked]:bg-orange-500/20"
          onCheckedChange={onRenderDiagnosticsChange}
          thumbClassName="data-[state=unchecked]:bg-orange-200 dark:data-[state=unchecked]:bg-orange-100"
        />
      </div>
    </section>
  )
}
