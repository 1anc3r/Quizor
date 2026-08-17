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

/** 难度 → 星级文本 */
export function difficultyStars(d: number): string {
  const n = Math.min(5, Math.max(1, Math.round(d || 1)))
  return '★'.repeat(n) + '☆'.repeat(5 - n)
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

/** 题号短显：取 id 末 6 位 */
export function shortId(id: string): string {
  return id.length > 8 ? id.slice(-6) : id
}
