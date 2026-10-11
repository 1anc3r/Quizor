/**
 * 分片 JSON 解析：把顶层对象 `{ "Questions": [...], "Papers": [...] }` 里的数组
 * **逐条**剥离出来，而不是交给一次性 `JSON.parse`。
 *
 * 为什么不用 `JSON.parse`：
 * 1. 进度：6MB 题库的解析是纯 CPU 的同步操作，`JSON.parse` 一旦开始就无法汇报任何进展，
 *    进度条会在"下载完"到"解析完"之间卡住不动（看起来像卡死）。
 *    逐条解析时可以按"已消化的字符数"给出真实的解析百分比。
 * 2. 分片：逐条解析天然把长任务切成小块，配合 Worker 就完全不占用主线程。
 *
 * 实现要点：
 * - 只支持**顶层对象 + 顶层值为 JSON 数组、且数组元素是对象/字面量**这一种形态
 *   （题库文件正是这个形态）；遇到任何不符合该形态的输入（元素本身是数组、
 *   括号不配对等）一律返回 `null`，由调用方退回 `JSON.parse` 兜底，
 *   保证任何合法 JSON 都能读，且**绝不返回切错的记录**。
 * - 括号配对是"状态机"扫描（跳过字符串与转义），不是 `indexOf`：题干富文本里
 *   大量出现 `{` `}` `[` `]` `"`，用 indexOf 找边界必然切错。
 */

/** 单条记录之间的进度回调；`consumed` 是已消化的字符数（不是条数） */
export type RecordProgress = (consumed: number, total: number) => void

/** 一次顶层扫描最多接受的记录数：防御异常文件把内存吃光 */
const MAX_RECORDS = 500_000

/** 在 JSON 文本里从 `from` 开始找"下一个非空白字符"，返回其下标；找不到返回 -1 */
function nextToken(text: string, from: number): number {
  let i = from
  while (i < text.length) {
    const c = text.charCodeAt(i)
    // space / tab / \n / \r 都是 JSON 允许的空白
    if (c !== 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) return i
    i++
  }
  return -1
}

/** `sliceArrayRecords` 的结果：记录文本 + 数组 `]` 之后的下标 */
interface SlicedArray {
  records: string[]
  /** 指向数组闭合 `]` 的下一个字符 */
  end: number
}

/**
 * 从 `open`（必须指向 `[`）开始，把数组里每条**顶层元素**原样切出来。
 *
 * 每切完一条就回调一次进度，因此调用方能在解析过程中持续更新界面。
 * 返回 `null` 代表"这个数组的写法超出了本解析器的能力"（或结构非法），
 * 调用方必须退回 `JSON.parse`。
 */
function sliceArrayRecords(
  text: string,
  open: number,
  onRecord: RecordProgress | undefined
): SlicedArray | null {
  const out: string[] = []
  // `i` 始终指向"待解析的下一个 token"的位置
  let i = nextToken(text, open + 1)
  if (i < 0) return null
  if (text[i] === ']') {
    onRecord?.(i, text.length)
    return { records: out, end: i + 1 }
  }

  for (;;) {
    // `start` 是本条元素的起始下标，必须在扫描前固定下来：
    // 扫描用的 `i` 在 break 时已经停在元素末尾，用 `i` 切片只会切到最后一个字符。
    const start = i
    let depth = 0
    let inStr = false
    let esc = false
    let end = -1
    for (; i < text.length; i++) {
      const c = text[i]
      if (inStr) {
        if (esc) esc = false
        else if (c === '\\') esc = true
        else if (c === '"') inStr = false
        continue
      }
      if (c === '"') inStr = true
      else if (c === '{' || c === '[') depth++
      else if (c === '}' || c === ']') {
        // 必须先判断"是不是数组结束"，再递减深度。
        // 顺序反了会让每个以 `}` 结尾的对象在自身闭合处就被截断成 `}`。
        if (depth === 0) {
          onRecord?.(i, text.length)
          return { records: out, end: i + 1 }
        }
        depth--
        if (depth === 0) {
          end = i + 1
          break
        }
      } else if (depth === 0 && c === ',') {
        // 顶层元素也可能是数字/布尔/null 这类字面量：它们没有闭合括号，
        // 只能靠分隔逗号收边。这里直接收边而不是继续扫到 `]`，否则会把整段当成一个元素。
        break
      } else if (depth === 0) {
        // 顶层元素在闭合前出现了第二个 token → 结构超出本解析器能力（例如元素本身是数组），
        // 返回 null 让调用方退回 JSON.parse，绝不返回切错的记录。
        return null
      }
    }
    // 扫描到了文本末尾却没闭合：JSON 非法
    if (end < 0) return null

    out.push(text.slice(start, end))
    if (out.length > MAX_RECORDS) return null

    // 本条记录结束时的绝对位置：进度按这里算，比"条数/总数"更贴近真实解析量
    const consumedAt = end
    // 跨过分隔逗号：先看紧跟其后的字符，再向后跳过空白
    let j = end
    while (j < text.length) {
      const c = text.charCodeAt(j)
      if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) j++
      else break
    }
    if (j < text.length && text[j] === ',') {
      onRecord?.(consumedAt, text.length)
      // 下一个 token 从逗号的下一个非空白字符开始找
      i = nextToken(text, j + 1)
      if (i < 0) return null
    } else {
      onRecord?.(consumedAt, text.length)
      i = j
    }
  }
}

