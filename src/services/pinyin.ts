import { pinyin } from 'pinyin-pro'

/**
 * 将题库名称转换为拼音 id，用于创建题库 ID。
 * 例：「199_管理类综合能力」→「199_guan_li_lei_zong_he_neng_li」
 */
export function nameToBankId(name: string): string {
  const arr = pinyin(name, { toneType: 'none', type: 'array' })
  const joined = arr
    .join('_')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_{2,}/g, '_')
  return joined || `bank_${Date.now().toString(36)}`
}

/** 在已有 id 集合内保证唯一，冲突时追加 _2、_3… */
export function uniqueBankId(base: string, taken: string[]): string {
  if (!taken.includes(base)) return base
  let i = 2
  while (taken.includes(`${base}_${i}`)) i++
  return `${base}_${i}`
}
