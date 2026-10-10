/**
 * DOM 截图（复制为图片）。
 *
 * 为什么不用 html2canvas：那是 200KB 级的额外依赖，而本项目是纯静态站点，
 * 截图只用于「把题干和选项复制成图片」。这里用浏览器原生的
 * `<svg><foreignObject>` 序列化 + canvas 编码实现，零依赖。
 *
 * 三条硬约束决定了实现方式：
 * 1. foreignObject 里的文档不会去加载外部资源，所有 `<img>` 必须先转成 data URL，
 *    否则截图中图片是裂图（`inlineImages`）。
 * 2. 该文档同样不套用宿主页面的样式表，必须把当前页面的 CSS 一起塞进 SVG（`stylesheetText`），
 *    否则 KaTeX 公式、表格、选项边框和圆角全部丢失。
 * 3. 该文档没有可见视口，`vw`/`vh`/`%` 高度会塌成 0，所以根节点要固定成截图的像素尺寸
 *    （`buildSvg` 写入 width/height 与 100% 的高宽）。
 *
 * 另有一条踩过的坑（曾导致截图为纯白）：承载内容的临时宿主是**连位置一起**被序列化的。
 * 早期实现把宿主停在 `left:-100000px` 以免用户看见，结果内容在 SVG 里也画到了
 * 画布外 10 万像素处，导出的 PNG 一片空白；而 `visibility:hidden` / `opacity:0` /
 * `clip-path:inset(100%)` 同样会把整棵子树栅格化成透明。因此宿主必须在坐标原点、
 * 且不能带任何隐藏类样式，只能靠 `z-index:-1` 垫在页面不透明根元素之下（`HOST_CSS`）。
 */

/** 截图倍率：2 倍在 Retina 与普通屏上都足够清晰，体积又不至于过大 */
const SCALE = 2

/** SVG 命名空间 */
const SVG_NS = 'http://www.w3.org/2000/svg'

/** 视为「透明」的背景色，用于判断是否需要在截图里补白底 */
const TRANSPARENT = new Set(['rgba(0, 0, 0, 0)', 'transparent', ''])

/**
 * 承载克隆内容的临时宿主的定位方式（会被一并序列化进 SVG，见文件头第 4 条）。
 *
 * 必须停在坐标系原点：`left:-100000px` 这类「移到屏幕外」的写法会让内容在 SVG 里
 * 也画到画布之外，导出结果是纯白图。也不能用 visibility/opacity/clip-path 隐藏，
 * 它们会把整棵子树栅格化成透明。
 *
 * 唯一可用的遮掩手段是 `z-index:-1`：宿主被垫到页面不透明根元素（`.quiz-page`）之下，
 * 用户看不见，而 foreignObject 只认几何与绘制属性，照旧把它画出来。
 */
const HOST_CSS =
  'position:absolute;top:0;left:0;z-index:-1;pointer-events:none;box-sizing:border-box;'

/**
 * 逐个内联计算样式。
 *
 * 之所以不用「把所有 CSS 规则塞进一个 style 标签」：规则里带后代选择器与 CSS 变量，
 * 依赖宿主文档的上下文，容易在 foreignObject 里失配。逐元素取最终计算值最稳，
 * 而且自带「所见即所得」——高亮的选中项、绿色/红色的答案态都会原样保留。
 * 尺寸相关的属性不内联，让 flex 在 foreignObject 里照常参与排版。
 */
