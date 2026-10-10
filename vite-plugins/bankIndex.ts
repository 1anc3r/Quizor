/**
 * 构建期题库索引生成插件。
 *
 * 背景：`public/data/banks/*.json` 里的完整题库约 5MB（题干/解析富文本 + 内嵌图片），
 * 而 GitHub Pages 对静态 JSON 不做 gzip，冷启动必须原样下载这 5MB —— 这是首屏慢的主因。
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

/** 单个题库 JSON → 索引对象 */
export function buildIndex(bank: Record<string, unknown>, meta: Record<string, unknown>): Record<string, unknown> {
  const questions = Array.isArray(bank.Questions) ? (bank.Questions as Record<string, unknown>[]) : []
  const papers = Array.isArray(bank.Papers) ? (bank.Papers as Record<string, unknown>[]) : []
  return {
    id: meta.id,
    name: typeof bank.name === 'string' && bank.name ? bank.name : meta.name,
    questionCount: questions.length,
    rule: bank.rule ?? meta.rule,
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
          const bank = JSON.parse(raw) as Record<string, unknown>
          const index = buildIndex(bank, meta)
          const body = JSON.stringify(index)
          this.emitFile({ type: 'asset', fileName: `data/banks/${indexFileName(bankFile)}`, source: body })
          const ratio = raw.length ? Math.round((body.length / raw.length) * 100) : 0
          this.info?.(
            `题库索引 ${indexFileName(bankFile)}: ${(body.length / 1024).toFixed(0)}KB / 全文 ${(raw.length / 1024).toFixed(0)}KB（${ratio}%）`
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
