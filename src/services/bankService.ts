/**
 * 题库数据服务。
 *
 * 题库与应用代码分离：内置题库 JSON 放在 public/data/ 下，运行时 fetch 加载；
 * 用户在浏览器内对题库的编辑、以及新增的题库，全部以"本地覆盖层/本地题库"的形式保存，
 * 从而实现"纯静态 + 可编辑"。
 *
 * 存储位置：题库存档（bankdata:）放在 **IndexedDB**，其余小数据留在 localStorage。
 * 原因：一个 880 题的题库 JSON 约 3.3MB，存进 localStorage 要占 6.6MB（UTF-16），
 * 直接超出 5MB 配额 —— 也就是"编辑内置大题库"根本无法保存。
 *
 * 加载分两层（首屏性能的关键）：
 * - **索引**（`*_index.json`，构建期生成，约全文的 4%）：只有每题摘要 + 章节/题型，
 *   供首页列表、统计、章节选择使用；
 * - **全文**（原始题库 JSON，约 5MB）：含题干富文本、选项、答案、解析、内嵌图片，
 *   只有真正要答题/组卷/浏览详情时才加载。
 * GitHub Pages 不对静态 JSON 做 gzip，冷启动原样下载 5MB 是首屏慢的主因，
 * 索引把首屏数据量降到 1/25。
 */
import type { BankData, BankIndex, BankManifest, BankMeta, BankRule, Paper, QuestionType } from '@/types'
import * as storage from './storage'
import { idbDelete, idbGetRaw, idbKeys, idbSetRaw } from './idb'
import { nameToBankId, uniqueBankId } from '../utils/pinyin'
import { stemSummary } from '../utils/text'
import { indexFileName } from '../utils/bankFile'
import { normalizeBankData, QUESTION_TYPES } from './bankNormalize'
import { parseBankJsonWithProgress, type LoadProgress } from './bankWorkerApi'

/**
 * 规整逻辑（`normalizeBankData` / `normalizeQuestions`）搬到了 `./bankNormalize`：
 * Worker 也要用它，留在这里会形成 `bankWorker → bankService → bankWorkerApi → bankWorker`
 * 的循环依赖。这里原样再导出，保持既有调用方（导入题库、备份恢复等）不用改。
 */
export { normalizeBankData, normalizeQuestions, QUESTION_TYPES } from './bankNormalize'

const K_LOCAL_BANKS = 'localbanks' // BankMeta[] 用户本地新增的题库
const K_DELETED_BANKS = 'deletedbanks' // string[] 被删除的内置题库 id
const K_BANK_DATA = 'bankdata:' // + id → BankData（内置题库的编辑覆盖层 / 本地题库数据）
const K_BANK_META = 'bankmeta:' // + id → BankMeta（内置题库元信息的编辑覆盖层）

let manifestCache: BankManifest | null = null
const bankCache = new Map<string, BankData>()
const indexCache = new Map<string, BankIndex>()

/** 本地覆盖层的时间戳：没有覆盖层时返回 null */
function overrideStamp(id: string): number | null {
  const raw = storage.readRaw(K_BANK_DATA + id)
  if (raw === null) return null
  try {
    const parsed = JSON.parse(raw) as { ts?: unknown }
    return typeof parsed.ts === 'number' ? parsed.ts : 0
  } catch {
    return 0
  }
}

const base = () => import.meta.env.BASE_URL

/** 加载题库清单：内置 BankManifest + 本地新增 - 本地删除 + 元信息覆盖 */
export async function loadManifest(force = false): Promise<BankManifest> {
  if (manifestCache && !force) return manifestCache
  let builtin: BankMeta[] = []
  try {
    const res = await fetch(`${base()}data/BankManifest.json`)
    if (res.ok) {
      const json = (await res.json()) as BankManifest
      builtin = Array.isArray(json.Banks) ? json.Banks : []
    }
  } catch (e) {
    console.warn('[quizor] BankManifest 加载失败：', e)
  }
  const deleted = storage.readJSON<string[]>(K_DELETED_BANKS, [])
  const local = storage.readJSON<BankMeta[]>(K_LOCAL_BANKS, [])
  const banks = builtin
    .filter((b) => !deleted.includes(b.id))
    .map((b) => storage.readJSON<BankMeta | null>(K_BANK_META + b.id, null) ?? b)
  manifestCache = { Banks: [...banks, ...local] }
  return manifestCache
}

