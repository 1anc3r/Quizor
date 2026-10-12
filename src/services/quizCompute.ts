/**
 * 组卷 / 判分的纯计算模块（Worker 安全）。
 *
 * 与 bankWorker 的取舍一致：重计算从主线程挪进 Worker，主线程只画进度。
 * 这里只放**不碰 localStorage / IndexedDB / window** 的纯函数，
 * 因此同一份代码既能被 services/quizWorker.ts 拉进 Worker 线程执行，
 * 也能在主线程兜底（Worker 被禁用/失败）时直接跑 —— 两条路行为完全一致。
 *
 * 三个重入口（练习组卷、考试组卷、交卷判分）实现为**分片异步**函数：
 * 每处理一小批就 `await` 让出事件循环并汇报进度，因此——
 * - 在 Worker 里：进度消息能逐批送达主线程，进度环是连续走动而不是卡 0% 再跳 100%；
 * - 在主线程兜底时：界面同样不会被一次性算死（每批之间浏览器可以渲染、响应输入）。
 *
 * `stemSummary` 在 Worker 里没有 DOMParser 可用，会自动退到正则剥标签
 * （见 utils/text.ts 的 htmlToText），摘要口径与主线程一致。
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
import { genId } from '@/utils/id'
import { stemSummary } from '@/utils/text'

/** 进度回调：ratio 为 0-1 的**总**进度，label 为当前阶段文案（直接展示在遮罩上） */
export type ComputeProgress = (ratio: number, label: string) => void

