/**
 * 组卷 / 判分 Worker 的主线程封装。
 *
 * 对外只暴露三个异步函数：练习组卷、考试组卷、交卷判分 —— 给个入参，把结果拿回来，
 * 沿途汇报进度（遮罩上的进度环直接消费）。设计取舍与 bankWorkerApi 一致：
 *
 * 1. **Worker 是可选加速，不是依赖**：Worker 不可用（老浏览器、被 CSP 拦、创建失败）
 *    或中途失败时，自动退回主线程执行同一套 quizCompute 分片实现 —— 功能不降级，
 *    只是计算回到了主线程（分片让出机制保证界面依旧不会被算死）。
 * 2. **入参先脱壳再进线程**：Pinia 的 reactive 代理无法结构化克隆（postMessage 直接
 *    抛 DataCloneError），`structuredClone(toRaw(x))` 把数据还原成普通对象图。
 *    计算是纯函数，Worker 内的任何改动都影响不到主线程这份数据，无需回写。
 * 3. **进度即所得**：Worker 里每处理一小批就发一条 progress，ratio 已是 0-1 总进度，
 *    主线程夹到 [0,1] 后直接驱动进度环，不拼阶段。
 *
 * 创建 Worker 的工厂必须待在主线程模块里（理由见 bankWorkerApi 的同款说明）：
 * 这里只写 `new URL('./quizWorker.ts', import.meta.url)`，对 Worker 模块只有
 * `import type`（编译期擦除），Worker 代码不会被打进主包。
 */
import { toRaw } from 'vue'
import type {
  BankData,
  BankRule,
  ExamConfig,
  PracticeConfig,
  QuizRecord,
  QuizSession,
  SessionQuestion
} from '@/types'
import {
  buildExamQuestions,
  buildPracticeQuestions,
  gradeSession,
  type ComputeProgress
} from './quizCompute'
import type { QuizWorkerRequest, QuizWorkerResponse } from './quizWorker'

function createQuizWorker(): Worker {
  return new Worker(new URL('./quizWorker.ts', import.meta.url), { type: 'module' })
}

let worker: Worker | null = null
let workerBroken = false

/** 懒创建并复用同一个 Worker：组卷、判分共用，不需要反复启动线程 */
function getWorker(): Worker | null {
  if (workerBroken) return null
  if (worker) return worker
  try {
    worker = createQuizWorker()
    return worker
  } catch (e) {
    // 创建失败通常意味着 Worker 被 CSP 或运行环境禁用，之后不必再试
    console.warn('[quizor] 组卷/判分 Worker 不可用，退回主线程执行：', e)
    workerBroken = true
    return null
  }
}

/** 传进 Worker 前脱壳：reactive 代理无法结构化克隆，还原成普通对象图再发 */
function detach<T>(value: T): T {
  return structuredClone(toRaw(value) as T)
}

/**
 * 一次完整的 Worker 任务：转发进度、回传结果；失败时走 fallback（主线程分片执行）。
 * postMessage 本身也可能同步抛错（入参含不可克隆的对象），两种失败都收敛到 fallback。
 */
function runQuizTask<T>(
  req: () => QuizWorkerRequest,
  fallback: (onProgress?: ComputeProgress) => Promise<T>,
  onProgress?: ComputeProgress
): Promise<T> {
  const w = getWorker()
  if (!w) return fallback(onProgress)
  return new Promise<T>((resolve, reject) => {
    const finish = (): void => {
      w.removeEventListener('message', onMessage)
      w.removeEventListener('error', onError)
    }
    const onMessage = (event: MessageEvent<QuizWorkerResponse>): void => {
      const msg = event.data
      switch (msg.type) {
        case 'progress':
          onProgress?.(Math.min(1, Math.max(0, msg.ratio)), msg.label)
          break
        case 'done':
          finish()
          resolve(msg.payload as T)
          break
        case 'error':
          finish()
          reject(new Error(msg.message))
          break
      }
    }
    const onError = (event: ErrorEvent): void => {
      finish()
      reject(new Error(event.message || '组卷/判分线程异常'))
    }

    w.addEventListener('message', onMessage)
    w.addEventListener('error', onError)
    try {
      w.postMessage(req())
    } catch (e) {
      finish()
      reject(e instanceof Error ? e : new Error(String(e)))
    }
  })
}

/** Worker 失败后退回主线程的通用包装：计算无网络依赖，重试无意义，直接本地兜底 */
function withMainThreadFallback<T>(run: () => Promise<T>, fallback: () => Promise<T>): Promise<T> {
  return run().catch((e: unknown) => {
    console.warn('[quizor] 组卷/判分 Worker 失败，退回主线程执行：', e)
    return fallback()
  })
}

/** 练习组卷（异步）：范围筛选 + 乱序抽题 + 题目快照，全部在 Worker 里完成 */
export function buildPracticeQuestionsAsync(
  bank: BankData,
  cfg: PracticeConfig,
  wrongIds: Iterable<string>,
  favIds: Iterable<string>,
  onProgress?: ComputeProgress
): Promise<SessionQuestion[]> {
  const wrong = [...wrongIds]
  const fav = [...favIds]
  return withMainThreadFallback(
    () =>
      runQuizTask<SessionQuestion[]>(
        () => ({ type: 'build-practice', bank: detach(bank), cfg: detach(cfg), wrongIds: wrong, favIds: fav }),
        (p) => buildPracticeQuestions(bank, cfg, new Set(wrong), new Set(fav), p),
        onProgress
      ),
    () => buildPracticeQuestions(bank, cfg, new Set(wrong), new Set(fav), onProgress)
  )
}

/** 考试组卷（异步）：模拟模式按规则随机组卷，真题模式按试卷原序还原 */
export function buildExamQuestionsAsync(
  bank: BankData,
  cfg: ExamConfig,
  rule: BankRule,
  onProgress?: ComputeProgress
): Promise<{ questions: SessionQuestion[]; paperName?: string }> {
  return withMainThreadFallback(
    () =>
      runQuizTask<{ questions: SessionQuestion[]; paperName?: string }>(
        () => ({ type: 'build-exam', bank: detach(bank), cfg: detach(cfg), rule: detach(rule) }),
        (p) => buildExamQuestions(bank, cfg, rule, p),
        onProgress
      ),
    () => buildExamQuestions(bank, cfg, rule, onProgress)
  )
}

/** 交卷判分（异步）：逐题生成做题明细并汇总成绩，结果可直接落盘 */
export function gradeSessionAsync(
  session: QuizSession,
  bankName: string,
  onProgress?: ComputeProgress
): Promise<QuizRecord> {
  return withMainThreadFallback(
    () =>
      runQuizTask<QuizRecord>(
        () => ({ type: 'grade', session: detach(session), bankName }),
        (p) => gradeSession(session, bankName, p),
        onProgress
      ),
    () => gradeSession(session, bankName, onProgress)
  )
}