/** 顶层对象里一个键对应的数组值 */
export interface ParsedTopLevelArray {
  /** 键名（原样保留，用于错误信息） */
  key: string
  /** 每条记录的原文本，可直接 `JSON.parse` */
  records: string[]
}

/**
 * 解析顶层对象，返回其中所有**数组值**的原始记录文本。
 *
 * 非数组的顶层值（字符串/数字/对象）会被跳过：题库文件里只有 `Questions` 与 `Papers`
 * 两个数组，这里不做键名白名单，是为了让解析器对文件结构变化保持中立。
 */
export function parseTopLevelArrays(
  text: string,
  onProgress?: RecordProgress
): ParsedTopLevelArray[] | null {
  const first = nextToken(text, 0)
  if (first < 0 || text[first] !== '{') return null

  const result: ParsedTopLevelArray[] = []
  let i = nextToken(text, first + 1)
  if (i < 0) return null
  if (text[i] === '}') return result

  for (;;) {
    if (text[i] !== '"') return null
    // 键名一定是短字符串，直接复用 JSON.parse 做转义还原
    const keyStart = i
    let esc = false
    for (i++; i < text.length; i++) {
      const c = text[i]
      if (esc) esc = false
      else if (c === '\\') esc = true
      else if (c === '"') break
    }
    if (i >= text.length) return null
    let key: string
    try {
      key = JSON.parse(text.slice(keyStart, i + 1)) as string
    } catch {
      return null
    }

    const colon = nextToken(text, i + 1)
    if (colon < 0 || text[colon] !== ':') return null
    const valueStart = nextToken(text, colon + 1)
    if (valueStart < 0) return null

    if (text[valueStart] === '[') {
      const sliced = sliceArrayRecords(text, valueStart, onProgress)
      if (!sliced) return null
      result.push({ key, records: sliced.records })
      i = sliced.end
    } else {
      const after = skipValue(text, valueStart)
      if (after < 0) return null
      i = after
    }

    const sep = nextToken(text, i)
    if (sep < 0) return null
    if (text[sep] === ',') {
      i = nextToken(text, sep + 1)
      if (i < 0) return null
      continue
    }
    if (text[sep] === '}') return result
    return null
  }
}

/**
 * 从 `start`（某个值的第一个非空白字符）跳到该值之后的下标。
 *
 * 对 `[` / `{` 走一次括号配对；对字符串走一次转义扫描；
 * 对数字/true/false/null 走一次字面量扫描（字面量里不含空白与 `,` `]` `}`）。
 */
function skipValue(text: string, start: number): number {
  const c = text[start]
  if (c === '[' || c === '{') {
    let depth = 0
    let inStr = false
    let esc = false
    for (let i = start; i < text.length; i++) {
      const ch = text[i]
      if (inStr) {
        if (esc) esc = false
        else if (ch === '\\') esc = true
        else if (ch === '"') inStr = false
        continue
      }
      if (ch === '"') inStr = true
      else if (ch === '[' || ch === '{') depth++
      else if (ch === ']' || ch === '}') {
        depth--
        if (depth === 0) return i + 1
      }
    }
    return -1
  }
  if (c === '"') {
    let esc = false
    for (let i = start + 1; i < text.length; i++) {
      const ch = text[i]
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') return i + 1
    }
    return -1
  }
  let i = start
  while (i < text.length) {
    const ch = text[i]
    if (ch === ',' || ch === '}' || ch === ']' || ch === ' ' || ch === '\n' || ch === '\r' || ch === '\t') break
    i++
  }
  return i
}
