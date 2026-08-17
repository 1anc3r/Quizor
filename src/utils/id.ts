/** 生成带前缀的唯一 id */
export function genId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

/** 依据题库内已有题目 id 生成下一个题目 id：<bankId>_000123 形式 */
export function nextQuestionId(bankId: string, existingIds: string[]): string {
  let max = 0
  const re = new RegExp(`^${bankId}_(\\d+)$`)
  for (const id of existingIds) {
    const m = id.match(re)
    if (m) max = Math.max(max, parseInt(m[1], 10))
  }
  return `${bankId}_${String(max + 1).padStart(6, '0')}`
}
