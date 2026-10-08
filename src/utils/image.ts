/**
 * 内嵌图片策略：内嵌前先压缩，压缩后仍超限就拒绝内嵌。
 *
 * 为什么必须管：题库与做题记录都以 JSON 存进 localStorage，
 * 内嵌图片是 base64（体积 ≈ 原图 × 4/3），而 localStorage 按 UTF-16 计（字符数再 × 2），
 * 同一张图还会同时出现在 bankdata（题库数据）与 session（答题快照）里。
 * 于是 1MB 的原始图片最高可吃掉 5MB 配额中的数 MB —— 一张手机截图就够了。
 */

/** 单张内嵌图片的体积上限（压缩后仍超过则拒绝内嵌，引导改用外链） */
export const IMAGE_EMBED_MAX_BYTES = 200 * 1024

/** 压缩时的最长边（px）：屏幕阅读足够清晰，避免手机直出的大图 */
export const IMAGE_MAX_EDGE = 1280

/** 有损编码质量 */
export const IMAGE_QUALITY = 0.82

/** 不做有损压缩的类型：矢量图与动图，栅格化会丢信息 */
const SKIP_COMPRESS_TYPES = new Set(['image/svg+xml', 'image/gif'])

/**
 * 该图片能否安全内嵌。
 * sanitizeHtml 的 URL 白名单只允许 data:image/(png|jpe?g|gif|webp|bmp);base64，
 * 内嵌 SVG 的 src 会在渲染时被剥掉、变成裂图，所以 SVG 只能走外链。
 */
export function isEmbeddableType(type: string, name = ''): boolean {
  return !(type === 'image/svg+xml' || /\.svg$/i.test(name))
}

export interface ImagePrepareResult {
  /** 可直接内嵌的 data URL */
  dataUrl: string
  /** 内嵌后 data URL 的载荷字节数（≈ 磁盘上的图片体积） */
  bytes: number
  /** 若不做压缩直接内嵌时的载荷字节数，用于展示压缩效果 */
  rawBytes: number
  /** 原始文件字节数 */
  originalBytes: number
  /** 压缩后仍超出内嵌上限 */
  tooLarge: boolean
}

/** data URL 的载荷字节数（base64 载荷 ≈ 载荷字符数 × 3/4） */
export function dataUrlBytes(dataUrl: string): number {
  const comma = dataUrl.indexOf(',')
  if (comma < 0) return 0
  return Math.floor(((dataUrl.length - comma - 1) * 3) / 4)
}

/**
 * 内嵌图片在 localStorage 里的近似占用字节数。
 * base64 载荷 × 4/3 = 字符数；localStorage 按 UTF-16 计，字符数 × 2。
 */
export function embedStorageBytes(payloadBytes: number): number {
  return Math.round((payloadBytes * 8) / 3)
}

/** 等比缩放后的尺寸（最长边不超过 maxEdge，只缩不放） */
export function fitSize(width: number, height: number, maxEdge = IMAGE_MAX_EDGE): { width: number; height: number } {
  const longest = Math.max(width, height)
  if (!longest || longest <= maxEdge) return { width: Math.max(1, width), height: Math.max(1, height) }
  const scale = maxEdge / longest
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) }
}

/** 浏览器是否支持 canvas 编码 WebP（支持则可在保留透明通道的同时压缩） */
let webpSupport: boolean | null = null
export function supportsWebp(): boolean {
  if (webpSupport !== null) return webpSupport
  try {
    const canvas = document.createElement('canvas')
    canvas.width = 1
    canvas.height = 1
    webpSupport = canvas.toDataURL('image/webp').startsWith('data:image/webp')
  } catch {
    webpSupport = false
  }
  return webpSupport
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.onerror = () => reject(new Error('读取文件失败'))
    reader.readAsDataURL(file)
  })
}

function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      URL.revokeObjectURL(url)
      resolve(img)
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('图片解码失败'))
    }
    img.src = url
  })
}

/** 把图片栅格化并按质量重编码为 data URL；无法处理时返回 null */
async function rasterize(file: File): Promise<string | null> {
  const img = await loadImage(file)
  const { width, height } = fitSize(img.naturalWidth || img.width, img.naturalHeight || img.height)
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  const type = supportsWebp() ? 'image/webp' : 'image/jpeg'
  // 不支持 WebP 时只能输出 JPEG，而 JPEG 没有透明通道：先铺白底，否则透明区域会变黑
  if (type === 'image/jpeg') {
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, width, height)
  }
  ctx.drawImage(img, 0, 0, width, height)
  const dataUrl = canvas.toDataURL(type, IMAGE_QUALITY)
  return dataUrl.startsWith('data:') ? dataUrl : null
}

/**
 * 准备一张待内嵌的图片：能压则压，压不动就用原图。
 * 任何解码/编码失败都退回原图，不阻断用户插入。
 */
export async function prepareImageFile(file: File): Promise<ImagePrepareResult> {
  const originalBytes = file.size
  const raw = await readAsDataUrl(file)
  const rawBytes = dataUrlBytes(raw)
  const asIs: ImagePrepareResult = {
    dataUrl: raw,
    bytes: rawBytes,
    rawBytes,
    originalBytes,
    tooLarge: rawBytes > IMAGE_EMBED_MAX_BYTES
  }
  if (SKIP_COMPRESS_TYPES.has(file.type) || /\.(svg|gif)$/i.test(file.name)) return asIs
  try {
    const compressed = await rasterize(file)
    if (!compressed) return asIs
    const bytes = dataUrlBytes(compressed)
    // 压缩后反而更大（小图、已优化过的图）就用原图
    if (bytes >= rawBytes) return asIs
    return { dataUrl: compressed, bytes, rawBytes, originalBytes, tooLarge: bytes > IMAGE_EMBED_MAX_BYTES }
  } catch {
    return asIs
  }
}