const COPIED_STYLE_PROPS = [
  'alignItems', 'background', 'backgroundAttachment', 'backgroundColor', 'backgroundImage',
  'backgroundPosition', 'backgroundRepeat', 'backgroundSize', 'border', 'borderBottom',
  'borderBottomColor', 'borderBottomLeftRadius', 'borderBottomRightRadius', 'borderBottomStyle',
  'borderBottomWidth', 'borderCollapse', 'borderColor', 'borderLeft', 'borderLeftColor',
  'borderLeftStyle', 'borderLeftWidth', 'borderRadius', 'borderRight', 'borderRightColor',
  'borderRightStyle', 'borderRightWidth', 'borderSpacing', 'borderStyle', 'borderTop',
  'borderTopColor', 'borderTopLeftRadius', 'borderTopRightRadius', 'borderTopStyle',
  'borderTopWidth', 'borderWidth', 'boxSizing', 'captionSide', 'color', 'flexDirection',
  'flexWrap', 'fontFamily', 'fontSize', 'fontStyle', 'fontVariant', 'fontWeight', 'justifyContent',
  'letterSpacing', 'lineHeight', 'listStylePosition', 'listStyleType', 'margin', 'marginBottom',
  'marginLeft', 'marginRight', 'marginTop', 'opacity', 'overflowWrap', 'padding', 'paddingBottom',
  'paddingLeft', 'paddingRight', 'paddingTop', 'textAlign', 'textDecoration', 'textIndent',
  'textTransform', 'verticalAlign', 'visibility', 'whiteSpace', 'wordBreak'
] as const

/** 把计算样式抄到克隆节点上 */
function inlineComputedStyle(source: Element, clone: Element): void {
  if (!(clone instanceof HTMLElement)) return
  if (!(source instanceof HTMLElement)) return
  const cs = window.getComputedStyle(source)
  let cssText = ''
  for (const prop of COPIED_STYLE_PROPS) {
    const kebab = prop.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)
    const value = cs.getPropertyValue(kebab)
    if (value) cssText += `${kebab}:${value};`
  }
  // display 不抄会退化成 block：选项行的 flex 布局、圆形 key 的居中全部失效
  cssText += `display:${cs.getPropertyValue('display')};`
  // flex 简写的计算值可能是 none，需换算成合法的 flex 值
  const flex = cs.getPropertyValue('flex')
  if (flex && flex !== 'none') cssText += `flex:${flex};`
  else if (cs.getPropertyValue('flex-grow') === '0' && cs.getPropertyValue('flex-shrink') === '0') {
    cssText += 'flex:0 0 auto;'
  }
  // 伪元素（::before/::after）这里取不到计算值，只能依赖随样式表一起进 SVG 的规则来还原。
  // 本项目的题干与选项不使用 ::before 装饰，因此不影响截图效果。
  clone.setAttribute('style', cssText)
}

/** 递归克隆并内联样式；返回内联后的根节点 */
function cloneWithStyles(source: Element): HTMLElement {
  const clone = source.cloneNode(true) as HTMLElement
  const sources = [source, ...Array.from(source.querySelectorAll('*'))]
  const clones = [clone, ...Array.from(clone.querySelectorAll('*'))]
  for (let i = 0; i < sources.length; i++) inlineComputedStyle(sources[i], clones[i])
  return clone
}

/** 页面里全部可读样式表的文本（同源内联样式与 Vite 注入的样式都在其中） */
function stylesheetText(): string {
  const parts: string[] = []
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      for (const rule of Array.from(sheet.cssRules)) parts.push(rule.cssText)
    } catch {
      // 跨域样式表读不到 cssRules，跳过即可（本项目不存在这种表）
    }
  }
  return parts.join('\n')
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.onerror = () => reject(new Error('图片读取失败'))
    reader.readAsDataURL(blob)
  })
}

/** 把一张图片转成 data URL；失败返回 null（截图里保留原图，宁可裂图也不整张失败） */
async function imageToDataUrl(src: string): Promise<string | null> {
  if (!src) return null
  if (src.startsWith('data:')) return src
  try {
    const res = await fetch(src)
    if (!res.ok) return null
    return await blobToDataUrl(await res.blob())
  } catch {
    // 外链图片常常不允许跨域读取；这里静默降级
    return null
  }
}

