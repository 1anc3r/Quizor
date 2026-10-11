<script setup lang="ts">
/**
 * 错题本（当前题库）：答错自动收录（同题更新），支持关键字查询、
 * 章节/题型/来源筛选、按错误次数/时间排序、明细展开、练习入口、单条/批量移除。
 */
import { computed, onMounted, ref, watch } from 'vue'
import { useIsMobile } from '@/composables/useIsMobile'
import { PAGE_SIZES, PAGINATION_LAYOUT, usePagedList } from '@/composables/usePagedList'
import { useQuestionFilters } from '@/composables/useQuestionFilters'
import { useRowSelection } from '@/composables/useRowSelection'
import { useRouter } from 'vue-router'
import { useBankStore } from '@/stores/bankStore'
import { useSettingsStore } from '@/stores/settings'
import { useUserDataStore } from '@/stores/userData'
import type { Question, WrongItem } from '@/types'
import { TYPE_OPTIONS, fmtTime, plainText, shortId, truncate, typeLabel } from '@/utils/format'
import SegmentedControl, { type SegOption } from '@/components/SegmentedControl.vue'
import QuizDetail from '@/components/QuizDetail.vue'

const router = useRouter()
const bankStore = useBankStore()
const settingsStore = useSettingsStore()
const userStore = useUserDataStore()

const sortBy = ref<'count' | 'time'>('time')
const isMobile = useIsMobile()

interface WrongRow {
  item: WrongItem
  question: Question
}

// 关键字 + 章节/题型/来源：与收藏夹、题库管理的题目列表共用同一份筛选状态
const {
  keyword,
  chapter: filterChapter,
  type: filterType,
  source: filterSource,
  matches
} = useQuestionFilters()

const rows = computed<WrongRow[]>(() => {
  const out: WrongRow[] = []
  for (const item of Object.values(userStore.wrong)) {
    const q = bankStore.questionMap.get(item.questionId)
    if (!q || !matches(q)) continue
    out.push({ item, question: q })
  }
  out.sort((a, b) => (sortBy.value === 'count' ? b.item.count - a.item.count : b.item.lastTime - a.item.lastTime))
  return out
})

// ---------- 分页 ----------
const { currentPage, pageSize, pagedRows, resetPage } = usePagedList(rows)

// 换过滤条件时回到第一页；列表自身增删只收拢页码，不把用户弹回开头
watch([keyword, filterChapter, filterType, filterSource], resetPage)

const { selection, onSelectionChange, clearSelection } = useRowSelection<WrongRow>()

// 有错题、但全文还没到位：此刻列表为空是「还在加载」，不是「没有错题」
const pendingRows = computed(
  () => !rows.value.length && bankStore.loading && Object.keys(userStore.wrong).length > 0
)

// 冷启动直接进 #/wrong 时全文还没加载（首页的空闲预取最长要数秒），questionMap 还是空的，
// 列表会先显示「暂无错题」，看着像题目丢了。错题本本来就要靠全文回填题干，这里直接要一次。
onMounted(() => {
  void bankStore.ensureFullBank()
})

// 排序方式：与设置页「外观模式」同一套分段选择器样式
const SORT_OPTIONS: SegOption<'count' | 'time'>[] = [
  { value: 'count', label: '按次数' },
  { value: 'time', label: '按时间' }
]

function goPractice(): void {
  router.push({ path: '/setup/practice', query: { scope: 'wrong' } })
}

async function removeOne(row: WrongRow): Promise<void> {
  try {
    await ElMessageBox.confirm('确定将该题移出错题本吗？', '移除错题', { type: 'warning' })
  } catch {
    return
  }
  userStore.removeWrong([row.item.questionId])
}

async function removeBatch(): Promise<void> {
  try {
    await ElMessageBox.confirm(`确定将选中的 ${selection.value.length} 题移出错题本吗？`, '批量移除', { type: 'warning' })
  } catch {
    return
  }
  userStore.removeWrong(selection.value.map((r) => r.item.questionId))
  clearSelection()
}
</script>

