/**
 * 题库全文加载 Worker。
 *
 * 首页/设置页需要的 6MB 题库 JSON，下载与解析全部发生在这里，主线程只负责画进度条：
 * - `fetch` + `response.body.getReader()` 分片读取 → 汇报**真实字节进度**（不是假动画）；
 * - 用 `bankWorkerParse` 逐条剥离 `Questions` / `Papers` 数组并按条 `JSON.parse`，
 *   控制权定期交回事件循环，于是进度可以持续上报；
 * - 规整后的对象直接 `postMessage`（结构化克隆），主线程拿到即可用。
 *
 * 线程边界只传**最终对象**，不传 6MB 原始文本 —— 后者要完整复制一份，等于白白多花一次内存。
 */
import { normalizeBankData } from './bankNormalize'
import { parseTopLevelArrays } from './bankWorkerParse'

interface LoadRequest {
  type: 'load'
  /** 已解析为绝对地址的题库 JSON URL（Worker 里相对地址解析基准不直观，主线程先算好） */
  url: string
  /** 流式读取每次汇报之间的最小字节间隔，默认 256KB */
  progressStep?: number
  /** 规整阶段的进度汇报条数间隔，默认 64 条 */
  itemStep?: number
}

const DEFAULT_STEP = 262_144
const DEFAULT_ITEM_STEP = 64
/** 单次加载的硬超时：网络卡死时让主线程能收到明确失败，而不是永远转圈 */
const FETCH_TIMEOUT_MS = 120_000

export type WorkerResponse =
  | { type: 'download'; loaded: number; total: number }
  | { type: 'parse'; ratio: number }
  | { type: 'normalize'; ratio: number }
  | { type: 'done'; data: unknown; parseMs: number }
  | { type: 'error'; message: string }

/**
 * 创建 Worker 实例（只在主线程调用）。
 *
 * 用 `new URL(..., import.meta.url)` + `{ type: 'module' }` 而不是 `?worker` 后缀导入：
 * 前者不需要为 `*?worker` 额外声明模块类型，且是 Vite 官方支持的 Worker 产物形式。
 * 本模块被主线程 import 时只执行到这一层，`onmessage` 赋值不会产生副作用。
 */
export function createBankWorker(): Worker {
  return new Worker(new URL('./bankWorker.ts', import.meta.url), { type: 'module' })
}

const workerScope = self as unknown as {
  postMessage(message: WorkerResponse): void
  onmessage: ((event: MessageEvent<LoadRequest>) => void) | null
}

/** 总耗时超过该值时按"下载"上报，避免把下载时间算进"解析耗时" */
const PARSE_BUDGET_MS = 1_500

workerScope.onmessage = (event: MessageEvent<LoadRequest>): void => {
  void run(event.data).catch((e: unknown) => {
    workerScope.postMessage({ type: 'error', message: e instanceof Error ? e.message : String(e) })
  })
}

async function run(req: LoadRequest): Promise<void> {
  const startedAt = Date.now()
  const text = await fetchText(req.url, req.progressStep ?? DEFAULT_STEP)

  // 下载完到开始解析之间先报一次 0%，否则进度条会停在 100% 的下载阶段不动
  const downloadMs = Date.now() - startedAt
  const parseRatio = downloadMs > PARSE_BUDGET_MS ? 0 : 1
  workerScope.postMessage({ type: 'parse', ratio: parseRatio })
  const parseStart = Date.now()

  let raw = parseTopLevelArrays(text, (consumed, total) => {
    // 解析阶段占「解析 + 规整」的前 70%，规整阶段占剩下 30%，两段拼起来是连续的
    workerScope.postMessage({ type: 'parse', ratio: Math.min(0.99, consumed / total) * 0.7 })
  })

  if (!raw) {
    // 结构超出分片解析器的能力（异常文件）→ 退回一次性解析，保证任何合法 JSON 都能读。
    // 此时没有逐条进度可报，直接进入规整阶段。
    const parsed = JSON.parse(text) as { Questions?: unknown; Papers?: unknown }
    workerScope.postMessage({ type: 'parse', ratio: 0.7 })
    const data = normalizeBankData(parsed)
    workerScope.postMessage({ type: 'normalize', ratio: 1 })
    workerScope.postMessage({ type: 'done', data, parseMs: Date.now() - parseStart })
    return
  }

  // 逐条 JSON.parse：每条都是小字符串，单次调用耗时极短，主线程之外执行不阻塞界面
  const parse = (records: string[]): unknown[] => {
    const out: unknown[] = []
    for (const record of records) out.push(JSON.parse(record))
    return out
  }
  const byKey = new Map(raw.map((entry) => [entry.key, parse(entry.records)]))

  const questions = byKey.get('Questions') ?? []
  const papers = byKey.get('Papers') ?? []
  const parseMs = Date.now() - parseStart

  // 规整（补默认值、丢弃空题干、去重 id）在数据量下同样是几十毫秒级的同步计算，
  // 这里按条汇报进度，让进度条走完最后一段而不是直接跳到 100%
  const itemStep = req.itemStep ?? DEFAULT_ITEM_STEP
  let processed = 0
  const totalItems = questions.length + papers.length || 1
  const data = normalizeBankData(
    { Questions: questions, Papers: papers },
    {
      bump: () => {
        processed++
        if (processed % itemStep === 0) {
          workerScope.postMessage({ type: 'normalize', ratio: processed / totalItems })
        }
      }
    }
  )
  workerScope.postMessage({ type: 'normalize', ratio: 1 })

  workerScope.postMessage({ type: 'done', data, parseMs })
}

/**
 * 分片读取响应体，并在读取过程中汇报字节进度。
 *
 * 没有 `Content-Length` 时（极少数静态托管会省略）读成 blob 再解码，
 * 此时没有字节进度可报，只能直接进入解析阶段。
 */
async function fetchText(url: string, step: number): Promise<string> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(url, { signal: ctrl.signal })
    if (!res.ok) throw new Error(`题库文件加载失败（HTTP ${res.status}）`)

    const total = Number(res.headers.get('content-length') ?? 0)
    const body = res.body
    if (!body || !total) return await res.text()

    const reader = body.getReader()
    const chunks: Uint8Array[] = []
    let loaded = 0
    let reported = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      chunks.push(value)
      loaded += value.byteLength
      if (loaded - reported >= step) {
        reported = loaded
        workerScope.postMessage({ type: 'download', loaded, total })
      }
    }
    workerScope.postMessage({ type: 'download', loaded, total })

    const merged = new Uint8Array(loaded)
    let offset = 0
    for (const chunk of chunks) {
      merged.set(chunk, offset)
      offset += chunk.byteLength
    }
    // 题库 JSON 是 UTF-8（含中文题干），必须按 utf-8 解码；默认解码在某些实现上是 utf-8，
    // 但显式指定更可靠
    return new TextDecoder('utf-8').decode(merged)
  } finally {
    clearTimeout(timer)
  }
}
