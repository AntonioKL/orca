import { formatFlagHelp } from './help'

// Per-command overrides of the shared flag help; falls back to the generic text.
export function formatCommandFlagHelp(flag: string, commandPath: string[]): string {
  const command = commandPath.join(' ')
  if (command === 'skills install' && flag === 'agent') {
    return '--agent <names>        Comma-separated install targets; default is detected agents'
  }
  if (command === 'terminal close' && flag === 'tab') {
    return '--tab                  Close the whole tab and wait for durable persistence'
  }
  if (command === 'linear issue' && flag === 'id') {
    return '--id <id>             Linear issue key, id, or URL'
  }
  if (command === 'linear issue' && flag === 'workspace') {
    return '--workspace <id>      Connected Linear workspace id'
  }
  if (command === 'linear search' && flag === 'query') {
    return '--query <text>        Text to search across Linear issues'
  }
  if (command === 'linear search' && flag === 'workspace') {
    return '--workspace <id|all>  Connected Linear workspace id, or all'
  }
  if (command === 'linear search' && flag === 'limit') {
    return '--limit <n>            Top matches to return, capped at 50; output reports totalCount'
  }
  if (command === 'linear list-issues' && flag === 'cursor') {
    return '--cursor <cursor>      Opaque cursor from a previous list-issues page; issued cursors bind the workspace, raw Linear cursors need --workspace'
  }
  if (command === 'linear list-issues' && flag === 'priority') {
    return '--priority <0-4>       0=none, 1=urgent, 2=high, 3=medium, 4=low'
  }
  if (command === 'linear list-issues' && flag === 'limit') {
    return '--limit <n>            Max issues to return; omit to return every match'
  }
  if (command === 'linear list' && flag === 'limit') {
    return '--limit <n>            Max issues to return; omit to walk pages until exhaustion or a safety backstop'
  }
  if (command === 'linear project list' && flag === 'limit') {
    return '--limit <n>            Max projects to return; omit to walk pages until exhaustion or a safety backstop'
  }
  if (command === 'artifacts list' && flag === 'cursor') {
    return '--cursor <cursor>      Opaque cursor returned by a previous artifacts page'
  }
  if (command === 'orchestration worker-read' && flag === 'cursor') {
    return '--cursor <cursor>      Opaque cursor returned by a previous worker-read page'
  }
  if (command === 'orchestration worker-list' && flag === 'terminal-state') {
    return '--terminal-state <state> Terminal accounting filter: active, reclaimable, retained, release_pending, release_unknown, or released'
  }
  if (
    ['linear list-issues', 'linear list', 'linear project list'].includes(command) &&
    flag === 'workspace'
  ) {
    return '--workspace <id|all>  Connected Linear workspace id, or all'
  }
  if (command.startsWith('linear ') && flag === 'workspace') {
    return '--workspace <id>      Connected Linear workspace id'
  }
  if (command.startsWith('linear ') && flag === 'body') {
    return '--body <text>         Linear comment or issue body'
  }
  if (command.startsWith('linear ') && flag === 'body-file') {
    return '--body-file <path|->  Read Linear body from a file or stdin'
  }
  if (command.startsWith('linear ') && flag === 'write-id') {
    return '--write-id <uuid>     Retry id from linear_write_unconfirmed'
  }
  if (command.startsWith('linear ') && flag === 'to') {
    return '--to <state>          Exact Linear workflow state name'
  }
  if (command === 'linear comment add' && flag === 'reply-to') {
    return '--reply-to <id>       Comment id to reply to'
  }
  if (command === 'linear attach' && flag === 'url') {
    return '--url <url>           Absolute http(s) link to attach'
  }
  if (command === 'linear attach' && flag === 'title') {
    return '--title <text>        Attachment title'
  }
  if (command === 'linear create' && flag === 'title') {
    return '--title <text>        New Linear issue title'
  }
  if (command === 'linear create' && flag === 'team') {
    return '--team <key>          Linear team key'
  }
  if (command === 'linear create' && flag === 'parent') {
    return '--parent <id>         Parent Linear issue key, id, or URL'
  }
  if (command === 'linear create' && flag === 'parent-current') {
    return '--parent-current      Use the current linked issue as parent'
  }
  if (command === 'worktree create' && flag === 'parent-worktree') {
    return '--parent-worktree <selector> Parent selector such as identity:<identity>, active/current, id:<repo-id>::<path>, branch:<branch>, issue:<number>, path:<path>, folder:<id>, or worktree:<worktreeId>'
  }
  if (command === 'orchestration task-create' && flag === 'task-title') {
    return '--task-title <text>  Concise title for the orchestration task'
  }
  if (command === 'orchestration task-create' && flag === 'display-name') {
    return '--display-name <text> UI label shown for dispatched worker rows'
  }
  // Why: the shared --agent help describes launching a TUI agent in a terminal,
  // which is the wrong meaning here — this selects the account provider.
  if (command === 'account add' && flag === 'agent') {
    return '--agent <id>           Account provider: claude or codex (default claude)'
  }
  if (flag === 'key' && command === 'computer hotkey') {
    return '--key <key-combo>      Modifier chord with one key, e.g. CmdOrCtrl+A'
  }
  if (flag === 'key' && command === 'computer press-key') {
    return '--key <key>            Single key, e.g. Return, Escape, Tab, Left, or PageUp'
  }
  return formatFlagHelp(flag)
}
