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
 * - **全文**（原始题库 JSON，约 6MB）：含题干富文本、选项、答案、解析、内嵌图片，
 *   只有真正要答题/组卷/浏览详情时才加载。
 * 托管方会给静态 JSON 加 gzip（6MB → 约 1.2MB），首屏省下的仍是"下载 + 解析 + 常驻内存"，
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
/** 正在飞行的全文加载，按题库 id 去重（同一题库被多个页面同时要求时只发一次请求） */
const inflight = new Map<string, Promise<BankData>>()

/**
 * 覆盖层存档：题库数据 + 写入时间戳。
 *
 * `ts` 由 `writeBankData` 随数据一起写入，只用于标记"这份数据是什么时候存的"。
 * 注意它与"索引是否最新"是两件事，不要互相替代（见 `loadBankIndex` / `loadBankUncached`）。
 */
interface BankOverride {
  data: BankData
  /** 旧格式存档（以及手工改过的备份）没有该字段，按 0 计 */
  ts: number
}

const base = () => import.meta.env.BASE_URL

/**
 * 规整清单项，并用内置清单兜住缺失字段。
 *
 * 元信息覆盖层是**历史遗留数据**：用户在上一个版本里保存过的题库，
 * 其 `meta` 可能是照着当时的结构写的，未必带 `bankFile`。
 * 覆盖层整体取代内置项会造成两个后果，所以这里逐字段合并：
 * - `bankFile` 丢失 → 拼出 `data/banks/undefined` 这种请求，404 页面还会被当成 JSON 解析；
 * - `name`/`rule` 丢失 → 界面直接不显示题库名、组卷规则回落到默认值。
 */
function mergeMeta(builtin: BankMeta, override: BankMeta | null): BankMeta {
  if (!override) return builtin
  return {
    ...builtin,
    ...override,
    // 这两个字段缺了就彻底不可用，不允许被覆盖层清空
    id: override.id || builtin.id,
    bankFile: override.bankFile || builtin.bankFile
  }
}

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
    .map((b) => mergeMeta(b, storage.readJSON<BankMeta | null>(K_BANK_META + b.id, null)))
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
    // 全文解压后的字节数（构建期写入），下载进度的分母靠它 —— 新字段必须显式搬运，
    // 否则白名单式构造会把它丢掉，运行时又退化成"拿压缩后的 Content-Length 当分母"
    fullSize: typeof r.fullSize === 'number' && r.fullSize > 0 ? r.fullSize : undefined,
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
 *
 * **本地题库（导入/新建）必须走这条派生路径**：静态索引是构建期按
 * `public/data/BankManifest.json` 逐个生成的，本地题库不在其中，
 * 去 fetch `data/banks/<本地id>_index.json` 只会拿到 404（静态托管开了 SPA 回退时
 * 还会拿到 200 + index.html，再被 `res.json()` 解析失败）—— 现象就是
 * "从设置页导入题库后，一切换过去就提示「题库索引加载失败」"。
 */
