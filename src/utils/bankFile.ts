/**
 * 题库文件名约定（纯函数，构建期脚本与浏览器端共用）。
 *
 * 单独成文件的原因：构建插件（vite-plugins/bankIndex.ts）要读 Node 的 fs，
 * 浏览器端不能引入它；而"索引文件名怎么算"必须两边一致，否则运行时 fetch 404。
 */

/** 题库索引的文件名后缀 */
export const INDEX_SUFFIX = '_index.json'

/** `Bank_Kaoyan_Guanzong.json` → `Bank_Kaoyan_Guanzong_index.json` */
export function indexFileName(bankFile: string): string {
  return bankFile.replace(/\.json$/i, '') + INDEX_SUFFIX
}
