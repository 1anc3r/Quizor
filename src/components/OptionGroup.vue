<script setup lang="ts">
/**
 * 选项组：圆形 key 按钮 + 内容自动换行。
 * 单选/判断点击即替换；多选点击切换。
 * 揭示答案后：正确选项绿色、错选红色。
 */
import type { Question } from '@/types'
import RichText from './RichText.vue'

const props = withDefaults(
  defineProps<{
    question: Question
    selected: string[]
    /** 已揭示答案（练习即时反馈 / 回顾模式） */
    revealed?: boolean
    /** 禁止交互 */
    disabled?: boolean
  }>(),
  { revealed: false, disabled: false }
)

const emit = defineEmits<{ (e: 'select', keys: string[]): void }>()

function onPick(key: string): void {
  if (props.disabled || props.revealed) return
  if (props.question.type === 'multiple') {
    const set = new Set(props.selected)
    if (set.has(key)) set.delete(key)
    else set.add(key)
    emit('select', [...set].sort())
  } else {
    emit('select', [key])
  }
}

function optionClass(key: string): Record<string, boolean> {
  const isSelected = props.selected.includes(key)
  const isAnswer = props.question.answer.includes(key)
  return {
    'is-selected': isSelected && !props.revealed,
    'is-correct': props.revealed && isAnswer,
    'is-wrong': props.revealed && isSelected && !isAnswer,
    disabled: props.disabled || props.revealed
  }
}
</script>

<template>
  <div class="option-list">
    <div
      v-for="opt in question.options"
      :key="opt.key"
      class="option-item"
      :class="optionClass(opt.key)"
      @click="onPick(opt.key)"
    >
      <span class="option-key">{{ opt.key }}</span>
      <span class="option-text"><RichText :content="opt.text" /></span>
    </div>
  </div>
</template>
