import { randomBytes } from 'node:crypto'
import {
  runHostedIosEmulatorCommand,
  tapHostedIosPoint
} from './hosted-ios-emulator-accessibility.mjs'
import {
  activateHostedWebViewControl,
  evaluateHostedDocumentWithRetry,
  waitForVisibleHostedWebView
} from './hosted-webview-cdp-session.mjs'
import { activateHostedWorkspaceRow } from './hosted-webview-workspace-activation.mjs'

const GESTURE_PROBE_PROPERTY = '__orcaE2eGestureWindowProbe'
// MOBILE_WEB_USER_GESTURE_MAX_AGE_MS is 5000; wait past it so no case inherits the previous one.
const GESTURE_QUIESCENCE_MS = 6_500
const PAGE_TAP_POINT = { x: 0.5, y: 0.6 }
const SCROLL_FRAME_COUNT = 24
const SCROLL_FROM_Y = 0.72
const SCROLL_TO_Y = 0.42

export async function probeHostedIosUserGestureWindow(
  { discoveryUrl, emulator, expectedWorkspace, timeoutMs, workspaceDocument },
  operations = {}
) {
  const evaluate = operations.evaluate ?? evaluateHostedDocumentWithRetry
  const waitForDocument = operations.waitForDocument ?? waitForVisibleHostedWebView
  const activateWorkspace = operations.activateWorkspace ?? activateHostedWorkspaceRow
  const activateControl = operations.activateControl ?? activateHostedWebViewControl
  const tapPoint = operations.tapPoint ?? tapHostedIosPoint
  const runCommand = operations.runCommand ?? runHostedIosEmulatorCommand

  await installGestureProbe(workspaceDocument, evaluate)
  await activateWorkspace(workspaceDocument, expectedWorkspace, activateControl, timeoutMs, () =>
    waitForDocument({ discoveryUrl, expectedText: expectedWorkspace, timeoutMs })
  )
  const sessionDocument = await waitForDocument({
    discoveryUrl,
    expectedText: 'Mobile Emulator',
    expectedHrefIncludes: '/session/',
    timeoutMs
  })
  const geometry = await readViewportGeometry(sessionDocument, evaluate)
  const insetPoint = { x: 0.5, y: geometry.viewportTopRatio / 2 }

  const cases = []
  const record = async (name, action) => {
    cases.push({ name, ...(await runGestureCase(sessionDocument, evaluate, timeoutMs, action)) })
  }

  // Control: no native touch at all, so the window must be closed.
  await record('no-gesture', quiesce)
  // Control: a page-originated DOM touch/click cannot reach the React Native touch responder.
  await record('page-dispatched-touch', async () => {
    await quiesce()
    await dispatchPageTouch(sessionDocument, evaluate)
  })
  // G3a: a native tap that lands on the WKWebView child.
  await record('native-tap-on-webview', async () => {
    await quiesce()
    await tapPoint(emulator, PAGE_TAP_POINT)
  })
  // The same window must not survive the operation that spent it.
  await record('replay-without-new-gesture', () => Promise.resolve())
  // G3b: a pan with no tap, i.e. a scroll.
  await record('native-scroll-on-webview', async () => {
    await quiesce()
    await scrollHostedIosPoint(emulator, runCommand)
  })
  // G3c: a native tap on the shell chrome above the WebView. A zero-height strip means the hosted
  // state leaves no native pixels to tap, which is itself the answer.
  if (geometry.viewportTop >= 2) {
    await record('native-tap-outside-webview', async () => {
      await quiesce()
      await tapPoint(emulator, insetPoint)
    })
  } else {
    cases.push({ name: 'native-tap-outside-webview', skipped: 'no native strip above the WebView' })
  }
  // The window must expire on its own.
  await record('native-tap-then-expiry', async () => {
    await quiesce()
    await tapPoint(emulator, PAGE_TAP_POINT)
    await quiesce()
  })

  return { cases, geometry, insetPoint, sessionDocument }
}

async function runGestureCase(document, evaluate, timeoutMs, action) {
  await action()
  const requestId = randomBytes(16).toString('base64url')
  await postClipboardWriteProbe(document, requestId, evaluate)
  const response = await waitForProbeResponse(document, requestId, timeoutMs, evaluate)
  return {
    error: response?.error?.code ?? null,
    granted: response?.status === 'success',
    status: response?.status ?? 'missing'
  }
}

