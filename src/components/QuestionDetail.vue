<script setup lang="ts">
/**
 * 题目只读展示（回顾/明细场景）：题干、选项（标注正误与你的选择）、
 * 你的答案、正确答案、解析。结算页、错题本、收藏夹、记录页共用。
 */
import type { Question } from '@/types'
import OptionGroup from './OptionGroup.vue'
import RichText from './RichText.vue'
import { typeLabel } from '@/utils/format'

withDefaults(
  defineProps<{
    question: Question
    /** 选择题你的选择 */
    selected?: string[]
    /** 简答题你的作答文本 */
    yourAnswer?: string
    showAnalysis?: boolean
  }>(),
  { selected: () => [], yourAnswer: '', showAnalysis: true }
)
</script>

<template>
  <div class="question-detail">
    <div class="muted" style="margin-bottom: 8px">
      {{ typeLabel(question.type) }} · {{ question.chapter }} · 难度 
      <el-rate v-model="question.difficulty" size="small" :max="5" disabled/>
      <template v-if="question.source"> · {{ question.source }}</template>
    </div>
    <RichText class="q-stem" :content="question.stem" />
    <OptionGroup
      v-if="question.type !== 'text'"
      :question="question"
      :selected="selected"
      revealed
      disabled
    />
    <div v-else class="feedback" style="margin-top: 12px">
      <div class="fb-line"><span class="fb-label">你的作答：</span>{{ yourAnswer || '（未作答）' }}</div>
    </div>
    <template v-if="showAnalysis">
      <div class="feedback">
        <div v-if="question.type !== 'text'" class="fb-line">
          <span class="fb-label">正确答案：</span>{{ [...question.answer].sort().join('、') }}
        </div>
        <div class="fb-line"><span class="fb-label">解析：</span></div>
        <RichText :content="question.analysis || '（无解析）'" />
      </div>
    </template>
  </div>
</template>

<style scoped>
.question-detail {
  padding: 4px 0;
}
</style>
