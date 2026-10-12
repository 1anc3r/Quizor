/**
 * 答题会话服务：组卷、断点续答（防抖落盘 + 强制落盘）、判分。
 *
 * 落盘形态与会话形态不同：localStorage 里只存题目的 id/分值/题型/章节/难度
 * （见 StoredQuizSession），题干等内容在恢复时按 id 从题库回填（hydrateSession）。
 * 原因：整题落盘会让"练习 · 全部"这种会话等于整份题库的副本，单条就撑爆配额。
 *
 * 组卷 / 判分的**纯计算**本体在 services/quizCompute.ts（Worker 安全、分片异步），
 * 这里原样转出口，调用方 import 路径不变；要 Worker 异步执行时走
 * services/quizWorkerApi.ts（见 quizWorker.ts 的说明）。
 */
import type {
  Question,
  QuizSession,
  SessionQuestion,
  StoredQuizSession
} from '@/types'
import * as storage from '../services/storage'

export {
  shuffle,
  isChoiceCorrect,
  answerToText,
  correctToText,
  buildPracticeQuestions,
  buildExamQuestions,
  makeSession,
  gradeSession,
  recomputeRecord
} from '../services/quizCompute'

const K_SESSION = 'session:' // + sessionId → StoredQuizSession
const K_UNFINISHED = 'unfinished:' // + bankId → sessionId

/* ---------------- 持久化 ---------------- */

/**
 * 内存会话 → 落盘形态：只留恢复所需的 id / 分值 / 题型 / 章节 / 难度。
 *
 * 题干、选项、解析（可能内嵌 base64 图片）不进 localStorage：一条
 * "880 题 · 练习全部" 的会话曾经等于整份题库的副本（实测 3,186,709 字符 ≈ 6.4MB），
 * 单条就超过 SOFT_BUDGET_CHARS 与 localStorage 约 5MB 的硬配额，永远写不进去；
 * 只留 id/分值后同一会话为 149,454 字符，任何题库规模都能落盘。
 */
function toStoredSession(s: QuizSession): StoredQuizSession {
  return {
    ...s,
    questions: s.questions.map((q) => ({
      id: q.id,
      score: q.score,
      type: q.type,
      chapter: q.chapter,
      difficulty: q.difficulty
    }))
  }
}

export function saveSession(s: QuizSession): void {
  s.updatedAt = Date.now()
  storage.writeJSON(K_SESSION + s.id, toStoredSession(s))
}

let debounceTimer: number | null = null
let debouncedSession: QuizSession | null = null

/** 会话变更防抖 300ms 落盘 */
export function persistSessionDebounced(s: QuizSession): void {
  debouncedSession = s
  if (debounceTimer !== null) window.clearTimeout(debounceTimer)
  debounceTimer = window.setTimeout(() => {
    debounceTimer = null
    if (debouncedSession) saveSession(debouncedSession)
    debouncedSession = null
  }, 300)
}

/** 强制落盘（beforeunload / 路由离开时调用） */
export function flushSession(): void {
  if (debounceTimer !== null) {
    window.clearTimeout(debounceTimer)
    debounceTimer = null
  }
  if (debouncedSession) {
    saveSession(debouncedSession)
    debouncedSession = null
  }
}

/** 读取落盘形态的会话：题目内容还没回填，必须先过 hydrateSession 再渲染 */
export function loadStoredSession(id: string): StoredQuizSession | null {
  return storage.readJSON<StoredQuizSession | null>(K_SESSION + id, null)
}

export interface HydrateResult {
  /** 题目内容已补齐、可直接渲染与判分的会话 */
  session: QuizSession
  /** 题库里已不存在、因而被移出会话的题目 id */
  missing: string[]
}

/**
 * 用题库内容回填会话题目（断点续答的必经一步）：题目以题库当前版本为准，
 * 题库里没有的题目（已删除/题库被替换）计入 missing 并移出会话，
 * 再按剩余题目重算总分，避免"继续上次答题"卡在已经不存在的题上。
 */
export function hydrateSession(s: StoredQuizSession, questions: Question[]): HydrateResult {
  const map = new Map(questions.map((q) => [q.id, q] as const))
  const out: SessionQuestion[] = []
  const missing: string[] = []
  for (const sq of s.questions) {
    const content = map.get(sq.id)
    if (!content) {
      missing.push(sq.id)
      continue
    }
    out.push({ ...content, score: sq.score })
  }
  const totalScore = out.reduce((sum, q) => sum + q.score, 0)
  // currentIndex 可能指向已被移出的题目，收敛到合法范围
  const currentIndex = out.length ? Math.min(s.currentIndex, out.length - 1) : 0
  return { session: { ...s, questions: out, currentIndex, totalScore }, missing }
}

