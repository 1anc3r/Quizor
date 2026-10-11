/**
 * 题库 Worker 的主线程封装。
 *
 * 对外只暴露"给个 URL（或一段文本），把 BankData 拿回来，并沿途汇报进度"。
 * 三点设计取舍：
 *
 * 1. **Worker 是可选加速，不是依赖**：Worker 不可用（老浏览器、被 CSP 拦、加载失败）时
 *    自动退回主线程 `fetch + JSON.parse`，功能不降级，只是没有分片进度、解析会短暂阻塞主线程。
 * 2. **失败的代价是一次重下**：Worker 中途失败时进度已经回退，这里直接重开一次完整流程；
 *    静态 JSON 命中 HTTP 缓存，重下的实际代价接近 0。
 * 3. **文本解析复用同一套代码**：导入题库/备份恢复给的是内存里的字符串，
 *    走同一条分片解析路径，因此大文件导入也不会把主线程卡死。
 */
import type { BankData } from '@/types'
import { normalizeBankData } from './bankNormalize'
import { parseTopLevelArrays } from './bankWorkerParse'
import { createBankWorker, type WorkerResponse } from './bankWorker'

/**
 * 进度快照。`ratio` 是 0-1 的**总**进度（下载占前 40%，解析 40%–70%，规整 70%–100%），
 * 不是单阶段进度 —— 首页直接拿它渲染进度条，不需要自己拼。
 */
export interface BankLoadProgress {
  /** download：拉字节；parse：切分 JSON；normalize：补默认值/去重 id；done：全部就绪 */
  phase: 'download' | 'parse' | 'normalize' | 'done'
  ratio: number
  /** 下载阶段：已收字节数 */
  loaded: number
  /** 下载阶段：总字节数（响应头没给 content-length 时为 0） */
  total: number
}

export type LoadProgress = (p: BankLoadProgress) => void

/** 各阶段在总进度里的权重：下载是耗时大头，给 40% */
const W_DOWNLOAD = 0.4
const W_PARSE = 0.3
const W_NORMALIZE = 0.3

/** 文本分片解析的兜底形态，与 Worker 里 `parseTopLevelArrays` 的产物一致 */
export interface ParsedBankJson {
  Questions: BankData['Questions']
  Papers: BankData['Papers']
}

/**
 * 分片解析一段题库 JSON 文本（不经过 Worker）。
 *
 * 用途：导入题库、备份恢复等"文本已经在内存里"的场景。
 * 逐条 `JSON.parse` 并把控制权交回事件循环，避免一次性 `JSON.parse` 卡住界面。
 * 结构超出分片解析器能力时退回原生 `JSON.parse`。
 */
export async function parseBankJsonText(text: string, onProgress?: LoadProgress): Promise<BankData> {
  const sliced = parseTopLevelArrays(text, (consumed, total) => {
    onProgress?.({ phase: 'parse', ratio: W_PARSE * (consumed / total), loaded: 0, total: 0 })
  })

  let raw: { Questions?: unknown; Papers?: unknown }
  if (sliced) {
    const parsed: Record<string, unknown[]> = {}
    for (const entry of sliced) {
      const records: unknown[] = []
      for (const record of entry.records) records.push(JSON.parse(record))
      parsed[entry.key] = records
      // 每条记录解析完让出一次事件循环，长文件也不会独占主线程
      await nextTick()
    }
    raw = parsed
  } else {
    raw = JSON.parse(text) as { Questions?: unknown; Papers?: unknown }
  }
  return normalizeBankData(raw)
}

/** `setTimeout(0)` 的一层 Promise 包装：让出事件循环，给渲染与输入响应留出机会 */
function nextTick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

let worker: Worker | null = null
let workerBroken = false

/** 懒创建并复用同一个 Worker：多次加载不同题库不需要反复启动线程 */
function getWorker(): Worker | null {
  if (workerBroken) return null
  if (worker) return worker
  try {
    worker = createBankWorker()
    return worker
  } catch (e) {
    // 创建失败通常意味着 Worker 被 CSP 或运行环境禁用，之后不必再试
    console.warn('[quizor] 题库 Worker 不可用，退回主线程解析：', e)
    workerBroken = true
    return null
  }
}

/** 主线程兜底：直接 fetch 全文再分片解析 */
async function loadViaMainThread(url: string, onProgress?: LoadProgress): Promise<BankData> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`题库文件加载失败（HTTP ${res.status}）`)
  const text = await res.text()
  onProgress?.({ phase: 'download', ratio: W_DOWNLOAD, loaded: text.length, total: text.length })
  return parseBankJsonText(text, onProgress)
}

/**
 * 分片加载题库 JSON 并返回规整后的 `BankData`。
 *
 * `onProgress` 在首次尝试失败、准备重下时会**回退到 0**，
 * 因此进度条看起来是"重来一遍"而不是"卡在 60%"。
 */
export async function parseBankJsonWithProgress(
  url: string,
  onProgress?: LoadProgress
): Promise<BankData> {
  const parse = (): Promise<BankData> => runWorkerLoad(url, onProgress)
  try {
    return await parse()
  } catch (e) {
    // 进度已回退，重开一次：静态 JSON 命中 HTTP 缓存，重下代价接近 0
    console.warn('[quizor] Worker 加载题库失败，重试一次：', e)
    onProgress?.({ phase: 'download', ratio: 0, loaded: 0, total: 0 })
    try {
      return await parse()
    } catch (e2) {
      console.warn('[quizor] Worker 重试仍失败，退回主线程：', e2)
      onProgress?.({ phase: 'download', ratio: 0, loaded: 0, total: 0 })
      return loadViaMainThread(url, onProgress)
    }
  }
}

/** 一次完整的 Worker 加载流程：把 Worker 的三类进度事件折算成总进度后上报 */
function runWorkerLoad(url: string, onProgress?: LoadProgress): Promise<BankData> {
  return new Promise<BankData>((resolve, reject) => {
    const w = getWorker()
    if (!w) {
      loadViaMainThread(url, onProgress).then(resolve, reject)
      return
    }

    const finish = (): void => {
      w.removeEventListener('message', onMessage)
      w.removeEventListener('error', onError)
    }
    const onMessage = (event: MessageEvent<WorkerResponse>): void => {
      const msg = event.data
      switch (msg.type) {
        case 'download':
          onProgress?.({
            phase: 'download',
            ratio: W_DOWNLOAD * (msg.total ? msg.loaded / msg.total : 0),
            loaded: msg.loaded,
            total: msg.total
          })
          break
        case 'parse':
          onProgress?.({
            phase: 'parse',
            ratio: W_DOWNLOAD + W_PARSE * Math.min(1, Math.max(0, msg.ratio)),
            loaded: 0,
            total: 0
          })
          break
        case 'normalize':
          onProgress?.({
            phase: 'normalize',
            ratio: W_DOWNLOAD + W_PARSE + W_NORMALIZE * Math.min(1, Math.max(0, msg.ratio)),
            loaded: 0,
            total: 0
          })
          break
        case 'done':
          finish()
          onProgress?.({ phase: 'done', ratio: 1, loaded: 0, total: 0 })
          resolve(normalizeBankData(msg.data))
          break
        case 'error':
          finish()
          reject(new Error(msg.message))
          break
      }
    }
    const onError = (event: ErrorEvent): void => {
      finish()
      reject(new Error(event.message || '题库加载线程异常'))
    }

    w.addEventListener('message', onMessage)
    w.addEventListener('error', onError)
    w.postMessage({ type: 'load', url: new URL(url, location.href).href })
  })
}
