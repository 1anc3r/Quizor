<script setup lang="ts">
/**
 * 结算页：练习/考试共用。
 * 展示分数（考试为 得分/试卷总分）、正确率、错题数、用时，
 * 逐题回顾（可按答题卡跳转/筛选）；考试简答题支持自评后更新成绩。
 */
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { loadBank } from '@/services/bank'
import { recomputeRecord } from '@/services/session'
import { useUserDataStore } from '@/stores/userData'
import type { Question, QuizRecord, RecordDetail } from '@/types'
import { fmtDuration, fmtTime } from '@/utils/format'
import QuestionDetail from '@/components/QuestionDetail.vue'
import RichText from '@/components/RichText.vue'

const route = useRoute()
const router = useRouter()
const userStore = useUserDataStore()

const record = ref<QuizRecord | null>(null)
const qMap = ref<Map<string, Question>>(new Map())
const filter = ref<'all' | 'right' | 'wrong' | 'pending'>('all')

onMounted(async () => {
  const bankId = String(route.params.bankId)
  const recordId = String(route.params.recordId)
  // 记录按题库分桶存储；若当前未加载该题库则直接载入其记录桶
  if (userStore.bankId !== bankId) userStore.load(bankId)
  const rec = userStore.getRecord(recordId)
  if (!rec) {
    ElMessage.error('记录不存在')
    router.replace('/')
    return
  }
  record.value = rec
  try {
    const data = await loadBank(bankId)
    qMap.value = new Map(data.Questions.map((q) => [q.id, q]))
  } catch {
    /* 题库可能被删除，回顾时退化为展示题干快照 */
  }
})

const isExam = computed(() => record.value?.mode === 'exam')

const filteredDetails = computed(() => {
  if (!record.value) return []
  return record.value.details.filter((d) => {
    if (filter.value === 'right') return d.correct === true
    if (filter.value === 'wrong') return d.correct === false
    if (filter.value === 'pending') return d.correct === null
    return true
  })
})

function detailClass(d: RecordDetail): string {
  if (d.correct === true) return 'cell-right'
  if (d.correct === false) return 'cell-wrong'
  return 'cell-pending'
}

/** 你的答案文本还原为已选 key 数组（用于选项高亮） */
function selectedKeys(d: RecordDetail): string[] {
  if (d.type === 'text' || d.yourAnswer === '（未作答）') return []
  return d.yourAnswer.split('、').filter(Boolean)
}

function jumpTo(qid: string): void {
  document.getElementById(`review-${qid}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

/** 简答题自评（考试模式统一判分后补判，成绩即时重算） */
function selfGrade(d: RecordDetail, correct: boolean): void {
  if (!record.value) return
  d.correct = correct
  recomputeRecord(record.value)
  userStore.updateRecord(record.value)
  if (!correct) userStore.addWrong(d.questionId, d.yourAnswer)
}
</script>

<template>
  <div v-if="record">
    <el-card class="page-card" shadow="never">
      <div class="card-title">
        <span class="title-text">
          {{ isExam ? '考试' : '练习' }}结算
          <span v-if="record.paperName" class="muted" style="margin-left: 8px">{{ record.paperName }}</span>
        </span>
        <el-button type="primary" @click="router.replace('/')">返回首页</el-button>
      </div>
      <div class="stat-grid" style="margin-top: 16px">
        <div class="stat-item">
          <div class="num">
            {{ record.score }}<span v-if="isExam" style="font-size: 14px; font-weight: 400"> / {{ record.totalScore }}</span>
          </div>
          <div class="label">{{ isExam ? '得分 / 试卷总分' : '本次得分' }}</div>
        </div>
        <div class="stat-item">
          <div class="num">{{ record.accuracy }}%</div>
          <div class="label">正确率</div>
        </div>
        <div class="stat-item">
          <div class="num">{{ record.wrong }}</div>
          <div class="label">错题数</div>
        </div>
        <div class="stat-item">
          <div class="num">{{ fmtDuration(record.durationSec) }}</div>
          <div class="label">用时</div>
        </div>
      </div>
      <div class="muted" style="margin-top: 12px">
        {{ record.bankName }} · 共 {{ record.total }} 题 · 已答 {{ record.answered }} 题 · {{ fmtTime(record.endTime) }}
      </div>
    </el-card>

    <!-- 答题卡切换 -->
    <el-card class="page-card" shadow="never">
      <div class="card-title" style="margin-bottom: 12px">
        <span class="title-text">答题卡</span>
        <el-radio-group v-model="filter" size="small">
          <el-radio-button value="all">全部</el-radio-button>
          <el-radio-button value="right">答对</el-radio-button>
          <el-radio-button value="wrong">答错</el-radio-button>
          <el-radio-button value="pending">未答/待评</el-radio-button>
        </el-radio-group>
      </div>
      <div class="sheet-grid">
        <button
          v-for="(d, i) in record.details"
          :key="d.questionId"
          class="sheet-cell"
          :class="detailClass(d)"
          @click="jumpTo(d.questionId)"
        >
          {{ i + 1 }}
        </button>
      </div>
      <div class="sheet-legend">
        <span><i class="lg-right"></i>答对</span>
        <span><i class="lg-wrong"></i>答错</span>
        <span><i></i>未答/待评</span>
      </div>
    </el-card>

    <!-- 逐题回顾 -->
    <el-card
      v-for="d in filteredDetails"
      :id="`review-${d.questionId}`"
      :key="d.questionId"
      class="page-card"
      shadow="never"
    >
      <div class="card-title" style="margin-bottom: 8px">
        <span>
          第 {{ record.details.indexOf(d) + 1 }} 题
          <el-tag v-if="d.correct === true" type="success" size="small" style="margin-left: 8px">正确</el-tag>
          <el-tag v-else-if="d.correct === false" type="danger" size="small" style="margin-left: 8px">错误</el-tag>
          <el-tag v-else type="info" size="small" style="margin-left: 8px">{{ d.type === 'text' ? '待自评' : '未作答' }}</el-tag>
        </span>
        <span class="muted">{{ d.gotScore }} / {{ d.score }} 分</span>
      </div>
      <QuestionDetail
        v-if="qMap.get(d.questionId)"
        :question="qMap.get(d.questionId)!"
        :selected="selectedKeys(d)"
        :your-answer="d.yourAnswer"
      />
      <RichText v-else class="q-stem" :content="d.stem" />
      <div class="muted" style="margin-top: 8px">你的答案：{{ d.yourAnswer }} · 正确答案：{{ d.rightAnswer }}</div>
      <div v-if="d.type === 'text' && isExam" style="margin-top: 10px">
        <span class="muted" style="margin-right: 8px">自评：</span>
        <el-button size="small" :type="d.correct === true ? 'success' : 'default'" @click="selfGrade(d, true)">
          我答对了
        </el-button>
        <el-button size="small" :type="d.correct === false ? 'danger' : 'default'" @click="selfGrade(d, false)">
          我答错了
        </el-button>
      </div>
    </el-card>
  </div>
</template>

<style scoped>
.cell-right {
  background: rgba(103, 194, 58, 0.2);
  border-color: var(--q-success);
  color: var(--q-success);
}
.cell-wrong {
  background: rgba(245, 108, 108, 0.2);
  border-color: var(--q-danger);
  color: var(--q-danger);
}
.cell-pending {
  background: var(--q-card);
}
.lg-right {
  background: rgba(103, 194, 58, 0.35);
  border-color: var(--q-success);
}
.lg-wrong {
  background: rgba(245, 108, 108, 0.35);
  border-color: var(--q-danger);
}
</style>