async function installGestureProbe(document, evaluate) {
  const expression = `(() => {
    const key = ${JSON.stringify(GESTURE_PROBE_PROPERTY)};
    if (globalThis[key]) return JSON.stringify({ started: true });
    const native = globalThis.OrcaNative;
    if (!native || typeof native.postMessage !== 'function') {
      return JSON.stringify({ started: false });
    }
    const state = globalThis[key] = { context: null, responses: Object.create(null) };
    addEventListener('message', (event) => {
      try {
        const message = typeof event.data === 'string' ? JSON.parse(event.data) : null;
        if (message?.type === 'response' && typeof message.requestId === 'string') {
          state.responses[message.requestId] = message;
        }
      } catch {}
    });
    globalThis.OrcaNative = Object.freeze({
      postMessage(value) {
        try {
          const message = JSON.parse(value);
          if (message?.shellSessionId && message?.buildId && Number.isInteger(message.version)) {
            state.context = {
              version: message.version,
              shellSessionId: message.shellSessionId,
              buildId: message.buildId
            };
          }
        } catch {}
        native.postMessage(value);
      }
    });
    return JSON.stringify({ started: true });
  })()`
  const result = JSON.parse(await evaluate(document, expression))
  if (result?.started !== true) {
    throw new Error('Gesture window probe could not observe the hosted bridge')
  }
}

// clipboardWrite is the cheapest gesture-gated mutation: it consumes the window and answers with a
// success or a permission_required error without presenting any UI.
async function postClipboardWriteProbe(document, requestId, evaluate) {
  const expression = `(() => {
    const state = globalThis[${JSON.stringify(GESTURE_PROBE_PROPERTY)}];
    if (!state?.context) return JSON.stringify({ posted: false });
    globalThis.OrcaNative.postMessage(JSON.stringify({
      ...state.context,
      type: 'request',
      mode: 'once',
      requestId: ${JSON.stringify(requestId)},
      capability: 'native',
      operation: 'clipboardWrite',
      payload: { text: 'orca-gesture-window-probe' }
    }));
    return JSON.stringify({ posted: true });
  })()`
  const result = JSON.parse(await evaluate(document, expression))
  if (result?.posted !== true) {
    throw new Error('Gesture window probe did not capture an active bridge context')
  }
}

async function waitForProbeResponse(document, requestId, timeoutMs, evaluate) {
  const deadline = Date.now() + timeoutMs
  const expression = `JSON.stringify(globalThis[${JSON.stringify(
    GESTURE_PROBE_PROPERTY
  )}]?.responses?.[${JSON.stringify(requestId)}] ?? null)`
  while (Date.now() < deadline) {
    const result = JSON.parse(await evaluate(document, expression))
    if (result) {
      return result
    }
    await delay(100)
  }
  throw new Error('Gesture window probe response did not return to the hosted page')
}

// The WebView is bottom-anchored, so screen.height - innerHeight is the native strip above it.
async function readViewportGeometry(document, evaluate) {
  const expression = `JSON.stringify({
    innerHeight: Number(innerHeight),
    screenHeight: Number(screen.height),
    screenWidth: Number(screen.width)
  })`
  const geometry = JSON.parse(await evaluate(document, expression))
  const viewportTop = Math.max(0, geometry.screenHeight - geometry.innerHeight)
  return { ...geometry, viewportTop, viewportTopRatio: viewportTop / geometry.screenHeight }
}

async function dispatchPageTouch(document, evaluate) {
  const expression = `(() => {
    const target = document.elementFromPoint(innerWidth / 2, innerHeight * 0.6) ?? document.body;
    if (!target) return JSON.stringify({ dispatched: false });
    for (const type of ['pointerdown', 'mousedown', 'touchstart', 'click']) {
      target.dispatchEvent(new Event(type, { bubbles: true, cancelable: true }));
    }
    return JSON.stringify({ dispatched: true });
  })()`
  const result = JSON.parse(await evaluate(document, expression))
  if (result?.dispatched !== true) {
    throw new Error('Gesture window probe could not dispatch a page touch')
  }
}

async function scrollHostedIosPoint(emulator, runCommand) {
  const frames = [{ type: 'begin', x: PAGE_TAP_POINT.x, y: SCROLL_FROM_Y }]
  for (let index = 1; index <= SCROLL_FRAME_COUNT; index++) {
    const ratio = index / SCROLL_FRAME_COUNT
    frames.push({
      type: 'move',
      x: PAGE_TAP_POINT.x,
      y: SCROLL_FROM_Y + (SCROLL_TO_Y - SCROLL_FROM_Y) * ratio
    })
  }
  frames.push({ type: 'end', x: PAGE_TAP_POINT.x, y: SCROLL_TO_Y })
  await runCommand(emulator, ['gesture', JSON.stringify(frames)])
}

function quiesce() {
  return delay(GESTURE_QUIESCENCE_MS)
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
