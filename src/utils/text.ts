/**
 * 富文本 / 纯文本工具。
 */

/** 将 HTML 富文本转为纯文本（用于列表摘要、搜索） */
export function htmlToText(html: string): string {
  if (!html) return ''
  // 公式节点保留其 LaTeX 源码作为可读文本
  const replaced = html.replace(/<span class="ql-formula"[^>]*data-value="([^"]*)"[^>]*>[\s\S]*?<\/span>/g, ' $1 ')
  // Worker 线程（组卷/判分 Worker，见 services/quizWorker.ts）没有 DOM API，
  // DOMParser 不存在。这里退到"正则剥标签 + 解码常见实体"，与下面 DOMParser 路径
  // 口径一致（标签 → 空、空白折叠）；罕见命名实体不在映射表里会原样保留，
  // 对做题记录里的题干摘要是可接受的损耗。
  if (typeof DOMParser === 'undefined') {
    return replaced
      .replace(/<[^>]*>/g, ' ')
      .replace(/&(?:amp|lt|gt|quot|apos|nbsp);|&#39;/g, (entity) => WORKER_ENTITY_MAP[entity] ?? entity)
      .replace(/\s+/g, ' ')
      .trim()
  }
  // 用 DOMParser 而不是 div.innerHTML：解析出的文档是惰性的，不会执行脚本，也不会触发图片加载
  const doc = new DOMParser().parseFromString(replaced, 'text/html')
  const text = doc.body.textContent || ''
  return text.replace(/\s+/g, ' ').trim()
}

/** Worker 环境里 htmlToText 兜底路径解码的实体表（只覆盖高频几个） */
const WORKER_ENTITY_MAP: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
  '&#39;': "'",
  '&nbsp;': ' '
}

/** 做题记录中保存的题干摘要长度上限（记录不保存全量富文本题干） */
export const STEM_SUMMARY_LEN = 120

/**
 * 富文本 / 纯文本 → 纯文本后截取前 n 字，超出追加省略号。
 * 只有确实是富文本才走 HTML 解析：纯文本题干可能含 < > 等数学符号，
 * 当 HTML 剥离会把内容一起吃掉。
 */
export function summarize(content: string, n = STEM_SUMMARY_LEN): string {
  if (!content) return ''
  const text = isHtml(content) ? htmlToText(content) : content.replace(/\s+/g, ' ').trim()
  return text.length > n ? text.slice(0, n) + '…' : text
}

/**
 * 生成落盘用的题干摘要。
 * 已短于上限时原样返回，因此"是否与入参相同"可用来判断是否需要改写，
 * 对历史记录的一次性压缩是幂等的。
 */
export function stemSummary(stem: string, n = STEM_SUMMARY_LEN): string {
  if (!stem || stem.length <= n) return stem
  return summarize(stem, n)
}

/** 判断字符串是否包含 HTML 标签 */
export function isHtml(s: string): boolean {
  return /<\w+[^>]*>/.test(s)
}

/** HTML 转义（纯文本安全渲染用） */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
