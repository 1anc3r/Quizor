/**
 * 精简 KaTeX 的 @font-face：只保留 woff2。
 *
 * KaTeX 自带 20 个字体，每个 @font-face 都列出 woff2 / woff / truetype 三种格式。
 * woff2 自 2016 年起所有在维护的浏览器都支持（IE11 除外，本项目不使用），
 * 后两种纯属冗余：不处理的话构建产物里会多出 40 个永不会被请求的字体文件、约 0.78MB。
 *
 * 实现要点：必须在 **transform** 阶段改写，而不是 generateBundle。
 * Vite 在 transform 阶段就会扫描 CSS 里的 url() 并 emit 对应资源，
 * 等到 generateBundle 再改，woff/ttf 已经躺在产物里了。
 *
 * 顺带说明：字体是"用到才下载"的资源，本插件不影响首屏，只是让产物更干净。
 */
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { Plugin } from 'vite'

/** KaTeX 样式表路径（同时匹配 katex.min.css 与源文件） */
const KATEX_CSS = /[\\/]katex[\\/]dist[\\/]katex(?:\.min)?\.css$/i

/** 从一条 src 描述里只留下 woff2 */
export function woff2Only(srcValue: string): string {
  const parts = srcValue.split(',')
  const woff2 = parts.filter((p) => /format\(\s*["']?woff2["']?\s*\)/i.test(p))
  // 没有 woff2 可用时原样保留，避免把字体整个删掉
  return woff2.length ? woff2.join(',') : srcValue
}

/** 被裁掉的字体文件总字节数（仅用于提示） */
function droppedFontBytes(): number {
  const dir = join(process.cwd(), 'node_modules', 'katex', 'dist', 'fonts')
  try {
    return readdirSync(dir)
      .filter((f) => /\.(woff|ttf)$/i.test(f))
      .reduce((sum, f) => sum + statSync(join(dir, f)).size, 0)
  } catch {
    return 0
  }
}

export function katexFontFormatPlugin(): Plugin {
  return {
    name: 'quizor:katex-woff2-only',
    apply: 'build',
    enforce: 'pre',
    transform(code, id) {
      if (!KATEX_CSS.test(id)) return null
      let faces = 0
      const out = code.replace(/(src\s*:\s*)([^;}]+)/gi, (whole, head: string, value: string) => {
        const next = woff2Only(value)
        if (next === value) return whole
        faces++
        return head + next
      })
      if (!faces) return null
      const mb = (droppedFontBytes() / 1024 / 1024).toFixed(2)
      this.info?.(`KaTeX 字体：${faces} 条 @font-face 精简为仅 woff2，产物减少约 ${mb}MB 冗余字体`)
      return { code: out, map: null }
    }
  }
}
