/**
 * localStorage 统一封装，所有 key 带 quizor: 前缀。
 * 用户数据（答题记录、错题、收藏、设置、会话、本地题库）全部经由此模块读写。
 */
export const PREFIX = 'quizor:'

export function readJSON<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(PREFIX + key)
    if (raw === null) return fallback
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

export function writeJSON(key: string, value: unknown): void {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value))
  } catch (e) {
    // 容量溢出等场景：控制台告警，避免应用崩溃
    console.error('[quizor] localStorage 写入失败:', key, e)
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