export async function loadBankIndex(id: string, force = false): Promise<BankIndex | null> {
  if (!force && indexCache.has(id)) return indexCache.get(id) as BankIndex
  const manifest = await loadManifest()
  const meta = manifest.Banks.find((b) => b.id === id)
  if (!meta) return null

  // 覆盖层的读取必须走 readBankData（IndexedDB 优先），不能只看 localStorage：
  // writeBankData 写成功后就删掉了 localStorage 副本，只查 localStorage 会得出
  // "没有覆盖层"的错误结论，本地题库于是完全没有索引可用。
  const override = await readBankData(id)
  if (override) {
    const index = deriveIndex(meta, normalizeBankData(override.data), override.ts)
    indexCache.set(id, index)
    return index
  }

  try {
    // bankFile 缺失时拼出来的是 `/undefined`，而静态托管（含 dev server 的 SPA 回退）
    // 会拿 index.html 以 200 应答，于是"HTML 当 JSON 解析"失败被反复重试。
    // 这里直接认定索引不可用，交给调用方决定是否拉全文。
    if (!meta.bankFile) {
      console.warn('[quizor] 题库缺少 bankFile，跳过索引请求：', id)
      return null
    }
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

/* ---------------- 题库存档的读写（IndexedDB 优先） ---------------- */

/**
 * 读取覆盖层存档：IndexedDB 优先，其次 localStorage 里的历史覆盖层。
 * 命中历史数据时顺手迁进 IDB（读回校验通过才删除源数据）。
 *
 * **两层都要查，这是本地题库能否显示的关键**：`writeBankData` 一旦成功写进 IDB
 * 就会删掉 localStorage 副本，只查 localStorage 会得到"没有覆盖层"的结论，
 * 而本地题库的全部数据恰恰只存在于这里（没有静态文件可退）。
 *
 * 返回 `{ data, ts }` 而不是裸数据：时间戳与数据同源，就地取出，
 * 免得调用方为了拿 `ts` 再解析一遍几 MB 的 JSON 字符串。
 */
async function readBankData(id: string): Promise<BankOverride | null> {
  const key = storage.fullKey(K_BANK_DATA + id)
  const fromIdb = await idbGetRaw(key)
  if (fromIdb !== null) {
    const stored = parseOverride(fromIdb)
    if (stored) return stored
    console.warn('[quizor] IndexedDB 中的题库数据损坏，回退 localStorage：', key)
  }
  const legacy = storage.readRaw(K_BANK_DATA + id)
  if (legacy === null) return null
  const stored = parseOverride(legacy)
  if (!stored) {
    console.warn('[quizor] localStorage 中的题库数据损坏：', key)
    return null
  }
  if ((await idbSetRaw(key, legacy)) && (await idbGetRaw(key)) === legacy) {
    storage.removeKey(K_BANK_DATA + id)
  }
  return stored
}

/** 解析覆盖层存档，附带取出时间戳；内容不是合法 JSON 时返回 null */
function parseOverride(raw: string): BankOverride | null {
  try {
    const parsed = JSON.parse(raw) as BankData & { ts?: unknown }
    return { data: parsed, ts: typeof parsed.ts === 'number' ? parsed.ts : 0 }
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
  // 存档带上时间戳：与数据同源，读回时一并取出（见 parseOverride），供派生索引标记来源
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
  if (!force && bankCache.has(id)) return (await bankCache.get(id)) as BankData
  // 首页预取、设置页导出、组卷页、结果页都会在相近时刻要同一题库：
  // 不去重就会有多次 6MB 请求同时压在身上。
  const pending = inflight.get(id)
  if (pending) return pending
  const task = loadBankUncached(id, index, onProgress)
  inflight.set(id, task)
  try {
    return await task
  } finally {
    // 失败时不能留在 inflight 里，否则后续请求会一直拿到同一个已失败的 Promise
    if (inflight.get(id) === task) inflight.delete(id)
  }
}

async function loadBankUncached(
  id: string,
  index: BankIndex | null | undefined,
  onProgress: LoadProgress | undefined
): Promise<BankData> {
  // 有覆盖层就必须用它：内置题库的静态 JSON 是构建期版本，拿它当全文会把用户的编辑
  // 悄悄回退掉；本地题库则根本没有静态文件可退。
  //
  // 这里不能拿"索引是否最新"来决定要不要读覆盖层 —— 索引只是个派生摘要，
  // 它是否最新与"全文该从哪来"是两回事。早先正是这样判的（indexIsCurrent），
  // 于是 IDB 不可用（隐私模式）时覆盖层只落在 localStorage、派生索引的 ts 又恰好与之相等，
  // 全文反而被送去请求一个不存在的静态地址，本地题库直接打不开。
  const override = await readBankData(id)
  if (override) {
    const data = normalizeBankData(override.data)
    bankCache.set(id, data)
    return data
  }
  const manifest = await loadManifest()
  const meta = manifest.Banks.find((b) => b.id === id)
  if (!meta) throw new Error(`题库不存在：${id}`)
  // 早失败：bankFile 缺失时拼出的是 `/undefined`，SPA 静态托管会以 200 返回 index.html，
  // 那会被当成 JSON 解析失败，用户只看到"题库加载失败"却无从判断真实原因。
  if (!meta.bankFile) throw new Error(`题库元信息缺少文件名（bankFile），无法加载：${meta.name || id}`)
  // 静态 JSON 与导入文件同源风险，一律规整后再缓存
  // 传入索引里的 fullSize：托管方压缩传输时，下载进度的分母只能是构建期记下的解压后体积
  const data = await parseBankJsonWithProgress(
    `${base()}data/banks/${meta.bankFile}`,
    onProgress,
    index?.fullSize
  )
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
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  a.remove()
  // 立即 revoke 会让还没开始读取的浏览器拿不到数据（备份文件动辄数 MB），延后一拍更稳
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}
