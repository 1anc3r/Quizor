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
 * 加载顺序：BankManifest 先加载（并与本地新增/删除记录合并），科目题库懒加载 + 内存缓存。
 * 新增科目只需向 public/data/banks/ 添加文件并在 BankManifest.json 登记，无需改代码。
 */
import type { BankData, BankManifest, BankMeta, BankRule, OptionItem, Paper, Question, QuestionType } from '@/types'
import * as storage from './storage'
import { idbDelete, idbGetRaw, idbKeys, idbSetRaw } from './idb'
import { nameToBankId, uniqueBankId } from '../utils/pinyin'

const K_LOCAL_BANKS = 'localbanks' // BankMeta[] 用户本地新增的题库
const K_DELETED_BANKS = 'deletedbanks' // string[] 被删除的内置题库 id
const K_BANK_DATA = 'bankdata:' // + id → BankData（内置题库的编辑覆盖层 / 本地题库数据）
const K_BANK_META = 'bankmeta:' // + id → BankMeta（内置题库元信息的编辑覆盖层）

const QUESTION_TYPES: QuestionType[] = ['single', 'multiple', 'judge', 'text']

let manifestCache: BankManifest | null = null
const bankCache = new Map<string, BankData>()

const base = () => import.meta.env.BASE_URL

/**
 * 把来源不可信的题目数组规整为合法 `Question`。
 *
 * 内置题库文件、用户导入的题库、备份文件都可能字段缺失或类型错误
 * （例如缺 `options`、`difficulty` 是字符串、`id` 重复），
 * 直接使用会在渲染与判分环节抛出异常，因此统一补默认值后放行。
 * 题干为空的条目无法作答，直接丢弃。
 */
export function normalizeQuestions(raw: unknown): Question[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const out: Question[] = []

  raw.forEach((item, i) => {
    if (!item || typeof item !== 'object') return
    const q = item as Partial<Question>
    const stem = typeof q.stem === 'string' ? q.stem : ''
    if (!stem.trim()) return

    let id = typeof q.id === 'string' && q.id ? q.id : `imported_${i + 1}`
    if (seen.has(id)) {
      let n = 2
      while (seen.has(`${id}_${n}`)) n++
      id = `${id}_${n}`
    }
    seen.add(id)

    const type: QuestionType = QUESTION_TYPES.includes(q.type as QuestionType)
      ? (q.type as QuestionType)
      : 'single'
    const options: OptionItem[] = Array.isArray(q.options)
      ? q.options
          .filter((o): o is OptionItem => !!o && typeof o === 'object')
          .map((o, oi) => ({
            key: typeof o.key === 'string' && o.key ? o.key : String.fromCharCode(65 + oi),
            text: typeof o.text === 'string' ? o.text : ''
          }))
      : []
    const difficulty =
      typeof q.difficulty === 'number' && Number.isFinite(q.difficulty)
        ? Math.min(5, Math.max(1, Math.round(q.difficulty)))
        : 3

    out.push({
      id,
      type,
      chapter: typeof q.chapter === 'string' ? q.chapter : '',
      difficulty,
      stem,
      options,
      answer: Array.isArray(q.answer) ? q.answer.filter((k): k is string => typeof k === 'string') : [],
      analysis: typeof q.analysis === 'string' ? q.analysis : '',
      source: typeof q.source === 'string' ? q.source : '',
      tags: Array.isArray(q.tags) ? q.tags.filter((t): t is string => typeof t === 'string') : []
    })
  })

  return out
}

/** 规整一整个 BankData（题目 + 试卷），所有读取路径都要经过它 */
function normalizeBankData(raw: unknown): BankData {
  const r = (raw ?? {}) as Partial<BankData>
  const papers: Paper[] = Array.isArray(r.Papers)
    ? r.Papers
        .filter((p): p is Paper => !!p && typeof p === 'object' && typeof p.id === 'string')
        .map((p) => ({
          ...p,
          name: typeof p.name === 'string' ? p.name : '',
          source: typeof p.source === 'string' ? p.source : '',
          difficulty: typeof p.difficulty === 'number' ? p.difficulty : 3,
          questionIds: Array.isArray(p.questionIds) ? p.questionIds.filter((x): x is string => typeof x === 'string') : []
        }))
    : []
  return { Questions: normalizeQuestions(r.Questions), Papers: papers }
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
    .map((b) => storage.readJSON<BankMeta | null>(K_BANK_META + b.id, null) ?? b)
  manifestCache = { Banks: [...banks, ...local] }
  return manifestCache
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
  if (await idbSetRaw(key, JSON.stringify(data))) {
    // 清掉可能残留的 localStorage 覆盖层，否则两处内容会不一致
    storage.removeKey(K_BANK_DATA + id)
    return true
  }
  return storage.writeJSON(K_BANK_DATA + id, data)
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

/** 加载题库数据：本地覆盖层优先，其次 fetch 静态 JSON；带内存缓存 */
export async function loadBank(id: string, force = false): Promise<BankData> {
  if (!force && bankCache.has(id)) return bankCache.get(id) as BankData
  const override = await readBankData(id)
  if (override) {
    const data = normalizeBankData(override)
    bankCache.set(id, data)
    return data
  }
  const manifest = await loadManifest()
  const meta = manifest.Banks.find((b) => b.id === id)
  if (!meta) throw new Error(`题库不存在：${id}`)
  const res = await fetch(`${base()}data/banks/${meta.bankFile}`)
  if (!res.ok) throw new Error(`题库文件加载失败：${meta.bankFile}`)
  // 静态 JSON 与导入文件同源风险，一律规整后再缓存
  const data = normalizeBankData(await res.json())
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
  const id = uniqueBankId(nameToBankId(name), manifest.Banks.map((b) => b.id))
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
