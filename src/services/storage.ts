/**
 * localStorage 统一封装，所有 key 带 quizor: 前缀。
 * 用户数据（答题记录、错题、收藏、设置、会话、本地题库）全部经由此模块读写。
 *
 * 容量控制：localStorage 的配额由浏览器决定（同源通常 5MB 量级，按 UTF-16 计），
 * 代码无法扩容，只能"写入前判预算 + 占用可观测 + 溢出显式返回失败"。
 */
export const PREFIX = 'quizor:'

/**
 * 软预算（字符数）。localStorage 按 UTF-16 计，字符数 × 2 ≈ 字节数，
 * 因此 2_000_000 字符 ≈ 4MB，为同源其它数据留出余量，避免撞上浏览器硬配额。
 */
export const SOFT_BUDGET_CHARS = 2_000_000

/** 只有达到该字符数的写入才做预算预检，避免小写入每次全量扫描 localStorage */
export const BUDGET_CHECK_THRESHOLD_CHARS = 64 * 1024

/** 单条 key 的占用统计 */
export interface UsageEntry {
  /** 完整的 localStorage key（含 PREFIX） */
  key: string
  /** key + value 的总字符数 */
  chars: number
}

export interface Usage {
  /** 全部 quizor: 数据的字符数合计 */
  chars: number
  /** 近似字节数（chars × 2） */
  bytes: number
  /** 按占用降序排列的全部条目 */
  keys: UsageEntry[]
}

export function readJSON<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(PREFIX + key)
    if (raw === null) return fallback
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

/** 列出带指定业务前缀的 key（**不含** PREFIX，可直接传给 readJSON/removeKey） */
export function keysWithPrefix(businessPrefix: string): string[] {
  const full = PREFIX + businessPrefix
  const out: string[] = []
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i)
    if (k && k.startsWith(full)) out.push(k.slice(PREFIX.length))
  }
  return out
}

/** 统计 quizor: 前缀数据的占用情况（用于设置页展示与写入前预算校验） */
export function usage(): Usage {
  const keys: UsageEntry[] = []
  let chars = 0
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i)
    if (!k || !k.startsWith(PREFIX)) continue
    const n = k.length + (localStorage.getItem(k)?.length ?? 0)
    chars += n
    keys.push({ key: k, chars: n })
  }
  keys.sort((a, b) => b.chars - a.chars)
  return { chars, bytes: chars * 2, keys }
}

/**
 * 写入被拒（超出软预算或浏览器硬配额）时派发的事件名。
 * storage 本身不依赖 UI 框架，由 App.vue 监听并提示用户，避免"以为已保存"。
 */
export const EVENT_STORAGE_FULL = 'quizor:storage-full'

export interface StorageFullDetail {
  key: string
  /** 本次写入所需字符数 */
  need: number
  /** 写入前的剩余可用字符数（硬配额失败时为 0） */
  available: number
}

function notifyStorageFull(detail: StorageFullDetail): void {
  try {
    window.dispatchEvent(new CustomEvent<StorageFullDetail>(EVENT_STORAGE_FULL, { detail }))
  } catch {
    /* 非浏览器环境忽略 */
  }
}

/**
 * 写入 JSON。
 * 大对象先与软预算比对；超预算或浏览器抛 QuotaExceededError 时返回 false 并派发
 * EVENT_STORAGE_FULL，由 UI 层提示用户（不再像以前那样静默丢数据）。
 * @returns 是否写入成功
 */
export function writeJSON(key: string, value: unknown): boolean {
  const full = PREFIX + key
  let raw: string
  try {
    raw = JSON.stringify(value)
  } catch (e) {
    console.error('[quizor] 数据序列化失败:', key, e)
    return false
  }
  // 小对象（设置、收藏、错题、指针等）跳过预检：避免每次写入都全量扫描 localStorage，
  // 它们也无法单次撑爆预算，真到极限由下面的硬配额兜底。
  if (raw.length >= BUDGET_CHECK_THRESHOLD_CHARS) {
    const prev = localStorage.getItem(full)
    // 本次写入后的预估占用（先扣除该 key 的旧值）
    const used = usage().chars - (prev === null ? 0 : prev.length + full.length)
    const available = Math.max(0, SOFT_BUDGET_CHARS - used)
    if (raw.length > available) {
      console.warn(`[quizor] 超出存储软预算，已跳过写入：${key} 需要 ${raw.length} 字符，可用 ${available} 字符`)
      notifyStorageFull({ key, need: raw.length, available })
      return false
    }
  }
  try {
    localStorage.setItem(full, raw)
    return true
  } catch (e) {
    // 容量溢出等场景：控制台告警 + 通知 UI，避免应用崩溃
    console.error('[quizor] localStorage 写入失败:', key, e)
    notifyStorageFull({ key, need: raw.length, available: 0 })
    return false
  }
}

export function removeKey(key: string): void {
  localStorage.removeItem(PREFIX + key)
}

/** 导出全站应用数据（备份） */
export function exportBackup(): Record<string, unknown> {
  const data: Record<string, unknown> = {}
  for (let i = 0; i < localStorage.length; i++) {
    const fullKey = localStorage.key(i)
    if (fullKey && fullKey.startsWith(PREFIX)) {
      try {
        data[fullKey] = JSON.parse(localStorage.getItem(fullKey) as string)
      } catch {
        /* 跳过损坏项 */
      }
    }
  }
  return data
}

/** 恢复全站备份（整体覆盖 quizor: 前缀的数据） */
export function importBackup(data: Record<string, unknown>): void {
  for (const [k, v] of Object.entries(data)) {
    if (k.startsWith(PREFIX)) {
      try {
        localStorage.setItem(k, JSON.stringify(v))
      } catch (e) {
        console.warn('[quizor] 备份导入失败：', k, e)
      }
    }
  }
}

/** 清理缓存：移除 localStorage 中全部 quizor: 前缀的应用数据 */
export function clearAll(): void {
  const keys: string[] = []
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i)
    if (k && k.startsWith(PREFIX)) keys.push(k)
  }
  keys.forEach((k) => localStorage.removeItem(k))
}
