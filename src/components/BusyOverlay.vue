<script setup lang="ts">
/**
 * 全局忙碌遮罩：半透明遮罩 + 圆形进度弹窗。
 *
 * 组卷 / 交卷判分等重计算进行时盖住全屏：既挡住重复点击，也把"在干什么、
 * 干到哪了"画出来 —— 没有反馈的等待，体感就是卡住。
 *
 * - `ratio` 为 0-1 的**总**进度（Worker 逐批上报），圆环连续走动并显示百分比；
 * - `ratio` 为 null（尚未拿到第一批进度）时退化为旋转的不确定态，不编假百分比。
 *
 * 通过 teleport 挂到 body，遮罩层级（z-index 3000）高于抽屉与对话框，
 * 在任何页面结构里都能盖住全屏。
 */
import { computed } from 'vue'

const props = withDefaults(
  defineProps<{
    visible: boolean
    /** 弹窗主标题，如「正在组卷…」「正在结算…」 */
    title: string
    /** 阶段文案（Worker 进度里的 label），如「正在逐题判分…」 */
    detail?: string
    /** 0-1 总进度；null/缺省 = 未知，显示旋转动画 */
    ratio?: number | null
  }>(),
  { detail: '', ratio: null }
)

const R = 26
const CIRC = 2 * Math.PI * R

const percent = computed<number | null>(() =>
  props.ratio == null ? null : Math.round(Math.min(1, Math.max(0, props.ratio)) * 100)
)

/** 圆环描边偏移：0% 时全空，100% 时闭合；transition 让批间进度平滑过渡 */
const dashOffset = computed(() => CIRC * (1 - (percent.value ?? 0) / 100))
</script>

<template>
  <teleport to="body">
    <transition name="busy-fade">
      <div v-if="visible" class="busy-mask" role="status" aria-live="polite">
        <div class="busy-dialog">
          <div class="busy-ring-wrap">
            <svg class="busy-ring" :class="{ 'is-indeterminate': percent === null }" viewBox="0 0 64 64" width="72"
              height="72">
              <circle class="busy-track" cx="32" cy="32" :r="R" fill="none" stroke-width="6" />
              <circle class="busy-bar" cx="32" cy="32" :r="R" fill="none" stroke-width="6" stroke-linecap="round"
                :stroke-dasharray="CIRC" :stroke-dashoffset="dashOffset" transform="rotate(-90 32 32)" />
            </svg>
            <span v-if="percent !== null" class="busy-percent">{{ percent }}<em>%</em></span>
          </div>
          <div class="busy-title">{{ title }}</div>
          <div class="busy-detail">{{ detail }}</div>
        </div>
      </div>
    </transition>
  </teleport>
</template>

<style scoped>
.busy-mask {
  position: fixed;
  inset: 0;
  z-index: 3000;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgb(15 23 42 / 0.45);
  backdrop-filter: blur(2px);
}

.busy-dialog {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  min-width: 220px;
  max-width: 320px;
  padding: 28px 36px 24px;
  background: var(--q-card);
  border: 1px solid var(--q-border);
  border-radius: var(--q-radius-lg);
  box-shadow: var(--q-shadow-md);
}

.busy-ring-wrap {
  position: relative;
  width: 72px;
  height: 72px;
}

.busy-ring {
  display: block;
}

.busy-track {
  stroke: var(--q-border);
}

.busy-bar {
  stroke: var(--q-primary);
  transition: stroke-dashoffset 0.25s ease;
}

/* 不确定态：不编百分比，画一段圆弧整体旋转 */
.busy-ring.is-indeterminate {
  animation: busy-spin 1s linear infinite;
}

.busy-ring.is-indeterminate .busy-bar {
  stroke-dasharray: 42 200;
  stroke-dashoffset: -12;
}

.busy-percent {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 14px;
  font-weight: 600;
  color: var(--q-text);
  font-variant-numeric: tabular-nums;
}

.busy-percent em {
  font-style: normal;
  font-size: 11px;
  margin-left: 1px;
}

.busy-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--q-text);
}

.busy-detail {
  font-size: 12px;
  color: var(--q-text-secondary);
  min-height: 1.2em;
  text-align: center;
}

@keyframes busy-spin {
  to {
    transform: rotate(360deg);
  }
}

.busy-fade-enter-active,
.busy-fade-leave-active {
  transition: opacity 0.2s ease;
}

.busy-fade-enter-from,
.busy-fade-leave-to {
  opacity: 0;
}
</style>