/* ---------------- 题库索引（首屏用的轻量形态） ---------------- */

/** 规整索引：与题库文件同源生成，但仍按不可信输入处理 */
function normalizeIndex(raw: unknown, id: string): BankIndex | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Partial<BankIndex>
  const questions = Array.isArray(r.questions) ? r.questions : []
  return {
    id: typeof r.id === 'string' && r.id ? r.id : id,
    name: typeof r.name === 'string' ? r.name : id,
    questionCount: typeof r.questionCount === 'number' ? r.questionCount : questions.length,
    rule: (r.rule as BankRule) ?? defaultRule(),
    questions: questions.map((q) => ({
      id: typeof q.id === 'string' ? q.id : '',
      type: QUESTION_TYPES.includes(q.type as QuestionType) ? (q.type as QuestionType) : 'single',
      chapter: typeof q.chapter === 'string' ? q.chapter : '',
      difficulty: typeof q.difficulty === 'number' ? q.difficulty : 3,
      stem: typeof q.stem === 'string' ? q.stem : '',
      source: typeof q.source === 'string' ? q.source : '',
      tags: Array.isArray(q.tags) ? q.tags.filter((t): t is string => typeof t === 'string') : []
    })).filter((q) => !!q.id),
    papers: Array.isArray(r.papers) ? (r.papers as Paper[]) : [],
    ts: typeof r.ts === 'number' ? r.ts : undefined
  }
}

/** 全文数据 → 索引（本地覆盖层/本地题库没有构建期索引，就地派生一份） */
export function deriveIndex(meta: BankMeta, data: BankData, ts?: number): BankIndex {
  return {
    id: meta.id,
    name: meta.name,
    questionCount: data.Questions.length,
    rule: meta.rule,
    questions: data.Questions.map((q) => ({
      id: q.id,
      type: q.type,
      chapter: q.chapter,
      difficulty: q.difficulty,
      // 列表只展示摘要，这里直接截断，避免把 5MB 的富文本题干拷一份进内存
      stem: stemSummary(q.stem, 80),
      source: q.source,
      tags: q.tags
    })),
    papers: data.Papers,
    ts
  }
}

/** 索引的静态地址（构建期由 vite 插件生成，与题库文件同目录） */
export function indexUrl(meta: BankMeta): string {
  const dir = meta.bankFile.includes('/') ? meta.bankFile.replace(/[^/]+$/, '') : ''
  return `${base()}data/banks/${dir}${indexFileName(meta.bankFile)}`
}

/**
 * 加载题库索引（首屏用）。
 *
 * 优先本地覆盖层：用户编辑过的题库，静态索引已经过期，必须就地重新派生，
 * 否则首页会出现"编辑后仍是旧摘要/旧题数"的错位。
 */
export async function loadBankIndex(id: string, force = false): Promise<BankIndex | null> {
  if (!force && indexCache.has(id)) return indexCache.get(id) as BankIndex
  const manifest = await loadManifest()
  const meta = manifest.Banks.find((b) => b.id === id)
  if (!meta) return null

  const overrideRaw = storage.readRaw(K_BANK_DATA + id)
  if (overrideRaw !== null) {
    try {
      const data = normalizeBankData(JSON.parse(overrideRaw))
      const index = deriveIndex(meta, data, overrideStamp(id) ?? 0)
      indexCache.set(id, index)
      return index
    } catch {
      console.warn('[quizor] 本地题库覆盖层损坏，改用静态索引：', id)
    }
  }

  try {
    const res = await fetch(indexUrl(meta))
    if (res.ok) {
      const index = normalizeIndex(await res.json(), id)
      if (index) {
        indexCache.set(id, index)
        return index
      }
    }
  } catch (e) {
    console.warn('[quizor] 题库索引加载失败：', e)
  }
  // 索引缺失（例如旧部署还没生成）时由调用方决定是否直接拉全文
  return null
}

/**
 * 能否跳过 IndexedDB 读取。
 *
 * 用户每次编辑都会同时写 IDB 与 localStorage 覆盖层，而覆盖层带时间戳。
 * 索引里的 `ts` 与当前覆盖层一致，就说明这份索引已经反映了最新编辑，
 * 不必再为"有没有 Override"多查一次 IDB。
 */
