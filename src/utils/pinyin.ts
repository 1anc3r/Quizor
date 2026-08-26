/**
 * 将题库名称转换为拼音 id，用于创建题库 ID。
 * 例：「199_管理类综合能力」→「199_guan_li_lei_zong_he_neng_li」
 */
import { pinyin } from 'pinyin-pro'
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

/** 在已有 ID 集合中生成唯一 ID：基础 ID 冲突时追加 _1、_2 ... 直至唯一 */
export function uniqueBankId(baseId: string, existingIds: string[]): string {
  if (!existingIds.includes(baseId)) return baseId
  let i = 2
  while (existingIds.includes(`${baseId}_${i}`)) i++
  return `${baseId}_${i}`
}
