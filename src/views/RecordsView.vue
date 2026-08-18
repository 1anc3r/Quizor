<script setup lang="ts">
/**
 * 记录页（当前题库）：做题记录列表 + 展开作答明细 + 统计图表。
 * ECharts 仅在本页动态导入、按需注册，不进入首屏 bundle。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { ECharts } from 'echarts/core'
import { useBankStore } from '@/stores/bank'
import { useUserDataStore } from '@/stores/userData'
import type { QuizRecord } from '@/types'
import { fmtDuration, fmtTime, fmtTimeShort, typeLabel } from '@/utils/format'
import QuestionDetail from '@/components/QuestionDetail.vue'

const bankStore = useBankStore()
const userStore = useUserDataStore()

const sortedRecords = computed(() => [...userStore.records].sort((a, b) => b.endTime - a.endTime))

// ---------- 分页 ----------
const pageSize = ref(20)
const currentPage = ref(1)

const pagedRecords = computed(() => {
  const start = (currentPage.value - 1) * pageSize.value
  const end = start + pageSize.value
  return sortedRecords.value.slice(start, end)
})

// 当总记录数变化或每页条数变化时重置页码
watch(sortedRecords, () => {
  currentPage.value = 1
})
watch(pageSize, () => {
  currentPage.value = 1
})

const isMobile = ref(window.innerWidth <= 768)

function selectedKeysOf(rec: QuizRecord, qid: string): string[] {
  const d = rec.details.find((x) => x.questionId === qid)
  if (!d || d.type === 'text' || d.yourAnswer === '（未作答）') return []
  return d.yourAnswer.split('、').filter(Boolean)
}

/* ---------- ECharts：动态导入 + 按需注册 ---------- */

const trendRef = ref<HTMLElement>()
const chapterRef = ref<HTMLElement>()
let trendChart: ECharts | null = null
let chapterChart: ECharts | null = null

async function renderCharts(): Promise<void> {
  if (!userStore.records.length) return
  const [core, charts, components, renderers] = await Promise.all([
    import('echarts/core'),
    import('echarts/charts'),
    import('echarts/components'),
    import('echarts/renderers')
  ])
  core.use([
    charts.LineChart,
    charts.BarChart,
    components.GridComponent,
    components.TooltipComponent,
    components.TitleComponent,
    renderers.CanvasRenderer
  ])

  // 正确率趋势（按时间正序）
  const chronological = [...userStore.records].sort((a, b) => a.endTime - b.endTime)
  if (trendRef.value) {
    trendChart = trendChart ?? core.init(trendRef.value)
    trendChart.setOption({
      title: { text: '正确率趋势', textStyle: { fontSize: 14 } },
      tooltip: { trigger: 'axis' },
      grid: { left: 48, right: 16, top: 40, bottom: 32 },
      xAxis: { type: 'category', data: chronological.map((r) => fmtTimeShort(r.endTime)) },
      yAxis: { type: 'value', min: 0, max: 100, axisLabel: { formatter: '{value}%' } },
      series: [{ type: 'line', smooth: true, data: chronological.map((r) => r.accuracy), areaStyle: {} }]
    })
  }

  // 分章节正确率
  const agg = new Map<string, { right: number; judged: number }>()
  for (const r of userStore.records) {
    for (const d of r.details) {
      if (d.correct === null) continue
      const cur = agg.get(d.chapter) ?? { right: 0, judged: 0 }
      cur.judged++
      if (d.correct) cur.right++
      agg.set(d.chapter, cur)
    }
  }
  const chapters = [...agg.keys()]
  if (chapterRef.value && chapters.length) {
    chapterChart = chapterChart ?? core.init(chapterRef.value)
    chapterChart.setOption({
      title: { text: '分章节正确率', textStyle: { fontSize: 14 } },
      tooltip: { trigger: 'axis' },
      grid: { left: 48, right: 16, top: 40, bottom: 60 },
      xAxis: { type: 'category', data: chapters, axisLabel: { rotate: 20 } },
      yAxis: { type: 'value', min: 0, max: 100, axisLabel: { formatter: '{value}%' } },
      series: [
        {
          type: 'bar',
          data: chapters.map((c) => {
            const a = agg.get(c)!
            return Math.round((a.right / a.judged) * 100)
          }),
          itemStyle: { color: '#409eff' }
        }
      ]
    })
  }
}