<template>
  <div v-if="isMobile" class="brand" style="margin-bottom: 16px;">Quizor<span>做题家 · 错题本</span></div>
  <div class="app-content">
    <el-card class="page-card" shadow="never">
      <div class="card-title">
        <span class="title-text">错题本（{{ bankStore.meta?.name }}）</span>
        <el-button type="primary" :disabled="!rows.length && !Object.keys(userStore.wrong).length" @click="goPractice">
          练习错题
        </el-button>
      </div>

      <div style="display: flex; gap: 12px; flex-wrap: wrap; margin: 12px 0">
        <el-input v-model="keyword" placeholder="关键字查询" clearable style="width: 324px" />
        <el-select v-model="filterSource" placeholder="来源" clearable style="width: 100px">
          <el-option v-for="s in bankStore.sources" :key="s" :label="s" :value="s" />
        </el-select>
        <el-select v-model="filterChapter" placeholder="章节" clearable style="width: 100px">
          <el-option v-for="c in bankStore.chapters" :key="c" :label="c" :value="c" />
        </el-select>
        <el-select v-model="filterType" placeholder="题型" clearable style="width: 100px">
          <el-option v-for="t in TYPE_OPTIONS" :key="t.value" :label="t.label" :value="t.value" />
        </el-select>
        <el-button v-if="selection.length > 0" type="danger" plain :disabled="!selection.length" @click="removeBatch">
          批量移除（{{ selection.length }}）
        </el-button>
        <SegmentedControl v-model:value="sortBy" :options="SORT_OPTIONS" aria-label="排序方式" />
      </div>

      <el-table stripe :data="pagedRows" row-key="item.questionId" @selection-change="onSelectionChange">
        <el-table-column type="selection" width="40" fixed="left" />
        <el-table-column type="expand">
          <template #default="{ row }">
            <div style="padding: 8px 16px">
              <QuizDetail :question="row.question" />
              <div class="muted" style="margin-top: 8px">
                你的答案：{{ row.item.lastAnswer || '（未作答）' }} · 正确答案：{{
                  row.question.type === 'text' ? '见解析' : [...row.question.answer].sort().join('、')
                }}
                · 结果：错误 · 错误次数：{{ row.item.count }} · 最近错误：{{ fmtTime(row.item.lastTime) }} · 连续答对：{{
                  row.item.streak
                }}/{{ settingsStore.settings.wrongThreshold }}（达到阈值自动移出，可在设置修改）
              </div>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="题号" v-if="!isMobile" width="80">
          <template #default="{ row }">
            <span :title="row.question.id">{{ shortId(row.question.id) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="章节" v-if="!isMobile" width="150" show-overflow-tooltip>
          <template #default="{ row }">{{ row.question.chapter }}</template>
        </el-table-column>
        <el-table-column label="题型" v-if="!isMobile" width="80">
          <template #default="{ row }">{{ typeLabel(row.question.type) }}</template>
        </el-table-column>
        <el-table-column label="题干" min-width="200" show-overflow-tooltip>
          <template #default="{ row }">{{ truncate(plainText(row.question.stem), 50) }}</template>
        </el-table-column>
        <el-table-column label="难度" v-if="!isMobile" width="130">
          <template #default="{ row }">
            <el-rate v-model="row.question.difficulty" :max="5" size="small" disabled />
          </template>
        </el-table-column>
        <el-table-column label="错误次数" width="80">
          <template #default="{ row }">{{ row.item.count }}</template>
        </el-table-column>
        <el-table-column label="最近错误" width="150">
          <template #default="{ row }">{{ fmtTime(row.item.lastTime) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="80" fixed="right">
          <template #default="{ row }">
            <el-button link type="danger" @click="removeOne(row)">移除</el-button>
          </template>
        </el-table-column>
      </el-table>

      <!-- 分页 -->
      <el-pagination v-model:current-page="currentPage" v-model:page-size="pageSize" :page-sizes="PAGE_SIZES"
        :total="rows.length" :hide-on-single-page="true" :layout="PAGINATION_LAYOUT"
        style="margin-top: 12px" />

      <el-empty v-if="pendingRows" description="正在加载…" />
      <el-empty v-else-if="!rows.length" description="暂无错题" />
    </el-card>
  </div>
</template>