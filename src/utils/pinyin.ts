/**
 * 将题库名称转换为拼音 id，用于创建题库 ID。
 * 例：「199_管理类综合能力」→「199_guan_li_lei_zong_he_neng_li」
 *
 * pinyin-pro 自带 300KB 以上的字典数据，而全站只有"新建/导入题库"这一个动作需要它。
 * 若静态引入，这 300KB 会跟着入口包一起出现在首屏；这里改为动态 import，
 * Vite 会把它切成独立 chunk，只有真正创建题库时才下载。
 */
export async function nameToBankId(name: string): Promise<string> {
  const { pinyin } = await import('pinyin-pro')
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
