/**
 * 答题会话服务：组卷、断点续答（防抖落盘 + 强制落盘）、判分。
 */
import type {
  AnswerState,
  BankData,
  BankRule,
  ExamConfig,
  PracticeConfig,
  Question,
  QuizMode,
  QuizRecord,
  QuizSession,
  RecordDetail,
  SessionQuestion
} from '@/types'
import * as storage from '../services/storage'
import { genId } from '@/utils/id'

const K_SESSION = 'session:' // + sessionId → QuizSession
const K_UNFINISHED = 'unfinished:' // + bankId → sessionId

/* ---------------- 持久化 ---------------- */

export function saveSession(s: QuizSession): void {
  s.updatedAt = Date.now()
  storage.writeJSON(K_SESSION + s.id, s)
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

export function loadSession(id: string): QuizSession | null {
  return storage.readJSON<QuizSession | null>(K_SESSION + id, null)
}

export function removeSession(id: string): void {
  storage.removeKey(K_SESSION + id)
}

/** 记录/查询某题库的未完成会话（首页"继续上次答题"） */
export function setUnfinished(bankId: string, sessionId: string | null): void {
  if (sessionId) storage.writeJSON(K_UNFINISHED + bankId, sessionId)
  else storage.removeKey(K_UNFINISHED + bankId)
}

export function getUnfinished(bankId: string): QuizSession | null {
  const id = storage.readJSON<string | null>(K_UNFINISHED + bankId, null)
  if (!id) return null
  const s = loadSession(id)
  if (!s) {
    storage.removeKey(K_UNFINISHED + bankId)
    return null
  }
  return s
}

/* ---------------- 判分工具 ---------------- */

export function shuffle<T>(arr: T[]): T[] {
  const r = [...arr]
  for (let i = r.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[r[i], r[j]] = [r[j], r[i]]
  }
  return r
}

export function isChoiceCorrect(q: Question, keys: string[]): boolean {
  if (q.type === 'text' || keys.length === 0) return false
  return [...keys].sort().join('|') === [...q.answer].sort().join('|')
}

export function answerToText(q: Question, ans?: AnswerState): string {
  if (!ans) return '（未作答）'
  if (q.type === 'text') return ans.text.trim() || '（未作答）'
  return ans.keys.length ? [...ans.keys].sort().join('、') : '（未作答）'
}

export function correctToText(q: Question): string {
  if (q.type === 'text') return '见解析'
  return [...q.answer].sort().join('、')
}

/* ---------------- 组卷 ---------------- */

/** 练习模式抽题：范围（全部/按章节/仅错题/仅收藏）+ 题型筛选 + 乱序 + 限量 */
export function buildPracticeQuestions(
  bank: BankData,
  cfg: PracticeConfig,
  wrongIds: Set<string>,
  favIds: Set<string>
): SessionQuestion[] {
  let pool = bank.Questions
  if (cfg.scope === 'chapter' && cfg.chapter) pool = pool.filter((q) => q.chapter === cfg.chapter)
  if (cfg.scope === 'wrong') pool = pool.filter((q) => wrongIds.has(q.id))
  if (cfg.scope === 'favorite') pool = pool.filter((q) => favIds.has(q.id))
  if (cfg.types.length) pool = pool.filter((q) => cfg.types.includes(q.type))
  pool = shuffle(pool)
  if (cfg.count !== 'all') pool = pool.slice(0, cfg.count)
  // 练习模式每题 1 分，便于结算页统计"分数"
  return pool.map((q) => ({ ...q, score: 1 }))
}

function scoreFor(rule: BankRule, chapter: string, type: string): number {
  const item = rule.composition.find((c) => c.chapter === chapter && c.type === type)
  return item ? item.scoreEach : 5
}

/** 考试模式组卷：模拟模式按组卷规则随机组卷；真题模式按试卷 questionIds 原始顺序 */
export function buildExamQuestions(
  bank: BankData,
  cfg: ExamConfig,
  rule: BankRule
): { questions: SessionQuestion[]; paperName?: string } {
  if (cfg.source === 'paper') {
    const paper = bank.Papers.find((p) => p.id === cfg.paperId)
    if (!paper) throw new Error('试卷不存在')
    const map = new Map(bank.Questions.map((q) => [q.id, q]))
    const questions = paper.questionIds
      .map((id) => map.get(id))
      .filter((q): q is Question => !!q)
      .map((q) => ({ ...q, score: scoreFor(rule, q.chapter, q.type) }))
    return { questions, paperName: paper.name }
  }
  const questions: SessionQuestion[] = []
  for (const item of rule.composition) {
    const pool = shuffle(bank.Questions.filter((q) => q.chapter === item.chapter && q.type === item.type))
    pool.slice(0, item.count).forEach((q) => questions.push({ ...q, score: item.scoreEach }))
  }
  return { questions }
}

/** 创建完整会话对象（含题目快照、空作答、考试截止时间） */
export function makeSession(
  bankId: string,
  mode: QuizMode,
  config: PracticeConfig | ExamConfig,
  questions: SessionQuestion[],
  durationMinutes: number,
  paperName?: string
): QuizSession {
  const now = Date.now()
  const answers: Record<string, AnswerState> = {}
  for (const q of questions) answers[q.id] = { keys: [], text: '', revealed: false, correct: null }
  return {
    id: genId('session'),
    bankId,
    mode,
    config,
    questions,
    answers,
    marks: [],
    currentIndex: 0,
    startTime: now,
    endTime: mode === 'exam' ? now + durationMinutes * 60_000 : null,
    totalScore: questions.reduce((s, q) => s + q.score, 0),
    paperName,
    createdAt: now,
    updatedAt: now
  }
}

/* ---------------- 交卷判分 ---------------- */

/** 统一判分出分，生成做题记录（练习/考试共用；考试简答题待自评 correct=null） */
export function gradeSession(s: QuizSession, bankName: string): QuizRecord {
  const now = Date.now()
  const details: RecordDetail[] = s.questions.map((q) => {
    const ans = s.answers[q.id]
    const answered = q.type === 'text' ? !!ans?.text.trim() : (ans?.keys.length ?? 0) > 0
    let correct: boolean | null
    if (s.mode === 'practice') {
      correct = ans?.revealed ? ans.correct : null
    } else {
      correct = q.type === 'text' ? null : answered && isChoiceCorrect(q, ans?.keys ?? [])
    }
    const gotScore = correct === true ? q.score : 0
    return {
      questionId: q.id,
      chapter: q.chapter,
      type: q.type,
      stem: q.stem,
      difficulty: q.difficulty,
      yourAnswer: answerToText(q, ans),
      rightAnswer: correctToText(q),
      correct,
      score: q.score,
      gotScore
    }
  })
  const answered = details.filter((d) => d.correct !== null || d.yourAnswer !== '（未作答）').length
  const correct = details.filter((d) => d.correct === true).length
  const wrong = details.filter((d) => d.correct === false).length
  const judged = correct + wrong
  const endPoint = s.mode === 'exam' && s.endTime ? Math.min(now, s.endTime) : now
  return {
    id: genId('record'),
    bankId: s.bankId,
    bankName,
    mode: s.mode,
    paperName: s.paperName,
    total: s.questions.length,
    answered,
    correct,
    wrong,
    accuracy: judged > 0 ? Math.round((correct / judged) * 100) : 0,
    score: details.reduce((sum, d) => sum + d.gotScore, 0),
    totalScore: s.totalScore,
    durationSec: Math.max(0, Math.round((endPoint - s.startTime) / 1000)),
    startTime: s.startTime,
    endTime: now,
    details
  }
}

/** 简答题自评后重算记录统计 */
export function recomputeRecord(rec: QuizRecord): void {
  rec.correct = rec.details.filter((d) => d.correct === true).length
  rec.wrong = rec.details.filter((d) => d.correct === false).length
  const judged = rec.correct + rec.wrong
  rec.accuracy = judged > 0 ? Math.round((rec.correct / judged) * 100) : 0
  rec.score = rec.details.reduce((sum, d) => sum + (d.correct === true ? d.score : 0), 0)
  rec.details.forEach((d) => {
    d.gotScore = d.correct === true ? d.score : 0
  })
}
