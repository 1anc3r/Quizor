/**
 * 富文本 / 纯文本工具。
 */

/** 将 HTML 富文本转为纯文本（用于列表摘要、搜索） */
export function htmlToText(html: string): string {
  if (!html) return ''
  // 公式节点保留其 LaTeX 源码作为可读文本
  const replaced = html.replace(/<span class="ql-formula"[^>]*data-value="([^"]*)"[^>]*>[\s\S]*?<\/span>/g, ' $1 ')
  const div = document.createElement('div')
  div.innerHTML = replaced
  const text = div.textContent || ''
  return text.replace(/\s+/g, ' ').trim()
}

/** 富文本转纯文本后截取前 n 字（默认 30 字），超出追加省略号 */
export function summarize(html: string, n = 30): string {
  const text = htmlToText(html)
  if (text.length <= n) return text
  return text.slice(0, n) + '…'
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
