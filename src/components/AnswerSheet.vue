<script setup lang="ts">
/**
 * 答题卡：题号网格，标注已答 / 未答 / 标记 / 当前题。
 */
import type { AnswerState, QuizMode, SessionQuestion } from '@/types'

const props = defineProps<{
  questions: SessionQuestion[]
  answers: Record<string, AnswerState>
  marks: string[]
  current: number
  mode: QuizMode
}>()

const emit = defineEmits<{ (e: 'jump', index: number): void }>()

function isAnswered(i: number): boolean {
  const q = props.questions[i]
  const ans = props.answers[q.id]
  if (!ans) return false
  if (props.mode === 'practice') return ans.revealed
  return q.type === 'text' ? !!ans.text.trim() : ans.keys.length > 0
}

function cellClass(i: number): Record<string, boolean> {
  const q = props.questions[i]
  return {
    answered: isAnswered(i),
    marked: props.marks.includes(q.id),
    current: i === props.current
  }
}
</script>

<template>
  <div>
    <div class="sheet-grid">
      <button
        v-for="(q, i) in questions"
        :key="q.id"
        class="sheet-cell"
        :class="cellClass(i)"
        @click="emit('jump', i)"
      >
        {{ i + 1 }}
      </button>
    </div>
    <div class="sheet-legend">
      <span><i class="lg-answered"></i>已答</span>
      <span><i></i>未答</span>
      <span><i class="lg-marked"></i>标记</span>
    </div>
  </div>
</template>