/** 克隆里的 `<img>` 全部改写成 data URL（foreignObject 不加载外部资源） */
async function inlineImages(clone: Element, cache: Map<string, string | null>): Promise<void> {
  const images = Array.from(clone.querySelectorAll('img'))
  await Promise.all(
    images.map(async (img) => {
      const src = img.getAttribute('src') ?? ''
      if (!src || src.startsWith('data:')) return
      if (!cache.has(src)) cache.set(src, await imageToDataUrl(src))
      const dataUrl = cache.get(src)
      if (dataUrl) img.setAttribute('src', dataUrl)
    })
  )
}

/**
 * 拼出承载 foreignObject 的 SVG。
 *
 * CSS 用 textContent 写入 `<style>`，让 XMLSerializer 自己做转义：
 * 样式表里的 `&`、`<`（如 `@media (width < 600px)`）直接拼进 XML 会让整个 SVG 解析失败。
 * 尺寸必须显式写死——foreignObject 里没有视口，`vw`/`vh` 与百分比高度都会塌成 0。
 */
function buildSvg(width: number, height: number, css: string, content: string): string {
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('width', String(width))
  svg.setAttribute('height', String(height))
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`)

  const foreign = document.createElementNS(SVG_NS, 'foreignObject')
  foreign.setAttribute('x', '0')
  foreign.setAttribute('y', '0')
  foreign.setAttribute('width', String(width))
  foreign.setAttribute('height', String(height))

  const body = document.createElementNS('http://www.w3.org/1999/xhtml', 'div')
  body.setAttribute('style', 'width:100%;')

  const style = document.createElementNS('http://www.w3.org/1999/xhtml', 'style')
  style.textContent = css
  body.appendChild(style)
  body.insertAdjacentHTML('beforeend', content)

  foreign.appendChild(body)
  svg.appendChild(foreign)
  return new XMLSerializer().serializeToString(svg)
}

/** UTF-8 安全的 base64：题干里的中文不能直接喂给 btoa */
function utf8ToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let binary = ''
  const CHUNK = 0x8000 // 分块拼接，避免超长 SVG 触发参数数量上限
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}

function loadSvgImage(svg: string): Promise<HTMLImageElement> {
  const url = `data:image/svg+xml;charset=utf-8;base64,${utf8ToBase64(svg)}`
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('题干或选项包含无法渲染的内容'))
    img.src = url
  })
}

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob)
      else reject(new Error('图片编码失败'))
    }, 'image/png')
  })
}

/**
 * 画布上是否存在非白像素。
 *
 * 用于拦截「内容整体被画到画布外」这类静默失败：那种情况下得到的是一张纯白 PNG，
 * 用户看不出哪里错了。按行与列抽样即可，不必逐像素扫全图。
 */
function hasVisibleContent(ctx: CanvasRenderingContext2D, width: number, height: number): boolean {
  let data: Uint8ClampedArray
  try {
    data = ctx.getImageData(0, 0, width, height).data
  } catch {
    // 画布被跨域图片污染时读不回来，此时不做判断，交给后续编码
    return true
  }
  const xStep = Math.max(1, Math.floor(width / 200))
  const yStep = Math.max(1, Math.floor(height / 200))
  for (let y = 0; y < height; y += yStep) {
    for (let x = 0; x < width; x += xStep) {
      const i = (y * width + x) * 4
      if (data[i] < 245 || data[i + 1] < 245 || data[i + 2] < 245) return true
    }
  }
  return false
}

export interface CaptureOptions {
  /** 截图内边距（px） */
  padding?: number
  /** 元素之间的间距（px） */
  gap?: number
  /**
   * 截图内容宽度（px）。默认取第一个元素的渲染宽度；
   * 传入卡片内容区宽度可让截图与页面版式对齐（`.q-stem` 这类元素本身不带卡片内边距）。
   */
  width?: number
}

/**
 * 把若干 DOM 元素纵向拼成一张 PNG。
 *
 * @param sources 待截图的元素（按出现顺序）
 * @param options 内边距与间距
 * @returns PNG Blob；`sources` 为空或元素无尺寸时返回 null
 */
export async function captureElementsAsPng(
  sources: Element[],
  options: CaptureOptions = {}
): Promise<Blob | null> {
  const list = sources.filter((el): el is HTMLElement => !!el)
  if (!list.length) return null
  const padding = options.padding ?? 16
  const gap = options.gap ?? 16
  const width = Math.max(1, Math.round(options.width ?? list[0].getBoundingClientRect().width))

  // 截图统一补白底：深色模式下卡片背景是透明的，不补底会得到一张糊在深色上的图。
  // 底色转白后如果正文色本身也是浅色（深色模式），再补一个深色字色兜底。
  // 这两项必须在宿主进入文档前定好——位置/颜色在序列化后再改，量到的样式未必同步。
  const bodyStyle = window.getComputedStyle(document.body)
  const bodyBg = bodyStyle.backgroundColor
  const bodyColor = bodyStyle.color
  const dark = document.documentElement.classList.contains('dark')
  const hostBg = TRANSPARENT.has(bodyBg) ? '#ffffff' : bodyBg
  const hostColor = dark || TRANSPARENT.has(bodyColor) ? '#1f2937' : bodyColor

  // 把克隆出来的内容包进临时宿主：在真实文档里参与一次布局，量完尺寸就移除。
  // 宿主自身也会被序列化，所以位置类样式在创建时就定死，之后不再改动。
  const wrapper = document.createElement('div')
  wrapper.style.cssText =
    HOST_CSS +
    `width:${width}px;padding:${padding}px;` +
    `background:${hostBg};color:${hostColor};display:flex;flex-direction:column;`
  wrapper.style.gap = `${gap}px`

  const cloneCache = new Map<string, string | null>()
  for (const source of list) wrapper.appendChild(cloneWithStyles(source))
  document.body.appendChild(wrapper)

  try {
    await inlineImages(wrapper, cloneCache)
    const layoutWidth = Math.ceil(wrapper.offsetWidth)
    const layoutHeight = Math.ceil(wrapper.offsetHeight)
    if (layoutWidth < 2 || layoutHeight < 2) return null

    const svg = buildSvg(layoutWidth, layoutHeight, stylesheetText(), wrapper.outerHTML)
    const image = await loadSvgImage(svg)

    const canvas = document.createElement('canvas')
    canvas.width = Math.round(layoutWidth * SCALE)
    canvas.height = Math.round(layoutHeight * SCALE)
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    ctx.scale(SCALE, SCALE)
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, layoutWidth, layoutHeight)
    ctx.drawImage(image, 0, 0, layoutWidth, layoutHeight)
    // 交出纯白图等于让用户拿到一张没用的图片（此前的 `left:-100000px` 就栽在这里），
    // 所以宁可报错也不要静默写入剪贴板。
    if (!hasVisibleContent(ctx, canvas.width, canvas.height)) {
      throw new Error('截图内容为空，复制失败')
    }
    return await canvasToBlob(canvas)
  } finally {
    wrapper.remove()
  }
}

/**
 * 把若干 DOM 元素作为图片写入剪贴板。
 *
 * 需要安全上下文（https 或 localhost）与浏览器剪贴板权限；
 * 不支持时抛出可直接展示给用户的中文错误。
 */
export async function copyElementsAsImage(
  sources: Element[],
  options: CaptureOptions = {}
): Promise<void> {
  if (typeof ClipboardItem === 'undefined' || !navigator.clipboard?.write) {
    throw new Error('当前浏览器不支持复制图片，请改用长按/右键保存')
  }
  const blob = await captureElementsAsPng(sources, options)
  if (!blob) throw new Error('没有可复制的内容')
  // Safari 要求 ClipboardItem 的值是 Promise，这里统一用 Promise 包裹，各浏览器都兼容
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': Promise.resolve(blob) })])
}
