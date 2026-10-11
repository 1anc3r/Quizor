/**
 * 构建期题库索引生成插件。
 *
 * 背景：`public/data/banks/*.json` 里的完整题库约 6MB（题干/解析富文本 + 内嵌图片），
 * 托管方会把它 gzip 到约 1.2MB，但解压后仍有 6MB 要下载、解析并常驻内存 —— 这是首屏慢的主因。
 *
 * 这里在构建时按 `public/data/BankManifest.json` 逐个题库生成 `*_index.json`：
 * 只保留"每题的纯文本摘要 + 章节/题型/难度/来源/标签"与试卷清单，
 * 体积约为全文的 1/20，供首屏（首页列表、统计、章节选择）使用。
 *
 * 索引必须与题库文件同源生成：手写或提交到仓库会随时间腐坏（题库更新后索引过期），
 * 因此只在构建期产出，不加进版本库。
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Plugin } from 'vite'
// 必须带 .ts 后缀：本文件既被 Vite 打包，也被 node --experimental-strip-types 直接运行
// （scripts/build-bank-index.mjs），而 Node 的 ESM 解析不做后缀补全。
import { indexFileName } from '../src/utils/bankFile.ts'

/** 题干摘要长度上限：够列表展示与关键字过滤，又不至于把富文本拖回来 */
const SUMMARY_LEN = 80

/**
 * HTML 富文本 → 纯文本摘要。
 * 不复用 src/utils/text.ts：那里依赖浏览器 DOMParser，而这里跑在 Node 里。
 */
export function htmlToPlainText(html: string): string {
  if (!html) return ''
  return html
    // 公式节点保留 LaTeX 源码，否则公式题在列表里只剩空白
    .replace(/<span class="ql-formula"[^>]*data-value="([^"]*)"[^>]*>[\s\S]*?<\/span>/g, ' $1 ')
    // 图片与表格单元格用占位符代替，避免文字粘连
    .replace(/<(?:img|br|hr)\b[^>]*>/gi, ' ')
    .replace(/<\/(?:p|div|li|tr|h[1-6])>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()
}

function summarize(html: string): string {
  const text = htmlToPlainText(html)
  return text.length > SUMMARY_LEN ? `${text.slice(0, SUMMARY_LEN)}…` : text
}

/**
 * 单个题库 JSON → 索引对象。
 *
 * `fullSize` 是全文**解压后**的字节数，由调用方按原始文本算好传进来：
 * 托管方（GitHub Pages/Fastly）会给 JSON 加 gzip，运行时从响应头拿到的
 * `Content-Length` 是压缩后的体积（6MB → 约 1.2MB），拿它当下载进度的分母
 * 会算出"480%"这种百分比、并让进度条在下载尚未完成时就满格。
 * 这份解压后的总量浏览器侧算不出来，只能在构建期记账。
 */
export function buildIndex(
  bank: Record<string, unknown>,
  meta: Record<string, unknown>,
  fullSize?: number
): Record<string, unknown> {
  const questions = Array.isArray(bank.Questions) ? (bank.Questions as Record<string, unknown>[]) : []
  const papers = Array.isArray(bank.Papers) ? (bank.Papers as Record<string, unknown>[]) : []
  return {
    id: meta.id,
    name: typeof bank.name === 'string' && bank.name ? bank.name : meta.name,
    questionCount: questions.length,
    rule: bank.rule ?? meta.rule,
    // 0/负数/缺失一律不写：JSON.stringify 会丢掉 undefined，此时前端按"总量未知"处理
    fullSize: typeof fullSize === 'number' && fullSize > 0 ? fullSize : undefined,
    questions: questions.map((q) => ({
      id: q.id,
      type: q.type,
      chapter: q.chapter,
      difficulty: q.difficulty,
      stem: summarize(typeof q.stem === 'string' ? q.stem : ''),
      source: q.source,
      tags: Array.isArray(q.tags) ? q.tags : []
    })),
    papers
  }
}

/** `Bank_Kaoyan_Guanzong.json` → `Bank_Kaoyan_Guanzong_index.json`（与浏览器端共用同一实现） */
export { indexFileName }

/**
 * 生成索引并在构建产物里 emit。
 * 开发态由 `public/data` 里的存量索引文件提供（首次开发前先跑一次 `npm run build:index`）。
 */
export function bankIndexPlugin(): Plugin {
  return {
    name: 'quizor:bank-index',
    apply: 'build',
    async buildStart() {
      const dataDir = join(process.cwd(), 'public', 'data')
      let manifest: { Banks?: Record<string, unknown>[] }
      try {
        manifest = JSON.parse(await readFile(join(dataDir, 'BankManifest.json'), 'utf8'))
      } catch (e) {
        this.warn(`题库索引：读取 BankManifest.json 失败，跳过索引生成（${(e as Error).message}）`)
        return
      }
      const banks = Array.isArray(manifest.Banks) ? manifest.Banks : []
      let total = 0
      for (const meta of banks) {
        const bankFile = typeof meta.bankFile === 'string' ? meta.bankFile : ''
        if (!bankFile) continue
        try {
          const raw = await readFile(join(dataDir, 'banks', bankFile), 'utf8')
          // 全文的字节数按 UTF-8 编码算：raw.length 是 UTF-16 码元个数，
          // 中文题干占比高的题库会少算一半以上，而下载进度是按字节统计的
          const fullSize = new TextEncoder().encode(raw).length
          const bank = JSON.parse(raw) as Record<string, unknown>
          const index = buildIndex(bank, meta, fullSize)
          const body = JSON.stringify(index)
          const indexSize = new TextEncoder().encode(body).length
          this.emitFile({ type: 'asset', fileName: `data/banks/${indexFileName(bankFile)}`, source: body })
          const ratio = fullSize ? Math.round((indexSize / fullSize) * 100) : 0
          this.info?.(
            `题库索引 ${indexFileName(bankFile)}: ${(indexSize / 1024).toFixed(0)}KB / 全文 ${(fullSize / 1024).toFixed(0)}KB（${ratio}%）`
          )
          total++
        } catch (e) {
          this.warn(`题库索引：${bankFile} 生成失败（${(e as Error).message}）`)
        }
      }
      if (total) this.info?.(`题库索引：共生成 ${total} 个`)
    }
  }
}
