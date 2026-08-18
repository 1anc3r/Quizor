<script setup lang="ts">
/**
 * 首页：题库切换 + 统计卡片 + 做题入口（含断点续答）+ 题库浏览卡片。
 */
import { computed, onMounted, ref, watch, reactive } from 'vue'
import { useRouter } from 'vue-router'
import { Plus, Edit } from '@element-plus/icons-vue'
import { useBankStore } from '@/stores/bank'
import { useUserDataStore } from '@/stores/userData'
import { getUnfinished } from '@/services/session'
import type { Question, QuizSession } from '@/types'
import { difficultyStars, plainText, truncate } from '@/utils/format'

const router = useRouter()
const bankStore = useBankStore()
const userStore = useUserDataStore()

/* ---------- 题库切换 ---------- */

async function onSwitchBank(id: string): Promise<void> {
  await bankStore.switchBank(id)
}

function goAddBank(): void {
  router.push('/bank/manage/new')
}

function goEditBank(): void {
  if (bankStore.currentId) router.push(`/bank/manage/${bankStore.currentId}`)
}

/* ---------- 统计卡片 ---------- */

const stats = computed(() => {
  const records = userStore.records
  const answered = records.reduce((s, r) => s + r.answered, 0)
  const correct = records.reduce((s, r) => s + r.correct, 0)
  return {
    answered,
    accuracy: answered > 0 ? Math.round((correct / answered) * 100) : 0,
    wrong: Object.keys(userStore.wrong).length,
    favorite: Object.keys(userStore.favorites).length
  }
})

/* ---------- 断点续答 ---------- */

const unfinished = ref<QuizSession | null>(null)

function refreshUnfinished(): void {
  unfinished.value = bankStore.currentId ? getUnfinished(bankStore.currentId) : null
}

onMounted(refreshUnfinished)
watch(() => bankStore.currentId, refreshUnfinished)

function continueSession(): void {
  if (unfinished.value) router.push(`/quiz/${unfinished.value.id}`)
}

function goSetup(mode: 'practice' | 'exam'): void {
  router.push(`/setup/${mode}`)
}

/* ---------- 题库浏览卡片 ---------- */

const paperKeyword = ref('')
const questionKeyword = ref('')
const activeChapters = ref<string[]>([])

const filteredPapers = computed(() => {
  const kw = paperKeyword.value.trim().toLowerCase()
  const papers = bankStore.bank?.Papers ?? []
  if (!kw) return papers
  return papers.filter((p) => p.name.toLowerCase().includes(kw) || p.source.toLowerCase().includes(kw))
})

interface ChapterGroup {
  chapter: string
  questions: Question[]
}

// ---------- 章节题目分页状态 ----------
const chapterPageState = reactive<Record<string, { pageSize: number; currentPage: number }>>({})

const chapterGroups = computed<ChapterGroup[]>(() => {
  const kw = questionKeyword.value.trim().toLowerCase()
  const questions = (bankStore.bank?.Questions ?? []).filter((q) => {
    if (!kw) return true
    return (
      plainText(q.stem).toLowerCase().includes(kw) ||
      q.chapter.toLowerCase().includes(kw) ||
      q.tags.some((t) => t.toLowerCase().includes(kw))
    )
  })
  const map = new Map<string, Question[]>()
  for (const q of questions) {
    const arr = map.get(q.chapter) ?? []
    arr.push(q)
    map.set(q.chapter, arr)
  }
  const groups = [...map.entries()].map(([chapter, qs]) => ({ chapter, questions: qs }))

  // 初始化每个章节的分页状态，并修正 currentPage 不超出总页数
  for (const g of groups) {
    if (!chapterPageState[g.chapter]) {
      chapterPageState[g.chapter] = { pageSize: 20, currentPage: 1 }
    } else {
      const total = g.questions.length
      const size = chapterPageState[g.chapter].pageSize
      const maxPage = Math.ceil(total / size) || 1
      if (chapterPageState[g.chapter].currentPage > maxPage) {
        chapterPageState[g.chapter].currentPage = maxPage
      }
    }
  }

  // 移除已经不存在章节的分页状态
  const existingChapters = new Set(groups.map((g) => g.chapter))
  for (const key in chapterPageState) {
    if (!existingChapters.has(key)) {
      delete chapterPageState[key]
    }
  }

  return groups
})

// 当搜索关键词变化时，重置所有章节的当前页为第一页
watch(questionKeyword, () => {
  for (const key in chapterPageState) {
    chapterPageState[key].currentPage = 1
  }
})

// 辅助：获取某个章节分页后的题目列表（用于模板）
function getPagedQuestions(chapter: string, allQuestions: Question[]): Question[] {
  const state = chapterPageState[chapter]
  if (!state) return allQuestions
  const start = (state.currentPage - 1) * state.pageSize
  const end = start + state.pageSize
  return allQuestions.slice(start, end)
}
</script>

