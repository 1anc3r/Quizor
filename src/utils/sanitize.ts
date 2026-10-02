/**
 * HTML 白名单净化。
 *
 * 题库（题干 / 选项 / 解析）以 HTML 形式存储，且**可以来自外部文件**：
 * 内置的 `public/data/banks/*.json`、用户从他人处导入的题库 JSON、备份文件。
 * 这些字符串最终会经由 `RichText.vue` 写入 `innerHTML`，因此必须先净化，
 * 否则一个 `.json` 文件就能在应用源下执行任意脚本（读取 localStorage 中的
 * 全部做题记录与题库编辑内容）。
 *
 * 这里没有引入 DOMPurify：净化器用浏览器原生 `DOMParser` 实现，
 * 采用「白名单标签 + 白名单属性 + URL 协议白名单」三重收口，
 * 对 Quill / Fluent Editor 产出的有限标签集来说足够严格，且不新增任何依赖。
 */

/** 允许保留的标签（Quill / Fluent Editor 富文本的产出范围） */
const ALLOWED_TAGS = new Set([
  'a', 'b', 'blockquote', 'br', 'caption', 'center', 'code', 'col', 'colgroup',
  'dd', 'del', 'div', 'dl', 'dt', 'em', 'figcaption', 'figure', 'h1', 'h2', 'h3',
  'h4', 'h5', 'h6', 'hr', 'i', 'img', 'ins', 'li', 'mark', 'ol', 'p', 'pre', 's',
  'small', 'span', 'strike', 'strong', 'sub', 'sup', 'table', 'tbody', 'td',
  'tfoot', 'th', 'thead', 'tr', 'u', 'ul'
])

/**
 * 连同内容一起丢弃的标签。
 * `svg` / `math` 也在其中：预渲染的 KaTeX 子树会在渲染阶段由 `katex.render()`
 * 整段重建，保留它们只有体积成本，而 SVG/MathML 是事件属性的常见藏身处。
 */
const DROP_WITH_CONTENT = new Set([
  'script', 'style', 'iframe', 'frame', 'frameset', 'object', 'embed', 'link',
  'meta', 'base', 'title', 'template', 'noscript', 'svg', 'math', 'form',
  'input', 'button', 'textarea', 'select', 'option', 'optgroup', 'fieldset',
  'legend', 'audio', 'video', 'source', 'track', 'canvas', 'applet', 'portal'
])

/** 允许保留的属性名（`on*` 事件属性一律无条件剔除，不在此表内） */
const ALLOWED_ATTRS = new Set([
  'align', 'alt', 'class', 'colspan', 'contenteditable', 'data-value',
  'height', 'href', 'rel', 'rowspan', 'span', 'src', 'start', 'style',
  'target', 'title', 'valign', 'width'
])

/** 允许的 URL 前缀：http(s)、邮件、电话、锚点、相对路径、内联图片 */
const SAFE_URL = /^(?:https?:|mailto:|tel:|#|\/|\.{1,2}\/|data:image\/(?:png|jpe?g|gif|webp|bmp);base64,)/

/** 会被 `style` 属性滥用的危险片段 */
const DANGEROUS_STYLE = /expression\s*\(|javascript:|vbscript:|@import|url\s*\(\s*['"]?\s*(?:javascript|vbscript)/i

/**
 * 判断 URL 是否安全。
 * 浏览器解析 URL 时会丢弃控制字符与前导空白，所以比较前先做同样的归一化，
 * 避免 `java\tscript:` 这类绕过。
 */
function isSafeUrl(raw: string): boolean {
  const normalized = raw.replace(/[\u0000-\u0020\u007f]+/g, '').toLowerCase()
  return SAFE_URL.test(normalized)
}

/** 递归净化单个元素：先处理子树，再决定本节点的去留与属性 */
function sanitizeElement(el: Element): void {
  // 先递归：这样即使本节点被「脱壳」保留子节点，子节点也已经是干净的
  for (const child of Array.from(el.children)) sanitizeElement(child)

  const tag = el.tagName.toLowerCase()

  if (!ALLOWED_TAGS.has(tag)) {
    if (DROP_WITH_CONTENT.has(tag)) {
      el.remove()
    } else {
      el.replaceWith(...Array.from(el.childNodes))
    }
    return
  }

  for (const attr of Array.from(el.attributes)) {
    const name = attr.name.toLowerCase()
    if (name.startsWith('on') || !ALLOWED_ATTRS.has(name)) {
      el.removeAttribute(attr.name)
      continue
    }
    if ((name === 'src' || name === 'href') && !isSafeUrl(attr.value)) {
      el.removeAttribute(attr.name)
      continue
    }
    if (name === 'style' && DANGEROUS_STYLE.test(attr.value)) {
      el.removeAttribute(attr.name)
    }
  }
}

/**
 * 净化一段 HTML 字符串，返回可安全写入 `innerHTML` 的 HTML。
 *
 * @param html 不可信的 HTML（题库题目内容 / 导入文件内容）
 * @returns 仅含白名单标签与属性的 HTML
 */
export function sanitizeHtml(html: string): string {
  if (!html) return ''
  // DOMParser 解析出的文档不会执行脚本、也不会加载图片（不触发 onerror）
  const doc = new DOMParser().parseFromString(html, 'text/html')
  for (const child of Array.from(doc.body.children)) sanitizeElement(child)
  return doc.body.innerHTML
}
