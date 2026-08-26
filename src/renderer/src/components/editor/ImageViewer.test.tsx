import { beforeEach, describe, expect, it, vi } from 'vitest'

const reactHookRuntime = vi.hoisted(() => ({
  states: [] as unknown[],
  index: 0
}))

vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react') // eslint-disable-line @typescript-eslint/consistent-type-imports -- vi.importActual requires inline import()
  return {
    ...actual,
    useMemo<T>(factory: () => T) {
      return factory()
    },
    useCallback<T extends (...args: never[]) => unknown>(callback: T) {
      return callback
    },
    useEffect() {
      return undefined
    },
    useRef<T>(initial: T) {
      return { current: initial }
    },
    useState<T>(initial: T | (() => T)) {
      const stateIndex = reactHookRuntime.index++
      if (!(stateIndex in reactHookRuntime.states)) {
        reactHookRuntime.states[stateIndex] =
          typeof initial === 'function' ? (initial as () => T)() : initial
      }
      const setState = (next: T | ((previous: T) => T)): void => {
        reactHookRuntime.states[stateIndex] =
          typeof next === 'function'
            ? (next as (previous: T) => T)(reactHookRuntime.states[stateIndex] as T)
            : next
      }
      return [reactHookRuntime.states[stateIndex] as T, setState] as const
    }
  }
})

vi.mock('lucide-react', () => ({
  Image: function Image(props: Record<string, unknown>) {
    return { type: 'Image', props }
  },
  RotateCcw: function RotateCcw(props: Record<string, unknown>) {
    return { type: 'RotateCcw', props }
  },
  X: function X(props: Record<string, unknown>) {
    return { type: 'X', props }
  },
  ZoomIn: function ZoomIn(props: Record<string, unknown>) {
    return { type: 'ZoomIn', props }
  },
  ZoomOut: function ZoomOut(props: Record<string, unknown>) {
    return { type: 'ZoomOut', props }
  }
}))

vi.mock('@/components/ui/dialog', () => ({
  Dialog: function Dialog(props: { children?: unknown }) {
    return { type: 'Dialog', props }
  },
  DialogContent: function DialogContent(props: { children?: unknown }) {
    return { type: 'DialogContent', props }
  },
  DialogDescription: function DialogDescription(props: { children?: unknown }) {
    return { type: 'DialogDescription', props }
  },
  DialogTitle: function DialogTitle(props: { children?: unknown }) {
    return { type: 'DialogTitle', props }
  }
}))

vi.mock('./PdfViewer', () => ({
  default: function PdfViewer(props: Record<string, unknown>) {
    return { type: 'PdfViewer', props }
  }
}))

type ReactElementLike = {
  type: unknown
  props: Record<string, unknown>
}

function expandNode(node: unknown): unknown {
  if (node == null || typeof node === 'string' || typeof node === 'number') {
    return node
  }
  if (Array.isArray(node)) {
    return node.map(expandNode)
  }
  const el = node as ReactElementLike
  if (typeof el.type === 'function') {
    return expandNode(el.type(el.props))
  }
  return {
    ...el,
    props: {
      ...el.props,
      children: expandNode(el.props?.children)
    }
  }
}

function findElementsByType(node: unknown, typeName: string): ReactElementLike[] {
  const results: ReactElementLike[] = []
  const visit = (current: unknown): void => {
    if (current == null || typeof current === 'string' || typeof current === 'number') {
      return
    }
    if (Array.isArray(current)) {
      for (const child of current) {
        visit(child)
      }
      return
    }
    const el = current as ReactElementLike
    if (el.type === typeName) {
      results.push(el)
    }
    visit(el.props?.children)
  }
  visit(node)
  return results
}

function findPreviewImage(node: unknown): ReactElementLike {
  const image = findElementsByType(node, 'img').find((element) => element.props.onError)
  if (!image) {
    throw new Error('preview image not found')
  }
  return image
}

function findSurfaceRefs(node: unknown): ((surface: unknown) => void)[] {
  return findElementsByType(node, 'div')
    .map((element) => element.props.ref)
    .filter((ref): ref is (surface: unknown) => void => typeof ref === 'function')
}

function attachSurface(
  setSurfaceRef: (surface: unknown) => void,
  clientWidth: number,
  clientHeight: number
): void {
  setSurfaceRef({ clientWidth, clientHeight, addEventListener() {}, removeEventListener() {} })
}

async function renderExpandedImageViewer(
  content: string,
  mimeType = 'image/png'
): Promise<unknown> {
  reactHookRuntime.index = 0
  const module = await import('./ImageViewer')
  return expandNode(
    module.default({
      content,
      filePath: '/repo/preview.png',
      mimeType
    })
  )
}

