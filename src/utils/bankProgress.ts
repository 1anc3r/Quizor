/**
 * 题库加载进度的文案口径（首页进度条、做题设置页、恢复会话页共用）。
 *
 * 为什么要抽出来：进度条上"百分比 / 字节数"的**分母单位**曾经在三处各写一遍，
 * 其中一处错用了响应头的 `Content-Length`（gzip 下是压缩体积，与流式分片的
 * 解压字节不同量纲），于是显示 "1.06 MB / 1.20 MB"、百分比冲到 480%。
 * 分母是否可信只有 `BankLoadProgress.total` 说了算，判断逻辑就该只有一份。
 */
import type { BankLoadProgress } from '@/services/bankWorkerApi'
import { fmtBytesPrecise } from '@/utils/format'

/** 阶段的中文说明（`done` 不是下载/解析/规整中的任何一段，只是收尾） */
export function bankPhaseLabel(phase: BankLoadProgress['phase']): string {
  switch (phase) {
    case 'download':
      return '下载题库全文'
    case 'parse':
      return '解析题库数据'
    case 'normalize':
      return '整理题库数据'
    default:
      return '即将完成'
  }
}

/** 已知总量时的百分比（0-100 取整）；总量未知返回 null，调用方据此不要显示数字 */
export function bankPercent(p: BankLoadProgress): number | null {
  if (!(p.total > 0)) return null
  return Math.round(Math.min(1, Math.max(0, p.loaded / p.total)) * 100)
}

/**
 * 字节文案。总量未知时只报"已经下了多少"，不摆一个假的分母 ——
 * 假分母比没有数字更糟：用户会据此估算剩余时间。
 */
export function bankBytesText(p: BankLoadProgress): string {
  return p.total > 0 ? `${fmtBytesPrecise(p.loaded)} / ${fmtBytesPrecise(p.total)}` : `已下载 ${fmtBytesPrecise(p.loaded)}`
}

/**
 * 一行式进度摘要，形如 `下载题库全文… 42%（2.4 MB / 5.78 MB）`。
 *
 * 三段进度（下载 / 解析 / 整理）里只有下载有字节数可报：worker 在解析与整理阶段
 * 只回传权重占比，`loaded`/`total` 都是 0，所以那两段只能按 `ratio` 显示百分比。
 */
export function bankProgressText(p: BankLoadProgress): string {
  const label = `${bankPhaseLabel(p.phase)}…`
  if (p.phase === 'download') {
    const percent = bankPercent(p)
    if (percent === null) return p.loaded > 0 ? `${label} ${bankBytesText(p)}` : label
    return `${label} ${percent}%（${bankBytesText(p)}）`
  }
  if (p.phase === 'done') return label
  return `${label} ${Math.round(Math.min(1, Math.max(0, p.ratio)) * 100)}%`
}
