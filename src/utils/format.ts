import type { QuestionType } from '@/types'

export const TYPE_LABELS: Record<QuestionType, string> = {
  single: '单选',
  multiple: '多选',
  judge: '判断',
  text: '简答'
}

export function typeLabel(t: QuestionType): string {
  return TYPE_LABELS[t] ?? t
}

/** 秒 → HH:MM:SS（不足 1 小时为 MM:SS） */
export function fmtDuration(totalSec: number): string {
  const sec = Math.max(0, Math.floor(totalSec))
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = sec % 60
  const mm = String(m).padStart(2, '0')
  const ss = String(s).padStart(2, '0')
  return h > 0 ? `${String(h).padStart(2, '0')}:${mm}:${ss}` : `${mm}:${ss}`
}

/** 时间戳 → YYYY-MM-DD HH:mm */
export function fmtTime(ts: number): string {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 时间戳 → MM-DD HH:mm（图表横轴等紧凑场景） */
export function fmtTimeShort(ts: number): string {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 去除 HTML 标签得到纯文本（列表展示、关键字查询用） */
export function plainText(html: string): string {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 截断文本 */
export function truncate(text: string, len: number): string {
  return text.length > len ? `${text.slice(0, len)}…` : text
}

/** 字节数 → 可读体积（B / KB / MB） */
export function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${Math.max(0, Math.round(bytes))} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/**
 * 同 `fmtBytes`，但 MB 保留两位小数。
 *
 * 给"正在下载 6MB 全文"这类进度显示用：一位小数在 5.6MB→5.7MB 之间几乎不动，
 * 看起来像卡住了，两位小数才能反映出确实在前进。
 */
export function fmtBytesPrecise(bytes: number): string {
  if (bytes < 1024) return `${Math.max(0, Math.round(bytes))} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}

/** 题号短显：取 id 末 6 位 */
export function shortId(id: string): string {
  return id.length > 8 ? id.slice(-6) : id
}
