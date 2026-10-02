import { onBeforeUnmount, onMounted, ref, type Ref } from 'vue'

/** 移动端断点：与样式表中的 `@media (max-width: 768px)` 保持一致 */
export const MOBILE_BREAKPOINT = 768

/**
 * 响应式判断当前是否处于移动端宽度。
 *
 * 监听器的注册与清理都由本 composable 负责，调用方无需再写
 * `onMounted(() => addEventListener('resize', ...))` /
 * `onBeforeUnmount(() => removeEventListener('resize', ...))`，
 * 避免各个视图各自复制样板时漏掉清理步骤而泄漏监听器。
 *
 * @param breakpoint 宽度阈值，默认 768
 * @returns 只读语义的 `isMobile` ref（`true` 表示宽度 ≤ breakpoint）
 */
export function useIsMobile(breakpoint: number = MOBILE_BREAKPOINT): Ref<boolean> {
  const isMobile = ref(false)

  const sync = (): void => {
    isMobile.value = window.innerWidth <= breakpoint
  }

  // 同步求值一次，避免首帧使用错误的默认值
  sync()

  onMounted(() => {
    window.addEventListener('resize', sync, { passive: true })
  })

  onBeforeUnmount(() => {
    window.removeEventListener('resize', sync)
  })

  return isMobile
}
