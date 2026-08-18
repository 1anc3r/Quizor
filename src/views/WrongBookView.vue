<script setup lang="ts">
/**
 * 错题本（当前题库）：答错自动收录（同题更新），支持关键字查询、
 * 章节/题型/来源筛选、按错误次数/时间排序、明细展开、练习入口、单条/批量移除。
 */
import { computed, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useBankStore } from '@/stores/bank'
import { useSettingsStore } from '@/stores/settings'
import { useUserDataStore } from '@/stores/userData'
import type { Question, QuestionType, WrongItem } from '@/types'
import { difficultyStars, fmtTime, plainText, shortId, truncate, typeLabel } from '@/utils/format'
import QuestionDetail from '@/components/QuestionDetail.vue'

const router = useRouter()
const bankStore = useBankStore()
const settingsStore = useSettingsStore()
const userStore = useUserDataStore()

const keyword = ref('')
const filterChapter = ref('')
const filterType = ref<'' | QuestionType>('')
const filterSource = ref('')
const sortBy = ref<'count' | 'time'>('time')
const selection = ref<WrongRow[]>([])
const isMobile = ref(window.innerWidth <= 768)

// ---------- 分页 ----------
const pageSize = ref(20)
const currentPage = ref(1)

interface WrongRow {
  item: WrongItem
  question: Question
}

const rows = computed<WrongRow[]>(() => {
  const kw = keyword.value.trim().toLowerCase()
  const out: WrongRow[] = []
  for (const item of Object.values(userStore.wrong)) {
    const q = bankStore.questionMap.get(item.questionId)
    if (!q) continue
    if (filterChapter.value && q.chapter !== filterChapter.value) continue
    if (filterType.value && q.type !== filterType.value) continue
    if (filterSource.value && q.source !== filterSource.value) continue
    if (kw && !plainText(q.stem).toLowerCase().includes(kw) && !q.chapter.toLowerCase().includes(kw)) continue
    out.push({ item, question: q })
  }
  out.sort((a, b) => (sortBy.value === 'count' ? b.item.count - a.item.count : b.item.lastTime - a.item.lastTime))
  return out
})

const pagedRows = computed(() => {
  const start = (currentPage.value - 1) * pageSize.value
  const end = start + pageSize.value
  return rows.value.slice(start, end)
})

// 过滤条件变化时重置页码
watch(rows, () => {
  currentPage.value = 1
})
watch(pageSize, () => {
  currentPage.value = 1
})

const TYPE_OPTIONS: { label: string; value: QuestionType }[] = [
  { label: '单选', value: 'single' },
  { label: '多选', value: 'multiple' },
  { label: '判断', value: 'judge' },
  { label: '简答', value: 'text' }
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
  selection.value = []
}
</script>

<template>
  <el-card class="page-card" shadow="never">
    <div class="card-title">
      <span class="title-text">错题本（{{ bankStore.meta?.name }}）</span>
      <el-button type="primary" :disabled="!rows.length && !Object.keys(userStore.wrong).length" @click="goPractice">
        练习错题
      </el-button>
    </div>

    <div style="display: flex; gap: 12px; flex-wrap: wrap; margin: 12px 0">
      <el-input v-model="keyword" placeholder="关键字查询" clearable style="width: 180px" />
      <el-select v-model="filterChapter" placeholder="章节" clearable style="width: 140px">
        <el-option v-for="c in bankStore.chapters" :key="c" :label="c" :value="c" />
      </el-select>
      <el-select v-model="filterType" placeholder="题型" clearable style="width: 110px">
        <el-option v-for="t in TYPE_OPTIONS" :key="t.value" :label="t.label" :value="t.value" />
      </el-select>
      <el-select v-model="filterSource" placeholder="来源" clearable style="width: 140px">
        <el-option v-for="s in bankStore.sources" :key="s" :label="s" :value="s" />
      </el-select>
      <el-radio-group v-model="sortBy">
        <el-radio-button value="count">按错误次数</el-radio-button>
        <el-radio-button value="time">按时间</el-radio-button>
      </el-radio-group>
      <el-button type="danger" plain :disabled="!selection.length" @click="removeBatch">
        批量移除（{{ selection.length }}）
      </el-button>
    </div>

    <el-table
      :data="pagedRows"
      row-key="item.questionId"
      @selection-change="(r: WrongRow[]) => (selection = r)"
    >
      <el-table-column type="selection" width="40" />
      <el-table-column type="expand">
        <template #default="{ row }">
          <div style="padding: 8px 16px">
            <QuestionDetail :question="row.question" />
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
    <el-pagination
      v-model:current-page="currentPage"
      v-model:page-size="pageSize"
      :page-sizes="[20, 50, 100]"
      :total="rows.length"
      :hide-on-single-page="true"
      layout="total, sizes, prev, pager, next, jumper"
      style="margin-top: 12px"
    />

    <el-empty v-if="!rows.length" description="暂无错题" />
  </el-card>
</template>