function onResize(): void {
  trendChart?.resize()
  chapterChart?.resize()
  isMobile.value = window.innerWidth <= 768
}

onMounted(() => {
  void renderCharts()
  window.addEventListener('resize', onResize)
})

watch(sortedRecords, () => void renderCharts())

onBeforeUnmount(() => {
  window.removeEventListener('resize', onResize)
  trendChart?.dispose()
  chapterChart?.dispose()
  trendChart = null
  chapterChart = null
})
</script>

<template>
  <div v-if="isMobile" class="brand" style="margin-bottom: 16px;">Quizor<span>做题家 · 记录</span></div>
  <div class="app-content">
    <el-card v-if="sortedRecords.length" class="page-card" shadow="never">
      <div class="card-title" style="margin-bottom: 8px">
        <span class="title-text">统计（{{ bankStore.meta?.name }}）</span>
      </div>
      <div class="chart-row">
        <div ref="trendRef" class="chart-box"></div>
        <div ref="chapterRef" class="chart-box"></div>
      </div>
    </el-card>

    <el-card class="page-card" shadow="never">
      <div class="card-title" style="margin-bottom: 8px">
        <span class="title-text">做题记录（{{ bankStore.meta?.name }}）</span>
      </div>
      <el-table :data="pagedRecords">
        <el-table-column type="expand">
          <template #default="{ row }">
            <div style="padding: 8px 16px">
              <el-card v-for="(d, i) in (row as QuizRecord).details" :key="d.questionId" shadow="never"
                style="margin-bottom: 10px">
                <div class="card-title" style="margin-bottom: 6px">
                  <span>
                    第 {{ i + 1 }} 题 · {{ d.chapter }} · {{ typeLabel(d.type) }}
                    <el-tag v-if="d.correct === true" type="success" size="small" style="margin-left: 8px">正确</el-tag>
                    <el-tag v-else-if="d.correct === false" type="danger" size="small"
                      style="margin-left: 8px">错误</el-tag>
                    <el-tag v-else type="info" size="small" style="margin-left: 8px">未答/待评</el-tag>
                  </span>
                  <span class="muted">{{ d.gotScore }} / {{ d.score }} 分</span>
                </div>
                <QuestionDetail v-if="bankStore.questionMap.get(d.questionId)"
                  :question="bankStore.questionMap.get(d.questionId)!" :selected="selectedKeysOf(row, d.questionId)"
                  :your-answer="d.yourAnswer" />
                <div v-else class="muted">题目已删除。你的答案：{{ d.yourAnswer }} · 正确答案：{{ d.rightAnswer }}</div>
              </el-card>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="模式" width="80">
          <template #default="{ row }">
            <el-tag :type="row.mode === 'exam' ? 'warning' : 'primary'" size="small">
              {{ row.mode === 'exam' ? '考试' : '练习' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="bankName" label="题库名称" v-if="!isMobile" min-width="200" show-overflow-tooltip />
        <el-table-column prop="total" v-if="!isMobile" label="题数" width="80" />
        <el-table-column prop="answered" v-if="!isMobile" label="已答" width="80" />
        <el-table-column prop="correct" label="正确" width="80" />
        <el-table-column prop="wrong" label="错误" width="80" />
        <el-table-column label="正确率" width="80">
          <template #default="{ row }">{{ row.accuracy }}%</template>
        </el-table-column>
        <el-table-column label="用时" width="100">
          <template #default="{ row }">{{ fmtDuration(row.durationSec) }}</template>
        </el-table-column>
        <el-table-column label="时间" width="150">
          <template #default="{ row }">{{ fmtTime(row.endTime) }}</template>
        </el-table-column>
      </el-table>

      <!-- 分页 -->
      <el-pagination v-model:current-page="currentPage" v-model:page-size="pageSize" :page-sizes="[20, 50, 100]"
        :total="sortedRecords.length" :hide-on-single-page="true" layout="total, sizes, prev, pager, next, jumper"
        style="margin-top: 12px" />

      <el-empty v-if="!sortedRecords.length" description="暂无做题记录" />
    </el-card>
  </div>
</template>

<style scoped>
.chart-row {
  display: flex;
  gap: 16px;
  flex-wrap: wrap;
}

.chart-box {
  flex: 1;
  min-width: 300px;
  height: 260px;
}
</style>