<script setup lang="ts">
/**
 * 首页：题库切换 + 统计卡片 + 做题入口（含断点续答）+ 题库浏览卡片。
 */
import { computed, onMounted, ref, watch, reactive } from 'vue'
import { useIsMobile } from '@/composables/useIsMobile'
import { DEFAULT_PAGE_SIZE, PAGE_SIZES, PAGINATION_LAYOUT, clampPage, pageSlice } from '@/composables/usePagedList'
import { useRouter } from 'vue-router'
import { Plus, Search, SquarePen, Trophy, Sprout, Puzzle, BookText, BookCheck, BookX, BookHeart } from '@lucide/vue'
import { useBankStore } from '@/stores/bankStore'
import { useUserDataStore } from '@/stores/userData'
import { getUnfinished } from '@/stores/session'
import type { Question, StoredQuizSession } from '@/types'
import { plainText, truncate } from '@/utils/format'
import { bankProgressText } from '@/utils/bankProgress'

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

/**
 * 断点续答卡片。这里拿到的会话是落盘形态（只有题号，没有题干），
 * 但卡片只展示题量与时间，点"继续"后由答题页按 id 从题库回填题干。
 */
const unfinished = ref<StoredQuizSession | null>(null)

function refreshUnfinished(): void {
  unfinished.value = bankStore.currentId ? getUnfinished(bankStore.currentId) : null
}

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
const isMobile = useIsMobile()

/**
 * 列表数据源：优先用已加载的全文，否则用索引里的摘要。
 *
 * 索引（构建期生成，约为全文的 4%）已经带上了每题的纯文本摘要、章节、难度、来源，
 * 足够渲染列表与章节计数，因此首页不再需要那 5MB 的全文。
 * 两者字段兼容，模板里统一按 `chapter / id / stem / difficulty / source / type` 取值。
 */
const browseQuestions = computed(() => bankStore.bank?.Questions ?? bankStore.index?.questions ?? [])
const browsePapers = computed(() => bankStore.bank?.Papers ?? bankStore.index?.papers ?? [])

/**
 * 按需拉全文：用户真正要"看题/搜题"时才下载那 5MB。
 * 触发点刻意选在交互（展开章节、输入关键字）而非渲染，避免一进首页就偷偷开始下载。
 */
function onBrowseIntent(): void {
  if (!bankStore.hasFullBank) void bankStore.ensureFullBank()
}

/** 章节展开/收起：标记为已渲染，并顺带触发"要看题"的意图 */
function onChapterToggle(name: string | number | (string | number)[]): void {
  markChapterRendered(name)
  onBrowseIntent()
}

/**
 * 全文加载进度条的文案。
 *
 * 列表在本卡片里始终可用（索引摘要已经够渲染），所以进度是"旁边的一条细线"而不是全屏遮罩：
 * 用户既能继续浏览已有内容，也能看见后台到底在干什么。
 * 文案口径统一在 `@/utils/bankProgress`（首页、做题设置页、恢复会话页三处共用）。
 */

/**
 * 总量未知（传输被压缩但索引没给出解压后体积）时进度条切成不确定态动画。
 *
 * 此时既没有可信的百分比，也不该画一条看起来"确定"的实心条：
 * 后者会让人以为"条快满了=马上就好"，而实际剩余时间完全未知。
 */
const progressIndeterminate = computed<boolean>(
  () => bankStore.progress.phase === 'download' && !bankStore.progress.total
)

const filteredPapers = computed(() => {
  const kw = paperKeyword.value.trim().toLowerCase()
  if (!kw) return browsePapers.value
  return browsePapers.value.filter((p) => p.name.toLowerCase().includes(kw) || p.source.toLowerCase().includes(kw))
})

interface ChapterGroup {
  chapter: string
  questions: BrowseQuestion[]
}

/** 列表里可能来自索引摘要，也可能来自全文，这里只取两者共有的展示字段 */
type BrowseQuestion = Pick<Question, 'id' | 'chapter' | 'difficulty' | 'source' | 'tags' | 'stem'> & {
  type: Question['type']
}

// ---------- 章节题目分页状态 ----------
const chapterPageState = reactive<Record<string, { pageSize: number; currentPage: number }>>({})

/**
 * 已展开过（或当前展开）的章节集合。
 *
 * el-collapse-item 的默认插槽即使收起也会被渲染，只是被 CSS 隐藏；880 道题全部进 DOM
 * 会让首屏白白多做几千次节点创建与布局。这里只在章节第一次展开时才渲染表格内容。
 * 用 `||` 而不是只依赖事件，是为了让 v-model 的初始值（预展开数组）也能生效。
 */
