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
}

export {}