const SVG_BASE64 = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" />').toString('base64')

function pngBase64(width: number): string {
  const bytes = Buffer.alloc(41)
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes)
  bytes.writeUInt32BE(13, 8)
  bytes.write('IHDR', 12, 'ascii')
  bytes.writeUInt32BE(width, 16)
  bytes.writeUInt32BE(1, 20)
  bytes.write('IDAT', 37, 'ascii')
  return bytes.toString('base64')
}

/** A landscape JPEG frame whose EXIF orientation makes a browser render it portrait. */
function rotatedJpegBase64(width: number, height: number): string {
  const tiff = Buffer.alloc(26)
  tiff.write('MM', 0, 'ascii')
  tiff.writeUInt16BE(42, 2)
  tiff.writeUInt32BE(8, 4)
  tiff.writeUInt16BE(1, 8)
  tiff.writeUInt16BE(0x0112, 10)
  tiff.writeUInt16BE(3, 12)
  tiff.writeUInt32BE(1, 14)
  tiff.writeUInt16BE(6, 18)
  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff])
  const app1 = Buffer.alloc(4)
  app1.writeUInt16BE(0xffe1)
  app1.writeUInt16BE(payload.byteLength + 2, 2)
  const sof = Buffer.alloc(11)
  sof.writeUInt16BE(0xffc0)
  sof.writeUInt16BE(8, 2)
  sof[4] = 8
  sof.writeUInt16BE(height, 5)
  sof.writeUInt16BE(width, 7)
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app1, payload, sof]).toString('base64')
}

async function renderPdfViewerProps(
  scrollCacheKey?: string | null
): Promise<Record<string, unknown>> {
  reactHookRuntime.index = 0
  const module = await import('./ImageViewer')
  const rendered = expandNode(
    module.default({
      content: 'JVBERi0xLjQK',
      filePath: '/repo/report.pdf',
      mimeType: 'application/pdf',
      ...(scrollCacheKey === undefined ? {} : { scrollCacheKey })
    })
  )
  const [pdf] = findElementsByType(rendered, 'PdfViewer')
  if (!pdf) {
    throw new Error('PdfViewer not rendered')
  }
  return pdf.props
}

describe('ImageViewer PDF scroll cache key', () => {
  beforeEach(() => {
    reactHookRuntime.states = []
    reactHookRuntime.index = 0
    vi.clearAllMocks()
  })

  // Why: nothing else pins the wiring, so a dropped prop anywhere between
  // EditorContent and PdfViewer would ship as silently amnesiac scrolling.
  it('forwards the scroll cache key to PdfViewer', async () => {
    expect(await renderPdfViewerProps('/repo/report.pdf::tab-2:pdf')).toMatchObject({
      filePath: '/repo/report.pdf',
      scrollCacheKey: '/repo/report.pdf::tab-2:pdf'
    })
  })

  it('passes null when no key is supplied, so unkeyed callers stay opted out', async () => {
    expect((await renderPdfViewerProps()).scrollCacheKey).toBeNull()
  })

  it('passes an explicit null through unchanged', async () => {
    expect((await renderPdfViewerProps(null)).scrollCacheKey).toBeNull()
  })
})

describe('ImageViewer preview source retry', () => {
  beforeEach(() => {
    reactHookRuntime.states = []
    reactHookRuntime.index = 0
    vi.clearAllMocks()
  })

  it('retries an earlier failed source after a later source loads successfully', async () => {
    const failedContent = pngBase64(1)
    const loadedContent = pngBase64(2)

    const firstRender = await renderExpandedImageViewer(failedContent)
    const firstImage = findPreviewImage(firstRender)
    expect(firstImage.props.src).toBe(`data:image/png;base64,${failedContent}`)

    ;(firstImage.props.onError as () => void)()
    const failedRender = await renderExpandedImageViewer(failedContent)
    expect(findElementsByType(failedRender, 'Image')).toHaveLength(1)
    expect(findElementsByType(failedRender, 'img')).toHaveLength(0)

    const loadedRender = await renderExpandedImageViewer(loadedContent)
    const loadedImage = findPreviewImage(loadedRender)
    ;(
      loadedImage.props.onLoad as (event: {
        currentTarget: { naturalWidth: number; naturalHeight: number }
      }) => void
    )({ currentTarget: { naturalWidth: 12, naturalHeight: 10 } })

    const retryRender = await renderExpandedImageViewer(failedContent)
    const retryImage = findPreviewImage(retryRender)
    expect(retryImage.props.src).toBe(`data:image/png;base64,${failedContent}`)
  })

  it('shows a failure instead of loading an unsafe raster forever', async () => {
    const rendered = await renderExpandedImageViewer(pngBase64(32_769))

    expect(findElementsByType(rendered, 'Image')).toHaveLength(1)
    expect(findElementsByType(rendered, 'img')).toHaveLength(0)
  })
})

