/**
 * 生成题库索引到 `public/data/banks/*_index.json`。
 *
 * 与 `vite-plugins/bankIndex.ts` 共用同一份生成逻辑，避免两处实现漂移。
 * 之所以还要落盘到 public/：开发态（vite dev）与静态托管都直接从 public 提供文件，
 * 索引必须在仓库工作区里真实存在；这些文件是产物，已加入 .gitignore。
 *
 * 用法：node --experimental-strip-types scripts/build-bank-index.mjs
 *
 * 注意：从 .mjs / .ts 里 import 本项目源码时必须写全 `.ts` 后缀 —— Node 的 ESM
 * 解析不做后缀补全（Vite 会补，所以只在 Vite 里跑通不代表这里能跑）。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildIndex, indexFileName } from '../vite-plugins/bankIndex.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dataDir = join(root, 'public', 'data')
const banksDir = join(dataDir, 'banks')

async function main() {
  const manifest = JSON.parse(await readFile(join(dataDir, 'BankManifest.json'), 'utf8'))
  const banks = Array.isArray(manifest.Banks) ? manifest.Banks : []
  await mkdir(banksDir, { recursive: true })

  let fullBytes = 0
  let indexBytes = 0
  for (const meta of banks) {
    if (!meta || typeof meta.bankFile !== 'string' || !meta.bankFile) continue
    const raw = await readFile(join(banksDir, meta.bankFile), 'utf8')
    // 全文按 UTF-8 字节数记账（不能用 raw.length：那是 UTF-16 码元数，中文题干会少算一半），
    // 下载进度的分母就是它 —— 详见 vite-plugins/bankIndex.ts 的 buildIndex 注释
    const fullSize = new TextEncoder().encode(raw).length
    const bank = JSON.parse(raw)
    const body = JSON.stringify(buildIndex(bank, meta, fullSize))
    const indexSize = new TextEncoder().encode(body).length
    const out = join(banksDir, indexFileName(meta.bankFile))
    await writeFile(out, body, 'utf8')
    fullBytes += fullSize
    indexBytes += indexSize
    const ratio = fullSize ? ((indexSize / fullSize) * 100).toFixed(1) : '0'
    console.log(
      `[bank-index] ${indexFileName(meta.bankFile)}  ${(indexSize / 1024).toFixed(0)}KB` +
        `  (全文 ${(fullSize / 1024).toFixed(0)}KB，${ratio}%)  题目 ${bank.Questions?.length ?? 0} 道`
    )
  }
  const saved = fullBytes ? (100 - (indexBytes / fullBytes) * 100).toFixed(1) : '0'
  console.log(
    `[bank-index] 合计：索引 ${(indexBytes / 1024).toFixed(0)}KB / 全文 ${(fullBytes / 1024).toFixed(0)}KB，首屏数据量减少 ${saved}%`
  )
}

main().catch((e) => {
  console.error('[bank-index] 生成失败：', e)
  process.exitCode = 1
})
