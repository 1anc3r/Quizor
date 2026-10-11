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
import { BankUrlError, normalizeBankData } from './bankNormalize'
import { parseTopLevelArrays } from './bankWorkerParse'

interface LoadRequest {
  type: 'load'
  /** 已解析为绝对地址的题库 JSON URL（Worker 里相对地址解析基准不直观，主线程先算好） */
  url: string
  /**
   * 全文**解压后**的预期字节数（构建期索引里的 `fullSize`）。
   *
   * 传输被 gzip 压缩时 `Content-Length` 是压缩后的体积，不能当下载进度的分母；
   * 主线程从索引里读出这个值传进来，拿不到就缺失（按"总量未知"处理）。
   */
  expectedTotal?: number
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

interface WorkerScope {
  postMessage(message: WorkerResponse): void
  onmessage: ((event: MessageEvent<LoadRequest>) => void) | null
}

const workerScope = self as unknown as WorkerScope

/** 总耗时超过该值时按"下载"上报，避免把下载时间算进"解析耗时" */
const PARSE_BUDGET_MS = 1_500

/**
 * 只在真正的 Worker 作用域里接管消息。
 *
 * **绝对不能无条件赋值 `self.onmessage`**：主线程的 `self` 就是 `window`，
 * 只要有任何模块为了拿 `createBankWorker` 而 import 本文件，顶层语句就会在主线程执行，
 * `window.onmessage` 会被这段 Worker 逻辑顶掉。此后任何发给 window 的消息
 * （浏览器扩展、devtools、页面自身的 postMessage）都会跑一次 `run(req)`：
 * `req.url` 是 undefined 时 `fetch(undefined)` 变成请求 `/undefined`（静态托管回 200 + HTML
 * 或直接 404 都算失败），catch 里又 `postMessage` 回 window，**再次触发自己**，
 * 于是形成自我激发的死循环——实测能刷出上千条 404 与 ERR_INSUFFICIENT_RESOURCES。
 * Worker 里没有 `window`，用它判断既准确又不必依赖 `WorkerGlobalScope` 类型。
 */
if (typeof window === 'undefined') {
  workerScope.onmessage = (event: MessageEvent<LoadRequest>): void => {
    const req = event.data as LoadRequest | null | undefined
    // 没有 url 的消息一律忽略：`fetch(undefined)` 会去请求当前目录下的 `/undefined`
    if (!req || typeof req.url !== 'string' || !req.url) return
    void run(req).catch((e: unknown) => {
      workerScope.postMessage({ type: 'error', message: e instanceof Error ? e.message : String(e) })
    })
  }
}

async function run(req: LoadRequest): Promise<void> {
  const startedAt = Date.now()
  const text = await fetchText(req.url, req.progressStep ?? DEFAULT_STEP, req.expectedTotal ?? 0)

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
 * 算下载进度的分母 —— 必须与 `reader.read()` 交出的字节**同单位**。
 *
 * 托管方给 JSON 开了 gzip 时，`Content-Length` 是**压缩后**的体积
 * （6.03MB 的题库实测 1.20MB），而响应体在 fetch 层就已被解压，
 * 分片累加出来的是**解压后**的字节。早先直接拿它当分母，于是首页显示
 * "1.06 MB / 1.20 MB"、百分比冲到 480%，进度条更是在下载只走了 1/5 时就满格消失，
 * 让用户以为"题库已经加载完"，进练习/考试却还要等 —— 一个分母同时造成两个现象。
 *
 * 解压后的总体积只有构建期索引（`fullSize`）知道；拿不到就返回 0，
 * 调用方按"总量未知"处理：照常流式读取并汇报已下载字节数，但不编百分比、不画确定进度。
 */
function resolveTotal(res: Response, expectedTotal: number): number {
  const encoding = (res.headers.get('content-encoding') ?? '').trim().toLowerCase()
  // 响应已被 fetch 自动解压；这里只判断"传输时是否压缩过"
  const compressed = !!encoding && encoding !== 'identity'
  if (compressed) return Number.isFinite(expectedTotal) && expectedTotal > 0 ? expectedTotal : 0
  const length = Number(res.headers.get('content-length') ?? 0)
  return Number.isFinite(length) && length > 0 ? length : 0
}

/**
 * 分片读取响应体，并在读取过程中汇报字节进度。
 *
 * `total` 未知（传输被压缩但索引没给 `fullSize`，或响应头没有 `Content-Length`）时
 * **仍然分片读取**，只是汇报的 `total` 为 0：主线程据此显示"已下载 X"而不是假百分比。
 * 早先这种情况直接走 `res.text()`，于是整个下载阶段一个进度都报不出来。
 */
async function fetchText(url: string, step: number, expectedTotal: number): Promise<string> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(url, { signal: ctrl.signal })
    if (!res.ok) throw new Error(`题库文件加载失败（HTTP ${res.status}）`)
    // 路径写错时，静态托管（dev server 的 SPA 回退、GitHub Pages 的 404 页）会返回 200 + HTML，
    // 直接进入解析只会得到一句没有上下文的 JSON 语法错误；这里提前拦住并说明。
    const ctype = res.headers.get('content-type') ?? ''
    if (ctype && !/json|text\/plain|octet-stream/i.test(ctype)) {
      throw new BankUrlError(`题库文件地址无效（返回 ${ctype.split(';')[0]}，不是 JSON）：${url}`)
    }

    const body = res.body
    if (!body) return await res.text()

    const total = resolveTotal(res, expectedTotal)
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
