<script lang="ts">
/** 选项类型导出给各调用方标注数组，避免只写 `{ value: 'x' }` 时字面量类型丢失 */
export interface SegOption<T> {
  value: T
  label: string
  /** 可选的图标组件（如 lucide 图标），会渲染在文字前 */
  icon?: unknown
  disabled?: boolean
}
</script>

<script setup lang="ts" generic="SEG extends string | number | boolean">
/**
 * 分段选择器：设置页「外观模式 / 字号」所用的交互样式，抽成组件供各页复用。
 *
 * 样式来自全局 `src/styles/index.css` 的 `.seg` / `.seg-item`（设置页样式已提到全局），
 * 本组件**不重新定义**它们——同一套外观只有一处定义，才不会随时间走样。
 *
 * 无障碍：整体是 radiogroup，每项是 radio 并带 aria-checked；
 * 键盘用 Tab 聚焦、Enter/Space 触发（原生 button 行为）。
 */
const props = defineProps<{
  /** 当前选中值 */
  value: SEG
  /** 选项列表；用 readonly 是为了同时接受 `as const` 的字面量数组 */
  options: readonly SegOption<SEG>[]
  /** 无障碍分组名，如「外观模式」 */
  ariaLabel?: string
}>()

const emit = defineEmits<{ (e: 'update:value', value: SEG): void }>()

function pick(opt: SegOption<SEG>): void {
  if (opt.disabled) return
  if (opt.value !== props.value) emit('update:value', opt.value)
}
</script>

<template>
  <!-- class 名与全局样式约定一致（.seg / .seg-item / .is-active） -->
  <div class="seg" role="radiogroup" :aria-label="ariaLabel">
    <button v-for="opt in options" :key="String(opt.value)" type="button" class="seg-item"
      :class="{ 'is-active': opt.value === value }" :aria-checked="opt.value === value" :disabled="opt.disabled"
      role="radio" @click="pick(opt)">
      <el-icon v-if="opt.icon" :size="14">
        <component :is="opt.icon" />
      </el-icon>
      {{ opt.label }}
    </button>
  </div>
</template>