<template>
  <div>
    <!-- 题库切换卡片 -->
    <el-card class="page-card" shadow="never">
      <div class="card-title">
        <span class="title-text">题库</span>
      </div>
      <div style="display: flex; gap: 8px; margin-top: 12px; flex-wrap: wrap">
        <el-select
          :model-value="bankStore.currentId"
          placeholder="选择题库"
          style="flex: 1; min-width: 220px"
          @change="onSwitchBank"
        >
          <el-option v-for="b in bankStore.manifest" :key="b.id" :label="b.name" :value="b.id">
            <span>{{ b.name }}</span>
            <span class="muted" style="float: right">{{ b.questionCount }} 题</span>
          </el-option>
        </el-select>
        <el-button type="primary" :icon="Plus" @click="goAddBank">新增题库</el-button>
      </div>
    </el-card>

    <!-- 统计卡片 -->
    <el-card class="page-card" shadow="never">
      <div class="stat-grid">
        <div class="stat-item">
          <div class="num">{{ stats.answered }}</div>
          <div class="label">答题量</div>
        </div>
        <div class="stat-item">
          <div class="num">{{ stats.accuracy }}%</div>
          <div class="label">正确率</div>
        </div>
        <div class="stat-item">
          <div class="num">{{ stats.wrong }}</div>
          <div class="label">错题数</div>
        </div>
        <div class="stat-item">
          <div class="num">{{ stats.favorite }}</div>
          <div class="label">收藏数</div>
        </div>
      </div>
    </el-card>

    <!-- 做题卡片 -->
    <el-card class="page-card" shadow="never">
      <div class="card-title">
        <span class="title-text">做题</span>
      </div>
      <div v-if="unfinished" style="margin-top: 12px">
        <el-alert type="success" :closable="false" show-icon>
          <template #title>
            检测到未完成的{{ unfinished.mode === 'exam' ? '考试' : '练习' }}会话（{{ unfinished.questions.length }} 题）
          </template>
        </el-alert>
        <el-button type="success" size="large" style="flex: 1; width: 100%; margin-top: 12px" @click="continueSession">继续上次答题</el-button>
      </div>
      <div style="display: flex; gap: 12px; margin-top: 12px; flex-wrap: wrap">
        <el-button type="primary" size="large" style="flex: 1; min-width: 140px" @click="goSetup('practice')">
          练习模式
        </el-button>
        <el-button type="warning" size="large" style="flex: 1; min-width: 140px" @click="goSetup('exam')">
          考试模式
        </el-button>
      </div>
    </el-card>

    <!-- 题库卡片 -->
    <el-card class="page-card" shadow="never" v-loading="bankStore.loading">
      <div class="card-title">
        <span class="title-text">{{ bankStore.meta?.name ?? '题库' }}</span>
        <el-button :icon="Edit" @click="goEditBank">编辑题库</el-button>
      </div>

      <el-divider content-position="left"><strong>试卷列表（{{ filteredPapers.length }}）</strong></el-divider>
      <el-input v-model="paperKeyword" placeholder="关键字查询试卷" clearable style="max-width: 280px; margin-bottom: 10px" />
      <el-table :data="filteredPapers">
        <el-table-column prop="name" label="试卷名称" min-width="200" show-overflow-tooltip />
        <el-table-column label="题数" width="80">
          <template #default="{ row }">{{ row.questionIds.length }}</template>
        </el-table-column>
        <el-table-column label="难度" width="130">
          <template #default="{ row }">
            <el-rate v-model="row.difficulty" :max="5" size="small" disabled />
          </template>
        </el-table-column>
        <el-table-column prop="source" label="来源" width="120" show-overflow-tooltip />
      </el-table>

      <el-divider content-position="left"><strong>题目列表（{{ chapterGroups.reduce((s, g) => s + g.questions.length, 0) }}）</strong></el-divider>
      <el-input
        v-model="questionKeyword"
        placeholder="关键字查询题目（题干 / 章节 / 标签）"
        clearable
        style="max-width: 280px; margin-bottom: 10px"
      />

      <el-collapse v-model="activeChapters">
        <el-collapse-item v-for="g in chapterGroups" :key="g.chapter" :name="g.chapter">
          <template #title>{{ g.chapter }}（{{ g.questions.length }}）</template>

          <!-- 题目表格（分页数据） -->
          <el-table :data="getPagedQuestions(g.chapter, g.questions)">
            <el-table-column label="题号" width="80">
              <template #default="{ row }">
                <span :title="row.id">{{ row.id.slice(-6) }}</span>
              </template>
            </el-table-column>
            <el-table-column label="题干" min-width="200" show-overflow-tooltip>
              <template #default="{ row }">{{ truncate(plainText(row.stem), 80) }}</template>
            </el-table-column>
            <el-table-column label="难度" width="130">
              <template #default="{ row }">
                <el-rate v-model="row.difficulty" :max="5" size="small" disabled />
              </template>
            </el-table-column>
            <el-table-column prop="source" label="来源" width="120" show-overflow-tooltip />
          </el-table>

          <!-- 分页组件（仅当题目总数大于每页条数时显示） -->
          <el-pagination
            :current-page="chapterPageState[g.chapter].currentPage"
            @update:current-page="(val: number) => (chapterPageState[g.chapter].currentPage = val)"
            :page-size="chapterPageState[g.chapter].pageSize"
            @update:page-size="
              (val: number) => {
                const state = chapterPageState[g.chapter]
                state.pageSize = val
                state.currentPage = 1
              }
            "
            :page-sizes="[20, 50, 100]"
            :total="g.questions.length"
            layout="total, sizes, prev, pager, next, jumper"
            style="margin-top: 10px"
          />
        </el-collapse-item>
      </el-collapse>

      <el-empty v-if="!bankStore.loading && !chapterGroups.length" description="当前题库暂无题目" />
    </el-card>
  </div>
</template>