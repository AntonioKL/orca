/**
 * Point node-gyp at the headers the host's Node install already ships, so compiling node-pty
 * needs nothing from nodejs.org.
 *
 * Why: node-pty has no Linux prebuild, so every Linux relay compiles it, and node-gyp's default
 * is to download `node-v<ver>-headers.tar.gz` before configuring. Every official Node build, and
 * every version manager that unpacks one (nvm, fnm, volta, mise, n), already has those exact
 * headers at `<prefix>/include/node`. The download was the only step that needed the internet,
 * so a firewalled host failed with ECONNREFUSED on work that never had to happen (STA-6674).
 *
 * Why both variables: node-gyp >= 11.4 prefers `npm_package_config_node_gyp_<key>` and npm 11+
 * warns that arbitrary `npm_config_<key>` is deprecated, but node-gyp 10 (bundled with Node 20)
 * reads only `npm_config_<key>`. Both together cover every Node the relay runs on.
 *
 * Why the version check: node-gyp trusts `nodedir` blindly. A distro `/usr/include/node` left by
 * an older headers package would compile a binding for the wrong ABI, which loads and crashes
 * instead of failing at install. A mismatch leaves the variables unset, which is today's path.
 */
import { shellEscape } from './ssh-connection-utils'

/** Shell variable the probe answers into; namespaced so it cannot collide with npm's own. */
const NODEDIR_SHELL_VAR = 'ORCA_NODE_HEADERS_DIR'

/**
 * Prints the running Node's install prefix when `<prefix>/include/node/node_version.h` matches
 * `process.versions.node`, and nothing otherwise. `process.execPath` is symlink-resolved, so a
 * `/usr/bin/node` -> `/opt/node/bin/node` shim still finds `/opt/node/include`.
 */
export const LOCAL_NODE_HEADERS_PROBE_JS = [
  'const p=require("path"),f=require("fs");',
  'const d=p.dirname(p.dirname(process.execPath));',
  'try{',
  'const h=f.readFileSync(p.join(d,"include","node","node_version.h"),"utf8");',
  'const v=["MAJOR","MINOR","PATCH"].map(k=>(h.match(new RegExp("#define NODE_"+k+"_VERSION ([0-9]+)"))||[])[1]).join(".");',
  'if(v===process.versions.node)process.stdout.write(d)',
  '}catch{}'
].join('')

/**
 * Stdout marker naming what the probe found, printed before the compile so the answer is in the
 * captured output of any failure that follows. `none` means no matching local headers.
 */
export const LOCAL_NODE_HEADERS_MARKER_PREFIX = 'ORCA-NODE-HEADERS:'

/**
 * POSIX-sh prefix (`...; `) that exports node-gyp's `nodedir` for the rest of the command line
 * when the host's Node ships matching headers. Prepend to any command that may compile node-pty:
 * `npm install`, `npm rebuild`, and the cloexec patch (its `npm rebuild` inherits the env).
 */
export function exportLocalNodeHeadersPrefix(nodePath: string): string {
  const probe = `${shellEscape(nodePath)} -e ${shellEscape(LOCAL_NODE_HEADERS_PROBE_JS)} 2>/dev/null`
  return (
    `${NODEDIR_SHELL_VAR}=$(${probe}); ` +
    `if [ -n "$${NODEDIR_SHELL_VAR}" ]; then ` +
    `export npm_config_nodedir="$${NODEDIR_SHELL_VAR}" npm_package_config_node_gyp_nodedir="$${NODEDIR_SHELL_VAR}"; ` +
    `fi; ` +
    `echo "${LOCAL_NODE_HEADERS_MARKER_PREFIX}\${${NODEDIR_SHELL_VAR}:-none}"; `
  )
}

/**
 * The headers dir the prefix exported, `null` when it found none, or `undefined` when the
 * marker is absent (output truncated, or the command never reached the prefix).
 */
export function localNodeHeadersFromOutput(output: string): string | null | undefined {
  // Why not line-anchored: a failed exec's message prepends `Command "..." failed (exit N): ` to
  // the first output line, and the marker is that line.
  for (const line of output.split(/\r?\n/)) {
    const at = line.indexOf(LOCAL_NODE_HEADERS_MARKER_PREFIX)
    if (at === -1) {
      continue
    }
    const dir = line.slice(at + LOCAL_NODE_HEADERS_MARKER_PREFIX.length).trim()
    return dir === 'none' || dir === '' ? null : dir
  }
  return undefined
}
