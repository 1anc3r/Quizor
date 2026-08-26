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
import type { BankData, BankManifest, BankMeta, BankRule } from '@/types'
import * as storage from './storage'
import { nameToBankId, uniqueBankId } from '../utils/pinyin'

const K_LOCAL_BANKS = 'localbanks' // BankMeta[] 用户本地新增的题库
const K_DELETED_BANKS = 'deletedbanks' // string[] 被删除的内置题库 id
const K_BANK_DATA = 'bankdata:' // + id → BankData（内置题库的编辑覆盖层 / 本地题库数据）
const K_BANK_META = 'bankmeta:' // + id → BankMeta（内置题库元信息的编辑覆盖层）

let manifestCache: BankManifest | null = null
const bankCache = new Map<string, BankData>()

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

/** 加载题库数据：本地覆盖层优先，其次 fetch 静态 JSON；带内存缓存 */
export async function loadBank(id: string, force = false): Promise<BankData> {
  if (!force && bankCache.has(id)) return bankCache.get(id) as BankData
  const override = storage.readJSON<BankData | null>(K_BANK_DATA + id, null)
  if (override) {
    bankCache.set(id, override)
    return override
  }
  const manifest = await loadManifest()
  const meta = manifest.Banks.find((b) => b.id === id)
  if (!meta) throw new Error(`题库不存在：${id}`)
  const res = await fetch(`${base()}data/banks/${meta.bankFile}`)
  if (!res.ok) throw new Error(`题库文件加载失败：${meta.bankFile}`)
  const data = (await res.json()) as BankData
  if (!Array.isArray(data.Questions)) data.Questions = []
  if (!Array.isArray(data.Papers)) data.Papers = []
  bankCache.set(id, data)
  return data
}

/** 保存题库（元信息 + 数据），写入 localStorage 覆盖层/本地题库 */
export async function saveBank(meta: BankMeta, data: BankData): Promise<void> {
  const finalMeta: BankMeta = { ...meta, questionCount: data.Questions.length }
  storage.writeJSON(K_BANK_DATA + meta.id, data)
  bankCache.set(meta.id, data)
  const local = storage.readJSON<BankMeta[]>(K_LOCAL_BANKS, [])
  const idx = local.findIndex((b) => b.id === meta.id)
  if (idx >= 0) {
    local[idx] = finalMeta
    storage.writeJSON(K_LOCAL_BANKS, local)
  } else if (finalMeta.local) {
    local.push(finalMeta)
    storage.writeJSON(K_LOCAL_BANKS, local)
  } else {
    storage.writeJSON(K_BANK_META + meta.id, finalMeta)
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