function indexIsCurrent(id: string, index?: BankIndex | null): boolean {
  if (!index || typeof index.ts !== 'number') return false
  return overrideStamp(id) === index.ts
}

/* ---------------- 题库存档的读写（IndexedDB 优先） ---------------- */

/**
 * 读取题库存档：IndexedDB 优先，其次 localStorage 里的历史覆盖层。
 * 命中历史数据时顺手迁进 IDB（读回校验通过才删除源数据）。
 */
async function readBankData(id: string): Promise<BankData | null> {
  const key = storage.fullKey(K_BANK_DATA + id)
  const fromIdb = await idbGetRaw(key)
  if (fromIdb !== null) {
    try {
      return JSON.parse(fromIdb) as BankData
    } catch {
      console.warn('[quizor] IndexedDB 中的题库数据损坏，回退 localStorage：', key)
    }
  }
  const legacy = storage.readRaw(K_BANK_DATA + id)
  if (legacy === null) return null
  if ((await idbSetRaw(key, legacy)) && (await idbGetRaw(key)) === legacy) {
    storage.removeKey(K_BANK_DATA + id)
  }
  try {
    return JSON.parse(legacy) as BankData
  } catch {
    return null
  }
}

/**
 * 写入题库存档：优先 IndexedDB；IDB 不可用时退回 localStorage（受软预算限制）。
 * @returns 是否写入成功
 */
async function writeBankData(id: string, data: BankData): Promise<boolean> {
  const key = storage.fullKey(K_BANK_DATA + id)
  // 覆盖层带上时间戳，索引可据此判断自己是否仍然有效（见 indexIsCurrent）
  const payload = JSON.stringify({ ...data, ts: Date.now() })
  if (await idbSetRaw(key, payload)) {
    // 清掉可能残留的 localStorage 覆盖层，否则两处内容会不一致
    storage.removeKey(K_BANK_DATA + id)
    return true
  }
  return storage.writeJSON(K_BANK_DATA + id, payload)
}

/**
 * 一次性把 localStorage 里的题库存档搬进 IndexedDB。
 *
 * 这是最不能出错的一步，约束：
 * 1. IDB 已存在同 key 时**不覆盖**（只补缺失项），避免与正在进行的保存互相覆盖；
 * 2. 写入后必须读回、并逐字符与源数据比对，完全一致才删除 localStorage 副本；
 * 3. 任何一步失败都保留 localStorage 副本 —— 宁可继续占空间，也不能丢数据。
 * 幂等：重复执行只会剩 0 条可迁移项。
 * @returns 成功迁移的条数
 */
export async function migrateBankDataToIdb(): Promise<number> {
  const prefix = storage.fullKey(K_BANK_DATA)
  const pending: { key: string; raw: string }[] = []
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i)
    if (!key || !key.startsWith(prefix)) continue
    const raw = localStorage.getItem(key)
    if (raw !== null) pending.push({ key, raw })
  }
  // 绝大多数启动都没有待迁移项，这里提前返回，省掉“打开 IDB → 读全部 key”的等待，
  // 挂在启动关键路径上的开销直接降到一次 localStorage 遍历
  if (!pending.length) return 0
  const existing = new Set((await idbKeys()) ?? [])
  let moved = 0
  for (const { key, raw } of pending) {
    if (existing.has(key)) {
      console.warn('[quizor] 题库存档已在 IndexedDB 中，跳过迁移并保留 localStorage 副本：', key)
      continue
    }
    if (!(await idbSetRaw(key, raw))) continue
    if ((await idbGetRaw(key)) !== raw) continue
    localStorage.removeItem(key)
    moved++
  }
  return moved
}

/**
 * 加载题库数据：本地覆盖层优先，其次静态 JSON（Worker 分片下载 + 解析）；带内存缓存。
 *
 * `onProgress` 只反映"静态 JSON 的下载/解析"，本地覆盖层没有网络阶段，不会触发它。
 */