/** 每批处理完让出事件循环的最小间隔：进度消息得以送达/界面得以喘息 */
function yieldControl(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

/** 判分批大小：判分里最贵的是题干摘要（HTML → 纯文本），批小一点进度更顺滑 */
const GRADE_BATCH = 32
/** 题目快照（{ ...q, score } 克隆）批大小：纯对象克隆，可以大一点 */
const CLONE_BATCH = 64

/* ---------------- 判分工具（同步小函数，逐题即时反馈也用它们） ---------------- */

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
export async function buildPracticeQuestions(
  bank: BankData,
  cfg: PracticeConfig,
  wrongIds: Set<string>,
  favIds: Set<string>,
  onProgress?: ComputeProgress
): Promise<SessionQuestion[]> {
  onProgress?.(0.02, '正在筛选题目…')
  let pool = bank.Questions
  if (cfg.scope === 'chapter' && cfg.chapter) pool = pool.filter((q) => q.chapter === cfg.chapter)
  if (cfg.scope === 'wrong') pool = pool.filter((q) => wrongIds.has(q.id))
  if (cfg.scope === 'favorite') pool = pool.filter((q) => favIds.has(q.id))
  if (cfg.types.length) pool = pool.filter((q) => cfg.types.includes(q.type))
  pool = shuffle(pool)
  if (cfg.count !== 'all') pool = pool.slice(0, cfg.count)

  // 练习模式每题 1 分，便于结算页统计"分数"；分批克隆成会话快照，期间持续汇报进度
  const out: SessionQuestion[] = []
  const total = pool.length || 1
  for (let i = 0; i < pool.length; i += CLONE_BATCH) {
    const end = Math.min(i + CLONE_BATCH, pool.length)
    for (let j = i; j < end; j++) out.push({ ...pool[j], score: 1 })
    onProgress?.(0.05 + 0.9 * (out.length / total), '正在生成题目快照…')
    await yieldControl()
  }
  return out
}

function scoreFor(rule: BankRule, chapter: string, type: string): number {
  const item = rule.composition.find((c) => c.chapter === chapter && c.type === type)
  return item ? item.scoreEach : 5
}

/** 考试模式组卷：模拟模式按组卷规则随机组卷；真题模式按试卷 questionIds 原始顺序 */
export async function buildExamQuestions(
  bank: BankData,
  cfg: ExamConfig,
  rule: BankRule,
  onProgress?: ComputeProgress
): Promise<{ questions: SessionQuestion[]; paperName?: string }> {
  if (cfg.source === 'paper') {
    const paper = bank.Papers.find((p) => p.id === cfg.paperId)
    if (!paper) throw new Error('试卷不存在')
    const map = new Map(bank.Questions.map((q) => [q.id, q] as const))
    const total = paper.questionIds.length || 1
    const questions: SessionQuestion[] = []
    for (let i = 0; i < paper.questionIds.length; i += CLONE_BATCH) {
      const end = Math.min(i + CLONE_BATCH, paper.questionIds.length)
      for (let j = i; j < end; j++) {
        const q = map.get(paper.questionIds[j])
        if (q) questions.push({ ...q, score: scoreFor(rule, q.chapter, q.type) })
      }
      onProgress?.(0.9 * (questions.length / total), '正在还原试卷题目…')
      await yieldControl()
    }
    onProgress?.(1, '组卷完成')
    return { questions, paperName: paper.name }
  }

  // 模拟模式：先按规则逐题组过滤 + 乱序抽题（这部分 O(n) 轻量，按题组汇报），
  // 再分批克隆成会话快照
  const picked: Question[] = []
  const groups = rule.composition
  for (let i = 0; i < groups.length; i++) {
    const item = groups[i]
    const pool = shuffle(bank.Questions.filter((q) => q.chapter === item.chapter && q.type === item.type))
    picked.push(...pool.slice(0, item.count))
    onProgress?.(0.45 * ((i + 1) / (groups.length || 1)), '正在随机抽题…')
    await yieldControl()
  }
  const questions: SessionQuestion[] = []
  const total = picked.length || 1
  for (let i = 0; i < picked.length; i += CLONE_BATCH) {
    const end = Math.min(i + CLONE_BATCH, picked.length)
    for (let j = i; j < end; j++) questions.push({ ...picked[j], score: scoreFor(rule, picked[j].chapter, picked[j].type) })
    onProgress?.(0.45 + 0.5 * (questions.length / total), '正在生成题目快照…')
    await yieldControl()
  }
  onProgress?.(1, '组卷完成')
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

/**
 * 统一判分出分，生成做题记录（练习/考试共用；考试简答题待自评 correct=null）。
 *
 * 实现为分片异步：逐题生成 RecordDetail（题干摘要 + 作答文本）是最重的部分，
 * 每 GRADE_BATCH 题让出一次事件循环并汇报进度，880 题的会话也不会卡住界面。
 */
export async function gradeSession(
  s: QuizSession,
  bankName: string,
  onProgress?: ComputeProgress
): Promise<QuizRecord> {
  const now = Date.now()
  const total = s.questions.length || 1
  const details: RecordDetail[] = new Array(s.questions.length)
  for (let i = 0; i < s.questions.length; i += GRADE_BATCH) {
    const end = Math.min(i + GRADE_BATCH, s.questions.length)
    for (let j = i; j < end; j++) {
      details[j] = gradeOne(s, s.questions[j])
    }
    onProgress?.(0.05 + 0.9 * (end / total), '正在逐题判分…')
    await yieldControl()
  }
  // 已作答 = 答题卡上有作答痕迹；不能再用 `d.correct !== null` 判断，
  // 因为考试模式下未作答的选择题也是 null，而自评前的简答题同样为 null。
  const answered = details.filter((d) => d.yourAnswer !== '（未作答）').length
  const correct = details.filter((d) => d.correct === true).length
  const wrong = details.filter((d) => d.correct === false).length
  const judged = correct + wrong
  const endPoint = s.mode === 'exam' && s.endTime ? Math.min(now, s.endTime) : now
  onProgress?.(1, '正在汇总成绩…')
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

/** 单题判分（gradeSession 的分片内循环体，抽出来只为让批循环可读） */
function gradeOne(s: QuizSession, q: SessionQuestion): RecordDetail {
  const ans = s.answers[q.id]
  const answered = q.type === 'text' ? !!ans?.text.trim() : (ans?.keys.length ?? 0) > 0
  let correct: boolean | null
  if (s.mode === 'practice') {
    correct = ans?.revealed ? ans.correct : null
  } else if (q.type === 'text') {
    correct = null
  } else {
    // 未作答的选择题必须是 null（约定见 RecordDetail.correct：null = 未作答或待自评）。
    // 之前写成 `answered && isChoiceCorrect(...)`，未作答时短路得到 false，
    // 于是跳过的题被当成"答错"计入 wrong/accuracy，还会被收藏进错题本。
    const picked = ans?.keys ?? []
    correct = picked.length > 0 ? isChoiceCorrect(q, picked) : null
  }
  const gotScore = correct === true ? q.score : 0
  return {
    questionId: q.id,
    chapter: q.chapter,
    type: q.type,
    // 只存纯文本摘要：完整题干可从题库按 questionId 回查，
    // 历史记录曾把富文本题干整份落盘（一份 100 题记录约 300KB）
    stem: stemSummary(q.stem),
    difficulty: q.difficulty,
    yourAnswer: answerToText(q, ans),
    rightAnswer: correctToText(q),
    correct,
    score: q.score,
    gotScore
  }
}

/** 简答题自评后重算记录统计 */
export function recomputeRecord(rec: QuizRecord): void {
  rec.answered = rec.details.filter((d) => d.yourAnswer !== '（未作答）').length
  rec.correct = rec.details.filter((d) => d.correct === true).length
  rec.wrong = rec.details.filter((d) => d.correct === false).length
  const judged = rec.correct + rec.wrong
  rec.accuracy = judged > 0 ? Math.round((rec.correct / judged) * 100) : 0
  rec.score = rec.details.reduce((sum, d) => sum + (d.correct === true ? d.score : 0), 0)
  rec.details.forEach((d) => {
    d.gotScore = d.correct === true ? d.score : 0
  })
}
