/**
 * 题库数据的规整逻辑。
 *
 * 独立成模块的原因：它同时被主线程（`bankService`）和 Worker（`bankWorker`）使用。
 * 若留在 `bankService` 里，就会出现 `bankWorker → bankService → bankWorkerApi → bankWorker`
 * 的循环依赖 —— 虽然只要不在模块顶层取值就能跑，但这种"靠顺序侥幸成立"的依赖
 * 在打包与 Tree-shaking 下很容易变成难查的线上问题，因此这里彻底断开。
 *
 * 本模块**不依赖任何浏览器 API 与服务模块**，可以安全地在任意线程导入。
 */
import type { BankData, OptionItem, Paper, Question, QuestionType } from '@/types'

export const QUESTION_TYPES: QuestionType[] = ['single', 'multiple', 'judge', 'text']

/** 规整进度钩子：题目与试卷共用同一个计数器，逐条 +1 */
export interface NormalizeCounter {
  bump: () => void
}

/**
 * 把来源不可信的题目数组规整为合法 `Question`。
 *
 * 内置题库文件、用户导入的题库、备份文件都可能字段缺失或类型错误
 * （例如缺 `options`、`difficulty` 是字符串、`id` 重复），
 * 直接使用会在渲染与判分环节抛出异常，因此统一补默认值后放行。
 * 题干为空的条目无法作答，直接丢弃。
 */
export function normalizeQuestions(raw: unknown, counter?: NormalizeCounter | null): Question[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const out: Question[] = []

  raw.forEach((item, i) => {
    counter?.bump()
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

/** 规整试卷数组（与题目共用一个计数器） */
function normalizePapers(raw: unknown, counter?: NormalizeCounter | null): Paper[] {
  if (!Array.isArray(raw)) return []
  return raw
    .filter((p): p is Paper => !!p && typeof p === 'object' && typeof p.id === 'string')
    .map((p) => {
      counter?.bump()
      return {
        ...p,
        name: typeof p.name === 'string' ? p.name : '',
        source: typeof p.source === 'string' ? p.source : '',
        difficulty: typeof p.difficulty === 'number' ? p.difficulty : 3,
        questionIds: Array.isArray(p.questionIds)
          ? p.questionIds.filter((x): x is string => typeof x === 'string')
          : []
      }
    })
}

/** 规整一整个 BankData（题目 + 试卷），所有读取路径都要经过它 */
export function normalizeBankData(raw: unknown, counter?: NormalizeCounter | null): BankData {
  const r = (raw ?? {}) as Partial<BankData>
  return { Questions: normalizeQuestions(r.Questions, counter), Papers: normalizePapers(r.Papers, counter) }
}
