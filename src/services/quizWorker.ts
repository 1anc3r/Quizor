/**
 * 组卷 / 判分 Worker。
 *
 * 与题库加载 Worker（bankWorker.ts）同一套取舍：把会卡住主线程的整段计算挪到
 * 独立线程，主线程只负责画遮罩进度 ——
 * - 组卷：练习抽题 / 考试组卷要过滤、乱序并**克隆**几百上千道富文本题目，
 *   全部对象复制在主线程上是肉眼可见的卡顿；
 * - 判分结算：交卷时要为每道题生成做题明细（题干摘要 HTML→纯文本是最贵的一步，
 *   880 题的会话在主线程上能卡数百毫秒）。
 *
 * 计算本体全部复用 services/quizCompute.ts 的分片异步实现：每处理一小批就
 * 让出事件循环并 postMessage 进度，因此进度环是连续走动的，而不是 0% 卡死再跳 100%。
 *
 * 线程边界传输的是**最终计算结果**（结构化克隆），不传中间态；
 * 传入侧（题库、会话）由主线程 quizWorkerApi.ts 用 structuredClone(toRaw(x)) 脱壳后发来。
 *
 * 注意：与 bankWorker.ts 一样，**绝对不能无条件赋值 self.onmessage** —— 主线程
 * 的 self 就是 window，本文件只要被 import（哪怕只是 `import type` 之外的值引用）
 * 顶层语句就会在主线程执行。这里用 `typeof window === 'undefined'` 判断 Worker 作用域，
 * 且把"创建 Worker 实例"的工厂放在主线程专用的 quizWorkerApi.ts 里。
 */
import {
  buildExamQuestions,
  buildPracticeQuestions,
  gradeSession,
  type ComputeProgress
} from './quizCompute'
import type { BankData, BankRule, ExamConfig, PracticeConfig, QuizSession } from '@/types'

export type QuizWorkerRequest =
  | { type: 'build-practice'; bank: BankData; cfg: PracticeConfig; wrongIds: string[]; favIds: string[] }
  | { type: 'build-exam'; bank: BankData; cfg: ExamConfig; rule: BankRule }
  | { type: 'grade'; session: QuizSession; bankName: string }

export type QuizWorkerResponse =
  | { type: 'progress'; ratio: number; label: string }
  | { type: 'done'; payload: unknown }
  | { type: 'error'; message: string }

interface WorkerScope {
  postMessage(message: QuizWorkerResponse): void
  onmessage: ((event: MessageEvent<QuizWorkerRequest>) => void) | null
}

const workerScope = self as unknown as WorkerScope

if (typeof window === 'undefined') {
  workerScope.onmessage = (event: MessageEvent<QuizWorkerRequest>): void => {
    const req = event.data as QuizWorkerRequest | null | undefined
    // 没有 type 的消息一律忽略：未知消息跑进计算分支只会变成难查的异常
    if (!req || typeof req.type !== 'string') return
    void run(req).catch((e: unknown) => {
      workerScope.postMessage({ type: 'error', message: e instanceof Error ? e.message : String(e) })
    })
  }
}

async function run(req: QuizWorkerRequest): Promise<void> {
  // 进度原样转发：ratio 已是 0-1 总进度，label 是阶段文案，主线程直接展示
  const onProgress: ComputeProgress = (ratio, label) => {
    workerScope.postMessage({ type: 'progress', ratio, label })
  }

  switch (req.type) {
    case 'build-practice': {
      const questions = await buildPracticeQuestions(
        req.bank,
        req.cfg,
        new Set(req.wrongIds),
        new Set(req.favIds),
        onProgress
      )
      workerScope.postMessage({ type: 'done', payload: questions })
      break
    }
    case 'build-exam': {
      const result = await buildExamQuestions(req.bank, req.cfg, req.rule, onProgress)
      workerScope.postMessage({ type: 'done', payload: result })
      break
    }
    case 'grade': {
      const record = await gradeSession(req.session, req.bankName, onProgress)
      workerScope.postMessage({ type: 'done', payload: record })
      break
    }
  }
}
