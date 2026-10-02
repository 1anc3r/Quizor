/**
 * 题库数据服务。
 *
 * 题库与应用代码分离：内置题库 JSON 放在 public/data/ 下，运行时 fetch 加载；
 * 用户在浏览器内对题库的编辑、以及新增的题库，全部以 localStorage 覆盖层/本地题库
 * 的形式保存，从而实现"纯静态 + 可编辑"。
 *
 * 加载顺序：BankManifest 先加载（并与本地新增/删除记录合并），科目题库懒加载 + 内存缓存。
 * 新增科目只需向 public/data/banks/ 添加文件并在 BankManifest.json 登记，无需改代码。
 */
import type { BankData, BankManifest, BankMeta, BankRule, OptionItem, Paper, Question, QuestionType } from '@/types'
import * as storage from './storage'
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

/** 加载题库数据：本地覆盖层优先，其次 fetch 静态 JSON；带内存缓存 */
export async function loadBank(id: string, force = false): Promise<BankData> {
  if (!force && bankCache.has(id)) return bankCache.get(id) as BankData
  const override = storage.readJSON<BankData | null>(K_BANK_DATA + id, null)
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
 * 保存题库（元信息 + 数据），写入 localStorage 覆盖层/本地题库。
 *
 * 写失败（典型原因：localStorage 配额溢出）时**必须抛出**：
 * `storage.writeJSON` 只返回 boolean，此前所有调用方都忽略了它，
 * 导致配额爆掉时界面照常提示"已保存"，用户以为成功却在刷新后丢失全部编辑。
 */
export async function saveBank(meta: BankMeta, data: BankData): Promise<void> {
  const finalMeta: BankMeta = { ...meta, questionCount: data.Questions.length }
  const fail = (): never => {
    throw new Error('本地存储空间不足，题库未保存。请先在「设置」导出备份，再清理缓存。')
  }
  if (!storage.writeJSON(K_BANK_DATA + meta.id, data)) fail()
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

/** 导出整包备份（localStorage 中全部 quizor: 数据） */
export function exportBackup(): void {
  const payload = storage.exportBackup()
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