const renderedChapters = reactive<Record<string, boolean>>({})
function markChapterRendered(name: string | number | (string | number)[]): void {
  const list = Array.isArray(name) ? name : [name]
  for (const n of list) renderedChapters[String(n)] = true
}

const chapterGroups = computed<ChapterGroup[]>(() => {
  const kw = questionKeyword.value.trim().toLowerCase()
  const questions = browseQuestions.value.filter((q) => {
    if (!kw) return true
    return (
      plainText(q.stem).toLowerCase().includes(kw) ||
      q.chapter.toLowerCase().includes(kw) ||
      q.tags.some((t) => t.toLowerCase().includes(kw))
    )
  })
  const map = new Map<string, BrowseQuestion[]>()
  for (const q of questions) {
    const arr = map.get(q.chapter) ?? []
    arr.push(q)
    map.set(q.chapter, arr)
  }
  const groups = [...map.entries()].map(([chapter, qs]) => ({ chapter, questions: qs }))

  // 初始化每个章节的分页状态，并把页码收进有效区间（筛选后题目变少时不至于停在空白页）
  for (const g of groups) {
    const state = (chapterPageState[g.chapter] ??= {
      pageSize: DEFAULT_PAGE_SIZE,
      currentPage: 1
    })
    state.currentPage = clampPage(state.currentPage, g.questions.length, state.pageSize)
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
function getPagedQuestions(chapter: string, allQuestions: BrowseQuestion[]): BrowseQuestion[] {
  const state = chapterPageState[chapter]
  if (!state) return allQuestions
  return pageSlice(allQuestions, state.currentPage, state.pageSize)
}

// 辅助：改某个章节的每页条数（与列表页一致，回到第 1 页）
function setChapterPageSize(chapter: string, size: number): void {
  const state = chapterPageState[chapter]
  if (!state) return
  state.pageSize = size
  state.currentPage = 1
}

onMounted(async () => {
  refreshUnfinished()
})
</script>

<template>
  <div class="app-content">
    <div v-if="isMobile" class="brand" style="margin-bottom: 16px;">Quizor<span>做题家 · 首页</span></div>
    <!-- 题库切换卡片 -->
    <el-card class="page-card" shadow="never">
      <div class="card-title">
        <span class="title-text">题库</span>
        <el-button type="primary" plain :icon="Plus" @click="goAddBank">新增题库</el-button>
      </div>
      <div style="display: flex; gap: 8px; margin-top: 12px; flex-wrap: wrap">
        <el-select :model-value="bankStore.currentId" placeholder="选择题库" style="flex: 1; min-width: 220px"
          @change="onSwitchBank">
          <el-option v-for="b in bankStore.manifest" :key="b.id" :label="b.name" :value="b.id">
            <span>{{ b.name }}</span>
            <span class="muted" style="float: right">
              {{ b.id === bankStore.currentId ? bankStore.questionCount : b.questionCount }} 题
            </span>
          </el-option>
        </el-select>
      </div>
    </el-card>

    <!-- 统计卡片 -->
    <el-card class="page-card" shadow="never">
      <div class="stat-grid">
        <div class="stat-item">
          <div class="num">{{ stats.answered }}</div>
          <div class="label"><BookText /> 答题量</div>
        </div>
        <div class="stat-item">
          <div class="num">{{ stats.accuracy }}%</div>
          <div class="label"><BookCheck /> 正确率</div>
        </div>
        <div class="stat-item">
          <div class="num">{{ stats.wrong }}</div>
          <div class="label"><BookX /> 错题数</div>
        </div>
        <div class="stat-item">
          <div class="num">{{ stats.favorite }}</div>
          <div class="label"><BookHeart /> 收藏数</div>
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
        <el-button :icon="Puzzle" type="success" size="large" style="flex: 1; width: 100%; margin-top: 12px"
          @click="continueSession">继续上次答题</el-button>
      </div>
      <div style="display: flex; gap: 12px; margin-top: 12px; flex-wrap: wrap">
        <el-button type="primary" :icon="Sprout" size="large" style="flex: 1; min-width: 140px; margin-left: 0px;"
          @click="goSetup('practice')">
          练习模式
        </el-button>
        <el-button :icon="Trophy" size="large" style="flex: 1; min-width: 140px; margin-left: 0px;"
          @click="goSetup('exam')">
          考试模式
        </el-button>
      </div>
    </el-card>

    <!-- 题库卡片：索引立即可用；全文（约 6MB）在用户真正要看题/搜题时才下载，
         下载进度以卡片顶部的一条细线呈现，列表在下载期间保持可用 -->
    <el-card class="page-card" shadow="never">
      <div v-if="bankStore.showProgress" class="bank-progress">
        <div class="progress-track" :class="{ 'is-indeterminate': progressIndeterminate }">
          <div class="progress-fill"
            :style="progressIndeterminate ? undefined : { width: `${Math.round(bankStore.progress.ratio * 100)}%` }">
          </div>
        </div>
        <div class="progress-meta muted">
          <span>{{ bankProgressText(bankStore.progress) }}</span>
          <span class="muted">此期间可继续浏览下方列表</span>
        </div>
      </div>

      <div class="card-title">
        <span class="title-text">试卷 & 题目列表</span>
        <el-button v-if="!bankStore.hasFullBank" :loading="bankStore.showProgress" @click="onBrowseIntent">
          {{ bankStore.showProgress ? '正在加载…' : '加载完整题库' }}
        </el-button>
        <el-button type="primary" plain :icon="SquarePen" @click="goEditBank">编辑题库</el-button>
      </div>

      <el-divider content-position="left"><strong>试卷列表（{{ filteredPapers.length }}）</strong></el-divider>
      <el-input v-model="paperKeyword" placeholder="输入关键字实时过滤试卷" clearable :prefix-icon="Search"
        style="margin: 12px 0" @focus="onBrowseIntent" />
      <el-table stripe :data="filteredPapers">
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

      <el-divider content-position="left"><strong>题目列表（{{chapterGroups.reduce((s, g) => s + g.questions.length, 0)
      }}）</strong></el-divider>
      <el-input v-model="questionKeyword" placeholder="输入关键字实时过滤题目（题干 / 章节 / 标签）" clearable :prefix-icon="Search"
        style="margin: 12px 0" @focus="onBrowseIntent" />
      <!-- 展开章节＝明确的"我要看题"意图，此时再拉全文 -->
      <el-collapse v-model="activeChapters" @change="onChapterToggle">
        <el-collapse-item v-for="g in chapterGroups" :key="g.chapter" :name="g.chapter">
          <template #title>{{ g.chapter }}（{{ g.questions.length }}）</template>

          <!-- 收起时不渲染表格：880 题全部进 DOM 是首屏最大的一笔渲染开销 -->
          <template v-if="renderedChapters[g.chapter] || activeChapters.includes(g.chapter)">
            <!-- 题目表格（分页数据） -->
            <el-table stripe :data="getPagedQuestions(g.chapter, g.questions)">
              <el-table-column label="题号" width="80">
                <template #default="{ row }">
                  <span :title="row.id">{{ row.id.slice(-6) }}</span>
                </template>
              </el-table-column>
              <el-table-column label="题干" min-width="200" show-overflow-tooltip>
                <!-- 索引里已是纯文本摘要；全文则是富文本，两种形态都过一遍 plainText 归一化 -->
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
            <el-pagination :current-page="chapterPageState[g.chapter].currentPage"
              @update:current-page="(val: number) => (chapterPageState[g.chapter].currentPage = val)"
              :page-size="chapterPageState[g.chapter].pageSize"
              @update:page-size="(val: number) => setChapterPageSize(g.chapter, val)"
              :page-sizes="PAGE_SIZES" :total="g.questions.length" :layout="PAGINATION_LAYOUT"
              style="margin-top: 10px" />
          </template>
          <el-empty v-else :image-size="60" description="展开后加载本节题目" />
        </el-collapse-item>
      </el-collapse>

      <el-empty v-if="!bankStore.showProgress && !chapterGroups.length" description="当前题库暂无题目" />
    </el-card>
  </div>
</template>

<style scoped>
/**
 * 全文加载进度条：卡片顶部一条细线 + 一行说明。
 * 用卡片内的普通元素而不是 v-loading 遮罩 —— 遮罩会盖住列表，
 * 而列表用的是索引摘要，加载全文期间完全可用，没必要挡住它。
 */
.bank-progress {
  margin-bottom: 12px;
}

.bank-progress .progress-track {
  height: 6px;
}

.bank-progress .progress-fill {
  transition: width 0.2s ease-out;
}

.progress-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 6px;
  font-variant-numeric: tabular-nums;
}

/* 末位提示语在大屏上贴右、在小屏上独占一行：不占额外行高又保持对齐 */
.progress-meta .muted:last-child {
  margin-left: auto;
}

@media (max-width: 768px) {
  .progress-meta .muted:last-child {
    margin-left: 0;
    width: 100%;
  }
}
</style>