export async function loadBank(
  id: string,
  force = false,
  index?: BankIndex | null,
  onProgress?: LoadProgress
): Promise<BankData> {
  if (!force && bankCache.has(id)) return bankCache.get(id) as BankData
  // 索引与覆盖层时间戳一致时，说明没有更新的本地编辑，省掉一次 IndexedDB 查询
  const override = indexIsCurrent(id, index) ? null : await readBankData(id)
  if (override) {
    const data = normalizeBankData(override)
    bankCache.set(id, data)
    return data
  }
  const manifest = await loadManifest()
  const meta = manifest.Banks.find((b) => b.id === id)
  if (!meta) throw new Error(`题库不存在：${id}`)
  // 静态 JSON 与导入文件同源风险，一律规整后再缓存
  const data = await parseBankJsonWithProgress(`${base()}data/banks/${meta.bankFile}`, onProgress)
  bankCache.set(id, data)
  return data
}

/**
 * 保存题库（元信息 + 数据），题库存档写入 IndexedDB。
 *
 * 写失败（IDB 不可用且 localStorage 配额也溢出）时**必须抛出**：
 * 调用方此前都忽略写入结果，导致存不下时界面照常提示"已保存"，
 * 用户以为成功却在刷新后丢失全部编辑。
 */
export async function saveBank(meta: BankMeta, data: BankData): Promise<void> {
  const finalMeta: BankMeta = { ...meta, questionCount: data.Questions.length }
  const fail = (): never => {
    throw new Error('题库未保存：本地数据库不可用且浏览器存储空间不足。请先在「设置」导出备份，再清理缓存。')
  }
  if (!(await writeBankData(meta.id, data))) fail()
  bankCache.set(meta.id, data)
  const local = storage.readJSON<BankMeta[]>(K_LOCAL_BANKS, [])
  const idx = local.findIndex((b) => b.id === meta.id)
  if (idx >= 0) {
    local[idx] = finalMeta
    if (!storage.writeJSON(K_LOCAL_BANKS, local)) fail()
  } else if (finalMeta.local) {
    local.push(finalMeta)
    if (!storage.writeJSON(K_LOCAL_BANKS, local)) fail()
  } else if (!storage.writeJSON(K_BANK_META + meta.id, finalMeta)) {
    fail()
  }
  manifestCache = null
}

export function defaultRule(): BankRule {
  return {
    durationMinutes: 60,
    totalScore: 100,
    passScore: 60,
    composition: []
  }
}

/** 新建题库（名称自动转拼音生成唯一 id），数据初始为空 */
export async function createBank(name: string, rule: BankRule): Promise<BankMeta> {
  const manifest = await loadManifest()
  // nameToBankId 内部动态加载拼音字典（约 300KB），不占用首屏
  const id = uniqueBankId(await nameToBankId(name), manifest.Banks.map((b) => b.id))
  const meta: BankMeta = {
    id,
    name,
    bankFile: `${id}.json`,
    questionCount: 0,
    rule,
    local: true
  }
  await saveBank(meta, { Questions: [], Papers: [] })
  return meta
}

/** 删除题库（内置题库记入删除名单，本地题库直接移除；同时清理数据与覆盖层） */
export async function deleteBank(id: string): Promise<void> {
  const manifest = await loadManifest()
  const meta = manifest.Banks.find((b) => b.id === id)
  await idbDelete(storage.fullKey(K_BANK_DATA + id))
  storage.removeKey(K_BANK_DATA + id)
  storage.removeKey(K_BANK_META + id)
  if (meta?.local) {
    const local = storage.readJSON<BankMeta[]>(K_LOCAL_BANKS, []).filter((b) => b.id !== id)
    storage.writeJSON(K_LOCAL_BANKS, local)
  } else if (meta) {
    const deleted = storage.readJSON<string[]>(K_DELETED_BANKS, [])
    if (!deleted.includes(id)) deleted.push(id)
    storage.writeJSON(K_DELETED_BANKS, deleted)
  }
  bankCache.delete(id)
  manifestCache = null
}

/** 导出单个题库为 JSON 文件（含名称与组卷规则，可再导入） */
export function exportBankFile(meta: BankMeta, data: BankData): void {
  const payload = {
    name: meta.name,
    rule: meta.rule,
    Questions: data.Questions,
    Papers: data.Papers
  }
  downloadJson(payload, `${meta.name || meta.id}.json`)
}

/** 导出整包备份（localStorage + IndexedDB 中的全部 quizor: 数据） */
export async function exportBackup(): Promise<void> {
  const payload = await storage.exportBackup()
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  downloadJson(payload, `quizor-backup-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}.json`)
}

function downloadJson(payload: unknown, filename: string): void {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}
