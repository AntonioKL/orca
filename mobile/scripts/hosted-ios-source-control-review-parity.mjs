import { execFile } from 'node:child_process'
import path from 'node:path'
import { promisify } from 'node:util'
import { dismissEmulatorDeveloperMenuIfPresent } from './emulator-developer-menu-dismissal.mjs'
import {
  tapHostedIosAccessibilityControl,
  waitForHostedIosAccessibilityControl,
  waitForHostedIosAccessibilityControlByLabelPrefix,
  waitForHostedIosAccessibilityControlEndingWith,
  waitForHostedIosAccessibilityControlMatching
} from './hosted-ios-emulator-accessibility.mjs'
import { longPressHostedIosAccessibilityControlByLabelPrefix } from './hosted-ios-emulator-long-press.mjs'
import { assertHostedIosScreenshotParity } from './hosted-ios-screenshot-parity.mjs'
import { readHostedWebViewTextPoint } from './hosted-webview-cdp-session.mjs'

const execFileAsync = promisify(execFile)
const CHANGED_FILE_LABEL_PREFIX = 'Open changed file '

export async function captureNativeSourceControlReviewBaselines({
  deviceUdid,
  emulator,
  expectedWorkspace,
  runtimeDirectory,
  timeoutMs
}) {
  await dismissEmulatorDeveloperMenuIfPresent(emulator)
  await longPressHostedIosAccessibilityControlByLabelPrefix(
    emulator,
    expectedWorkspace,
    timeoutMs,
    undefined,
    'Source Control'
  )
  await tapHostedIosAccessibilityControl(emulator, 'Source Control', timeoutMs)
  const changedFileControl = await waitForHostedIosAccessibilityControlMatching(
    emulator,
    (node) =>
      node.label?.startsWith(CHANGED_FILE_LABEL_PREFIX) ||
      node.value?.startsWith(CHANGED_FILE_LABEL_PREFIX),
    timeoutMs
  )
  const reviewControl = await waitForHostedIosAccessibilityControlMatching(
    emulator,
    (node) =>
      nativePullRequestState(node.label) !== null || nativePullRequestState(node.value) !== null,
    timeoutMs
  )
  await waitForHostedIosAccessibilityControlEndingWith(emulator, ' on branch', timeoutMs)
  const sourceControl = await captureNativeRoute({
    deviceUdid,
    emulator,
    runtimeDirectory,
    screenshotName: 'native-source-control-portrait.png',
    title: 'Source Control',
    timeoutMs
  })
  sourceControl.changedFileLabel = accessibilityControlText(changedFileControl, (value) =>
    value.startsWith(CHANGED_FILE_LABEL_PREFIX)
  )
  sourceControl.pullRequestState =
    nativePullRequestState(reviewControl.label) ?? nativePullRequestState(reviewControl.value)
  await tapHostedIosAccessibilityControl(emulator, sourceControl.changedFileLabel, timeoutMs)
  await waitForHostedIosAccessibilityControl(emulator, 'Open review actions', timeoutMs)
  await waitForHostedIosAccessibilityControlEndingWith(emulator, ' reviewed', timeoutMs)
  const review = await captureNativeRoute({
    deviceUdid,
    emulator,
    runtimeDirectory,
    screenshotName: 'native-review-portrait.png',
    title: 'Changes',
    timeoutMs
  })
  await tapHostedIosAccessibilityControl(emulator, 'Back', timeoutMs)
  await waitForHostedIosAccessibilityControl(emulator, 'Source Control', timeoutMs)
  await tapHostedIosAccessibilityControl(emulator, 'Back to session', timeoutMs)
  await waitForHostedIosAccessibilityControlByLabelPrefix(emulator, expectedWorkspace, timeoutMs)
  return { review, sourceControl }
}

function nativePullRequestState(label) {
  if (label === 'Create pull request') {
    return { kind: 'create', label }
  }
  const number = label?.match(/^Pull request #(\d+),/)?.[1]
  if (number) {
    return { kind: 'ready', label, number }
  }
  if (label?.startsWith('Pull request unavailable:')) {
    return { kind: 'unavailable', label }
  }
  return null
}

function accessibilityControlText(control, matches) {
  for (const value of [control.label, control.value]) {
    if (typeof value === 'string' && matches(value)) {
      return value
    }
  }
  throw new Error('Accessibility control lost its matched text')
}

export async function captureHostedSourceControlReviewScreen({
  deviceUdid,
  document,
  nativeBaseline,
  runtimeDirectory,
  screenshotName,
  title,
  timeoutMs
}) {
  const screenTitlePoint = await readHostedWebViewTextPoint(document, title)
  const screenshot = path.join(runtimeDirectory, screenshotName)
  const deadline = Date.now() + timeoutMs
  let lastError = new Error(`${title} did not reach screenshot parity`)
  while (Date.now() < deadline) {
    await delay(500)
    await captureSimulatorScreenshot(deviceUdid, screenshot)
    try {
      const screenshotParity = await assertHostedIosScreenshotParity({
        hostedLandmark: screenTitlePoint,
        hostedScreenshot: screenshot,
        nativeLandmark: nativeBaseline.screenTitlePoint,
        nativeScreenshot: nativeBaseline.screenshot
      })
      return { screenTitlePoint, screenshot, screenshotParity }
    } catch (error) {
      lastError = error
    }
  }
  throw lastError
}

export function sourceControlReviewParityEvidence(nativeCapture, hostedCapture) {
  return {
    nativeScreenshot: path.basename(nativeCapture.screenshot),
    hostedScreenshot: path.basename(hostedCapture.screenshot),
    nativeScreenTitlePoint: nativeCapture.screenTitlePoint,
    hostedScreenTitlePoint: hostedCapture.screenTitlePoint,
    screenshotParity: hostedCapture.screenshotParity
  }
}

async function captureNativeRoute({
  deviceUdid,
  emulator,
  runtimeDirectory,
  screenshotName,
  title,
  timeoutMs
}) {
  const screenTitlePoint = await waitForHostedIosAccessibilityControl(emulator, title, timeoutMs)
  await delay(500)
  const screenshot = path.join(runtimeDirectory, screenshotName)
  await captureSimulatorScreenshot(deviceUdid, screenshot)
  return { screenTitlePoint, screenshot }
}

async function captureSimulatorScreenshot(deviceUdid, outputPath) {
  await execFileAsync('xcrun', ['simctl', 'io', deviceUdid, 'screenshot', outputPath])
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