describe('ImageViewer pre-load layout box', () => {
  beforeEach(() => {
    reactHookRuntime.states = []
    reactHookRuntime.index = 0
    vi.clearAllMocks()
  })

  // Why: the natural size is already in the base64 header, so a raster preview gets its exact
  // fit box on the first render instead of a heuristic cap that onLoad then relays out.
  it('sizes a raster preview from its header dimensions before onLoad', async () => {
    const first = await renderExpandedImageViewer(pngBase64(4))
    attachSurface(findSurfaceRefs(first)[0], 700, 800)

    const rendered = await renderExpandedImageViewer(pngBase64(4))
    const image = findPreviewImage(rendered)

    expect(image.props.className).toBe('object-contain block h-full w-full')
    expect(image.props.style).toBeUndefined()
    expect(
      findElementsByType(rendered, 'div').some((element) => {
        const style = element.props.style as { width?: string; height?: string } | undefined
        return style?.width === '4px' && style?.height === '1px'
      })
    ).toBe(true)
  })

  // Why: Chromium applies EXIF orientation to naturalWidth/naturalHeight, so a portrait phone
  // photo stored landscape must get its portrait box now — otherwise onLoad transposes it.
  it('fits the pre-load box to the EXIF-rotated axes, not the stored ones', async () => {
    const content = rotatedJpegBase64(4032, 3024)
    const first = await renderExpandedImageViewer(content, 'image/jpeg')
    attachSurface(findSurfaceRefs(first)[0], 700, 800)

    const rendered = await renderExpandedImageViewer(content, 'image/jpeg')

    expect(
      findElementsByType(rendered, 'div').some((element) => {
        const style = element.props.style as { width?: string; height?: string } | undefined
        return style?.width === '576px' && style?.height === '768px'
      })
    ).toBe(true)
  })

  // Why: before onLoad an unparsed mime has no natural size, and the surface's `w-max`/`h-max`
  // inner box makes percentage maxes resolve to `none` — so an uncapped image lays out and
  // rasters at full natural resolution. The surface itself is already measured, and in a
  // split pane it is a fraction of the viewport, so the cap has to come from it.
  it('caps an unmeasurable preview with the measured surface box before the image loads', async () => {
    const first = await renderExpandedImageViewer(SVG_BASE64, 'image/svg+xml')
    attachSurface(findSurfaceRefs(first)[0], 700, 800)

    const rendered = await renderExpandedImageViewer(SVG_BASE64, 'image/svg+xml')
    const image = findPreviewImage(rendered)

    expect(image.props.className).toBe('object-contain block')
    expect(image.props.style).toEqual({ maxWidth: '668px', maxHeight: '768px' })
  })

  it('caps the full-size popup preview from its own surface, not the viewport', async () => {
    const first = await renderExpandedImageViewer(SVG_BASE64, 'image/svg+xml')
    attachSurface(findSurfaceRefs(first)[1], 1200, 900)

    const rendered = await renderExpandedImageViewer(SVG_BASE64, 'image/svg+xml')
    const popupImage = findElementsByType(rendered, 'img').find((element) => !element.props.onError)

    expect(popupImage?.props.className).toBe('object-contain block')
    expect(popupImage?.props.style).toEqual({ maxWidth: '1168px', maxHeight: '868px' })
  })

  // Why: a surface the user dragged to 30px was measured — the viewport is not a bound it implies.
  it('caps an unmeasurable preview at a surface too short for its own padding', async () => {
    const first = await renderExpandedImageViewer(SVG_BASE64, 'image/svg+xml')
    attachSurface(findSurfaceRefs(first)[0], 700, 30)

    const rendered = await renderExpandedImageViewer(SVG_BASE64, 'image/svg+xml')
    const image = findPreviewImage(rendered)

    expect(image.props.className).toBe('object-contain block')
    expect(image.props.style).toEqual({ maxWidth: '668px', maxHeight: '30px' })
  })

  // Why: an unmeasured surface is not an unbounded one.
  it('falls back to viewport lengths while no surface has been measured', async () => {
    const rendered = await renderExpandedImageViewer(SVG_BASE64, 'image/svg+xml')

    expect(findPreviewImage(rendered).props.className).toBe(
      'object-contain block max-h-[100vh] max-w-[100vw]'
    )
  })
})
