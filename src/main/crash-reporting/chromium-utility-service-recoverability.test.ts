import { describe, expect, it } from 'vitest'
import { isRecoverableChromiumUtilityService } from './chromium-utility-service-recoverability'

describe('isRecoverableChromiumUtilityService', () => {
  it('treats the on-demand services from the 1.4.188 crash batch as recoverable', () => {
    expect(isRecoverableChromiumUtilityService('proxy_resolver.mojom.ProxyResolverFactory')).toBe(
      true
    )
    expect(isRecoverableChromiumUtilityService('printing.mojom.PrintCompositor')).toBe(true)
  })

  it('keeps the previously enumerated services recoverable', () => {
    expect(isRecoverableChromiumUtilityService('audio.mojom.AudioService')).toBe(true)
    expect(isRecoverableChromiumUtilityService('network.mojom.NetworkService')).toBe(true)
    expect(isRecoverableChromiumUtilityService('video_capture.mojom.VideoCaptureService')).toBe(true)
  })

  it('covers Chromium services the allowlist never enumerated', () => {
    expect(isRecoverableChromiumUtilityService('data_decoder.mojom.DataDecoderService')).toBe(true)
    expect(isRecoverableChromiumUtilityService('media.mojom.MediaFoundationService')).toBe(true)
    expect(isRecoverableChromiumUtilityService('tracing.mojom.TracedProcess')).toBe(true)
  })

  it('reports the utility that hosts Orca code and the one holding user data', () => {
    expect(isRecoverableChromiumUtilityService('node.mojom.NodeService')).toBe(false)
    expect(isRecoverableChromiumUtilityService('storage.mojom.StorageService')).toBe(false)
  })

  it('reports a utility whose service name we never observed', () => {
    expect(isRecoverableChromiumUtilityService(undefined)).toBe(false)
    expect(isRecoverableChromiumUtilityService('')).toBe(false)
  })

  it('reports anything that is not a Chromium Mojo service name', () => {
    expect(isRecoverableChromiumUtilityService('com.orca.unexpected')).toBe(false)
    expect(isRecoverableChromiumUtilityService('Orca Helper')).toBe(false)
    expect(isRecoverableChromiumUtilityService('mojom.Thing')).toBe(false)
    expect(isRecoverableChromiumUtilityService('printing.mojom.')).toBe(false)
  })
})