export function removeSession(id: string): void {
  storage.removeKey(K_SESSION + id)
}

/** 读取未完成会话指针（兼容历史双重 JSON 编码数据） */
function readUnfinishedId(bankId: string): string | null {
  let id = storage.readJSON<string | null>(K_UNFINISHED + bankId, null)
  if (typeof id === 'string' && id.startsWith('"')) {
    try {
      id = JSON.parse(id) as string
    } catch {
      /* 保持原值 */
    }
  }
  return id
}

/** 记录/查询某题库的未完成会话（首页"继续上次答题"） */
export function setUnfinished(bankId: string, sessionId: string | null): void {
  const prev = storage.readJSON<string | null>(K_UNFINISHED + bankId, null)
  // 换新会话时顺手回收被替换的旧会话，避免它变成永远无人引用的孤儿数据
  if (prev && prev !== sessionId) removeSession(prev)
  if (sessionId) storage.writeJSON(K_UNFINISHED + bankId, sessionId)
  else storage.removeKey(K_UNFINISHED + bankId)
}

/* ---------------- 会话垃圾回收 ---------------- */

/** 超过该天数未更新的会话视为超龄 */
export const SESSION_MAX_AGE_DAYS = 7

/**
 * 找出可回收的会话 key：不被任何题库的"继续上次答题"指针引用（无主），
 * 或最后更新时间超过 maxAgeDays（超龄）。返回的 key 不含 PREFIX，可直接传给 removeKey。
 */
export function findStaleSessions(maxAgeDays = SESSION_MAX_AGE_DAYS): string[] {
  const alive = new Set<string>()
  for (const key of storage.keysWithPrefix(K_UNFINISHED)) {
    // 必须与 getUnfinished 走同一套解析（readUnfinishedId 兼容历史双重 JSON 编码），
    // 否则双重编码的指针匹配不上任何会话，会把正在使用的会话误判为孤儿并删除
    const id = readUnfinishedId(key.slice(K_UNFINISHED.length))
    if (id) alive.add(id)
  }
  const cutoff = Date.now() - maxAgeDays * 86_400_000
  const stale: string[] = []
  for (const key of storage.keysWithPrefix(K_SESSION)) {
    const s = storage.readJSON<StoredQuizSession | null>(key, null)
    // 损坏/字段缺失（时间戳非法）的会话一并回收
    const updated = s ? Number(s.updatedAt ?? s.createdAt) || 0 : 0
    if (!s || !updated || !alive.has(s.id) || updated < cutoff) stale.push(key)
  }
  return stale
}

/** 回收无主/超龄会话，返回清理条数 */
export function gcSessions(maxAgeDays = SESSION_MAX_AGE_DAYS): number {
  const stale = findStaleSessions(maxAgeDays)
  stale.forEach((key) => storage.removeKey(key))
  return stale.length
}

/**
 * 用新会话替换未完成会话指针：同时删除被替换的旧会话数据，
 * 避免 orphan session 在 localStorage 中越积越多撑爆配额。
 */
export function replaceUnfinished(bankId: string, sessionId: string): void {
  const prev = readUnfinishedId(bankId)
  if (prev && prev !== sessionId) removeSession(prev)
  setUnfinished(bankId, sessionId)
}

/** 清理孤儿会话：删除所有未被任何 unfinished 指针引用的 session:* 数据，返回释放的条数 */
export function pruneOrphanSessions(): number {
  const referenced = new Set<string>()
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i)
    if (k && k.startsWith(storage.PREFIX + K_UNFINISHED)) {
      const bankId = k.slice((storage.PREFIX + K_UNFINISHED).length)
      const id = readUnfinishedId(bankId)
      if (id) referenced.add(id)
    }
  }
  const orphans: string[] = []
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i)
    if (k && k.startsWith(storage.PREFIX + K_SESSION)) {
      const id = k.slice((storage.PREFIX + K_SESSION).length)
      if (!referenced.has(id)) orphans.push(id)
    }
  }
  orphans.forEach(removeSession)
  return orphans.length
}

/**
 * 读取未完成会话（落盘形态，题目内容未回填）。
 * 页码/进度类展示只需 id 与题目数量，真正答题前由 QuizView 走 hydrateSession 回填内容。
 */
export function getUnfinished(bankId: string): StoredQuizSession | null {
  const id = readUnfinishedId(bankId)
  if (!id) return null
  const s = loadStoredSession(id)
  if (!s) {
    storage.removeKey(K_UNFINISHED + bankId)
    return null
  }
  return s
}

