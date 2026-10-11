/// <reference types="vite/client" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<Record<string, never>, Record<string, never>, unknown>
  export default component
}

declare global {
  // Element Plus 按需引入时由 unplugin-auto-import 自动注入，这里补充类型声明
  const ElMessage: typeof import('element-plus')['ElMessage']
  const ElMessageBox: typeof import('element-plus')['ElMessageBox']
  const ElLoading: typeof import('element-plus')['ElLoading']
  const ElNotification: typeof import('element-plus')['ElNotification']

  interface Navigator {
    /**
     * 网络信息 API。Safari / Firefox 上不存在，因此所有读取都必须可选链。
     * 仅用于"要不要后台预取全文"的判断，缺失时按"网络良好"处理。
     */
    readonly connection?: {
      /** 用户开启了流量节省模式 */
      readonly saveData?: boolean
      /** 有效连接类型，慢速网络下不做后台预取 */
      readonly effectiveType?: string
    }
  }
}

export {}
