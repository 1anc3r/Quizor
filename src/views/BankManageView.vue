<script setup lang="ts">
/**
 * 题库管理页：/bank/manage/new 为新增模式，/bank/manage/:id 为编辑模式。
 * - 基本信息卡片：名称（自动转拼音生成 ID）、时长、总分、及格线、组卷规则（增删/批量删除）
 * - 试卷列表卡片：查询、新增、编辑、删除、批量删除（弹出试卷管理窗口）
 * - 题目列表卡片：查询、章节/题型筛选、新增、编辑、删除、批量删除、添加到目标试卷
 * 编辑模式下所有变更防抖自动持久化到 localStorage 覆盖层。
 */
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { Delete, Plus } from '@element-plus/icons-vue'
import type { BankData, BankMeta, ComposeItem, Paper, Question, QuestionType } from '@/types'
import { createBank, defaultRule, loadBank, loadManifest, saveBank } from '@/services/bank'
import { nameToBankId } from '@/services/pinyin'
import { useBankStore } from '@/stores/bank'
import { plainText, shortId, truncate, typeLabel } from '@/utils/format'
import { genId } from '@/utils/id'
import PaperFormDialog from '@/components/PaperFormDialog.vue'
import QuestionFormDialog from '@/components/QuestionFormDialog.vue'

const route = useRoute()
const router = useRouter()
const bankStore = useBankStore()

const bankId = computed(() => String(route.params.id ?? 'new'))
const isNew = computed(() => bankId.value === 'new' || !bankId.value)
const ready = ref(false)

const meta = reactive<BankMeta>({
  id: '',
  name: '',
  bankFile: '',
  questionCount: 0,
  rule: defaultRule()
})
const data = reactive<BankData>({ Questions: [], Papers: [] })

onMounted(async () => {
  if (isNew.value) {
    meta.rule = defaultRule()
  } else {
    const m = await loadManifest()
    const found = m.Banks.find((b) => b.id === bankId.value)
    if (!found) {
      ElMessage.error('题库不存在')
      router.replace('/')
      return
    }
    Object.assign(meta, JSON.parse(JSON.stringify(found)))
    const d = JSON.parse(JSON.stringify(await loadBank(bankId.value))) as BankData
    data.Questions = d.Questions
    data.Papers = d.Papers
  }
  ready.value = true
})

/* ---------- 基本信息 ---------- */

// 名称自动转拼音作为题库 ID
watch(
  () => meta.name,
  (name) => {
    if (isNew.value) meta.id = nameToBankId(name)
  }
)

let saveTimer: number | null = null

/** 编辑模式：防抖自动持久化 */
function persist(): void {
  if (isNew.value || !ready.value) return
  if (saveTimer !== null) window.clearTimeout(saveTimer)
  saveTimer = window.setTimeout(async () => {
    await saveBank(JSON.parse(JSON.stringify(meta)), JSON.parse(JSON.stringify(data)))
    await bankStore.afterBankEdited(meta.id)
  }, 300)
}

async function onCreateBank(): Promise<void> {
  if (!meta.name.trim()) {
    ElMessage.warning('请填写题库名称')
    return
  }
  if (!meta.rule.composition.length) {
    ElMessage.warning('请至少添加一条组卷规则')
    return
  }
  const created = await createBank(meta.name.trim(), JSON.parse(JSON.stringify(meta.rule)))
  await bankStore.afterBankEdited(created.id)
  ElMessage.success(`题库已创建，ID：${created.id}`)
  router.replace(`/bank/manage/${created.id}`)
}

async function onDeleteBank(): Promise<void> {
  try {
    await ElMessageBox.confirm(`确定删除题库「${meta.name}」吗？该操作不可恢复。`, '删除题库', {
      type: 'error',
      confirmButtonText: '删除',
      cancelButtonText: '取消'
    })
  } catch {
    return
  }
  await bankStore.removeBank(meta.id)
  ElMessage.success('题库已删除')
  router.replace('/')
}

/* ---------- 组卷规则 ---------- */

const TYPE_OPTIONS: { label: string; value: QuestionType }[] = [
  { label: '单选', value: 'single' },
  { label: '多选', value: 'multiple' },
  { label: '判断', value: 'judge' },
  { label: '简答', value: 'text' }
]

const composeSelection = ref<ComposeItem[]>([])

const chapterOptions = computed<string[]>(() => {
  const set = new Set<string>()
  meta.rule.composition.forEach((c) => c.chapter && set.add(c.chapter))
  data.Questions.forEach((q) => q.chapter && set.add(q.chapter))
  return [...set]
})

const sourceOptions = computed<{ label: string; value: string }[]>(() => {
  const set = new Set<string>()
  data.Questions.forEach((q) => q.source && set.add(q.source))
  return [...set].map((s) => ({ label: s, value: s }))
})

function addCompose(): void {
  meta.rule.composition.push({ chapter: '', type: 'single', count: 10, scoreEach: 2, optionCount: 4 })
  persist()
}

function removeCompose(i: number): void {
  meta.rule.composition.splice(i, 1)
  persist()
}

function removeComposeBatch(): void {
  const set = new Set(composeSelection.value)
  meta.rule.composition = meta.rule.composition.filter((c) => !set.has(c))
  composeSelection.value = []
  persist()
}

/** 章节 → 题型 / 选项数 映射（题目管理窗口自动匹配用） */
const chapterType = computed<Record<string, QuestionType>>(() => {
  const m: Record<string, QuestionType> = {}
  meta.rule.composition.forEach((c) => {
    if (c.chapter && !m[c.chapter]) m[c.chapter] = c.type
  })
  return m
})
const chapterOptionCount = computed<Record<string, number>>(() => {
  const m: Record<string, number> = {}
  meta.rule.composition.forEach((c) => {
    if (c.chapter && !m[c.chapter]) m[c.chapter] = c.optionCount ?? 4
  })
  return m
})

/* ---------- 试卷列表 ---------- */

const paperKeyword = ref('')
const paperSelection = ref<Paper[]>([])
const paperDialogVisible = ref(false)
const editingPaper = ref<Paper>({ id: '', name: '', source: '', difficulty: 3, questionIds: [] })

const filteredPapers = computed(() => {
  const kw = paperKeyword.value.trim().toLowerCase()
  if (!kw) return data.Papers
  return data.Papers.filter((p) => p.name.toLowerCase().includes(kw) || p.source.toLowerCase().includes(kw))
})

// 分页相关
const paperPage = ref(1)
const paperPageSize = ref(20)

const pagedPapers = computed(() => {
  const start = (paperPage.value - 1) * paperPageSize.value
  const end = start + paperPageSize.value
  return filteredPapers.value.slice(start, end)
})

// 每页条数变化时重置页码到1
watch(paperPageSize, () => {
  paperPage.value = 1
})

// 当总记录数变化时，自动修正当前页（防止超出范围）
watch(
  () => filteredPapers.value.length,
  (newLen) => {
    const totalPages = Math.ceil(newLen / paperPageSize.value)
    if (paperPage.value > totalPages && totalPages > 0) {
      paperPage.value = totalPages
    } else if (newLen === 0) {
      paperPage.value = 1
    }
  }
)

function openPaperDialog(p?: Paper): void {
  editingPaper.value = p
    ? (JSON.parse(JSON.stringify(p)) as Paper)
    : { id: genId('paper'), name: '', source: '', difficulty: 3, questionIds: [] }
  paperDialogVisible.value = true
}

function onSavePaper(p: Paper): void {
  const i = data.Papers.findIndex((x) => x.id === p.id)
  if (i >= 0) data.Papers[i] = p
  else data.Papers.push(p)
  persist()
  ElMessage.success('试卷已保存')
}

async function removePaper(p: Paper): Promise<void> {
  try {
    await ElMessageBox.confirm(`确定删除试卷「${p.name}」吗？`, '删除试卷', { type: 'warning' })
  } catch {
    return
  }
  data.Papers = data.Papers.filter((x) => x.id !== p.id)
  persist()
}

async function removePaperBatch(): Promise<void> {
  try {
    await ElMessageBox.confirm(`确定删除选中的 ${paperSelection.value.length} 套试卷吗？`, '批量删除', { type: 'warning' })
  } catch {
    return
  }
  const ids = new Set(paperSelection.value.map((p) => p.id))
  data.Papers = data.Papers.filter((p) => !ids.has(p.id))
  paperSelection.value = []
  persist()
}

/* ---------- 题目列表 ---------- */

const qKeyword = ref('')
const qChapter = ref('')
const qSource = ref('')
const qType = ref<'' | QuestionType>('')
const qSelection = ref<Question[]>([])
const qDialogVisible = ref(false)
const editingQuestion = ref<Question | null>(null)
const addToPaperVisible = ref(false)
const addToPaperTarget = ref('')

const filteredQuestions = computed(() => {
  const kw = qKeyword.value.trim().toLowerCase()
  return data.Questions.filter((q) => {
    if (qChapter.value && q.chapter !== qChapter.value) return false
    if (qType.value && q.type !== qType.value) return false
    if (qSource.value && q.source !== qSource.value) return false
    if (!kw) return true
    return (
      plainText(q.stem).toLowerCase().includes(kw) ||
      q.id.toLowerCase().includes(kw) ||
      q.source.toLowerCase().includes(kw) ||
      q.tags.some((t) => t.toLowerCase().includes(kw))
    )
  })
})

// 分页相关
const questionPage = ref(1)
const questionPageSize = ref(20)

const pagedQuestions = computed(() => {
  const start = (questionPage.value - 1) * questionPageSize.value
  const end = start + questionPageSize.value
  return filteredQuestions.value.slice(start, end)
})

watch(questionPageSize, () => {
  questionPage.value = 1
})

watch(
  () => filteredQuestions.value.length,
  (newLen) => {
    const totalPages = Math.ceil(newLen / questionPageSize.value)
    if (questionPage.value > totalPages && totalPages > 0) {
      questionPage.value = totalPages
    } else if (newLen === 0) {
      questionPage.value = 1
    }
  }
)

const allTags = computed<string[]>(() => {
  const set = new Set<string>()
  data.Questions.forEach((q) => q.tags.forEach((t) => t && set.add(t)))
  return [...set]
})

function openQuestionDialog(q?: Question): void {
  editingQuestion.value = q ?? null
  qDialogVisible.value = true
}

function onSaveQuestion(q: Question): void {
  const i = data.Questions.findIndex((x) => x.id === q.id)
  if (i >= 0) data.Questions[i] = q
  else data.Questions.push(q)
  persist()
  ElMessage.success('题目已保存')
}

async function removeQuestion(q: Question): Promise<void> {
  try {
    await ElMessageBox.confirm('确定删除该题目吗？', '删除题目', { type: 'warning' })
  } catch {
    return
  }
  data.Questions = data.Questions.filter((x) => x.id !== q.id)
  data.Papers.forEach((p) => (p.questionIds = p.questionIds.filter((id) => id !== q.id)))
  persist()
}

async function removeQuestionBatch(): Promise<void> {
  try {
    await ElMessageBox.confirm(`确定删除选中的 ${qSelection.value.length} 道题目吗？`, '批量删除', { type: 'warning' })
  } catch {
    return
  }
  const ids = new Set(qSelection.value.map((q) => q.id))
  data.Questions = data.Questions.filter((q) => !ids.has(q.id))
  data.Papers.forEach((p) => (p.questionIds = p.questionIds.filter((id) => !ids.has(id))))
  qSelection.value = []
  persist()
}

function openAddToPaper(): void {
  if (!qSelection.value.length) {
    ElMessage.warning('请先勾选题目')
    return
  }
  if (!data.Papers.length) {
    ElMessage.warning('当前题库还没有试卷，请先新增试卷')
    return
  }
  addToPaperTarget.value = data.Papers[0].id
  addToPaperVisible.value = true
}

function confirmAddToPaper(): void {
  const paper = data.Papers.find((p) => p.id === addToPaperTarget.value)
  if (!paper) return
  const exist = new Set(paper.questionIds)
  let added = 0
  for (const q of qSelection.value) {
    if (!exist.has(q.id)) {
      paper.questionIds.push(q.id)
      added++
    }
  }
  persist()
  addToPaperVisible.value = false
  ElMessage.success(`已添加 ${added} 题到「${paper.name}」`)
}
</script>

<template>
  <div v-if="ready">
    <!-- 题库基本信息卡片 -->
    <el-card class="page-card" shadow="never">
      <div class="card-title">
        <span class="title-text">{{ isNew ? '新增题库' : `题库管理（${meta.name}）` }}</span>
        <div>
          <el-button v-if="isNew" type="primary" @click="onCreateBank">创建题库</el-button>
          <el-button v-else type="danger" plain :icon="Delete" @click="onDeleteBank">删除题库</el-button>
          <el-button @click="router.back()">返回</el-button>
        </div>
      </div>
      <el-form label-width="90px" style="margin-top: 16px;">
        <el-form-item label="题库名称" required>
          <el-input v-model="meta.name" :disabled="!isNew" placeholder="如：199_管理类综合能力" style="max-width: 320px" @input="persist" />
        </el-form-item>
        <el-form-item label="题库 ID">
          <el-tag>{{ meta.id || '（由名称自动生成拼音 ID）' }}</el-tag>
          <span class="muted" style="margin-left: 8px">名称自动转拼音，用于创建题库 ID</span>
        </el-form-item>
        <el-form-item label="时长" required>
          <el-input-number v-model="meta.rule.durationMinutes" :min="1" :max="600" @change="persist" />
          <span class="muted" style="margin-left: 8px">分钟</span>
        </el-form-item>
        <el-form-item label="总分" required>
          <el-input-number v-model="meta.rule.totalScore" :min="1" :max="1000" @change="persist" />
        </el-form-item>
        <el-form-item label="及格线">
          <el-input-number v-model="meta.rule.passScore" :min="0" :max="1000" placeholder="可选" @change="persist" />
          <span class="muted" style="margin-left: 8px">可选</span>
        </el-form-item>
        <el-form-item label="组卷规则">
          <div style="width: 100%">
            <div style="margin-bottom: 8px; display: flex; flex-wrap: wrap; gap: 12px;">
              <el-button type="primary" plain :icon="Plus" @click="addCompose">新增规则</el-button>
              <el-button type="danger" plain :disabled="!composeSelection.length" @click="removeComposeBatch" style="margin-left: 0px;">
                批量删除（{{ composeSelection.length }}）
              </el-button>
            </div>
            <el-table
              :data="meta.rule.composition"
              @selection-change="(rows: ComposeItem[]) => (composeSelection = rows)"
            >
              <el-table-column type="selection" width="40" fixed="left"/>
              <el-table-column label="章节" width="200">
                <template #default="{ row }">
                  <el-select
                    v-model="row.chapter"
                    filterable
                    allow-create
                    default-first-option
                    placeholder="选择或录入"
                    @change="persist"
                  >
                    <el-option v-for="c in chapterOptions" :key="c" :label="c" :value="c" />
                  </el-select>
                </template>
              </el-table-column>
              <el-table-column label="题型" width="100">
                <template #default="{ row }">
                  <el-select v-model="row.type" @change="persist">
                    <el-option v-for="t in TYPE_OPTIONS" :key="t.value" :label="t.label" :value="t.value" />
                  </el-select>
                </template>
              </el-table-column>
              <el-table-column label="题目数量" width="180">
                <template #default="{ row }">
                  <el-input-number v-model="row.count" :min="0" :max="500" @change="persist" />
                </template>
              </el-table-column>
              <el-table-column label="单题分值" width="180">
                <template #default="{ row }">
                  <el-input-number v-model="row.scoreEach" :min="0" :max="100" @change="persist" />
                </template>
              </el-table-column>
              <el-table-column label="选项数" width="180">
                <template #default="{ row }">
                  <el-input-number
                    v-model="row.optionCount"
                    :min="0"
                    :max="8"
                    :disabled="row.type === 'text'"
                    @change="persist"
                  />
                </template>
              </el-table-column>
              <el-table-column label="操作" width="80" fixed="right">
                <template #default="{ $index }">
                  <el-button link type="danger" @click="removeCompose($index)">删除</el-button>
                </template>
              </el-table-column>
            </el-table>
          </div>
        </el-form-item>
      </el-form>
    </el-card>

    <template v-if="!isNew">
      <!-- 试卷列表卡片 -->
      <el-card class="page-card" shadow="never">
        <div class="card-title">
          <span class="title-text">试卷列表（{{ filteredPapers.length }}）</span>
          <div style="display: flex; flex-wrap: wrap; gap: 12px;">
            <el-input v-model="paperKeyword" placeholder="关键字查询" clearable style="width: 200px;" />
            <el-button type="primary" plain :icon="Plus" @click="openPaperDialog()" style="margin-left: 0px;">新增试卷</el-button>
            <el-button type="danger" plain :disabled="!paperSelection.length" @click="removePaperBatch" style="margin-left: 0px;">
              批量删除（{{ paperSelection.length }}）
            </el-button>
          </div>
        </div>
        <el-table
          :data="pagedPapers"
          style="margin-top: 12px"
          @selection-change="(rows: Paper[]) => (paperSelection = rows)"
        >
          <el-table-column type="selection" width="40" />
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
          <el-table-column label="操作" width="120" fixed="right">
            <template #default="{ row }">
              <el-button link type="primary" @click="openPaperDialog(row)">编辑</el-button>
              <el-button link type="danger" @click="removePaper(row)">删除</el-button>
            </template>
          </el-table-column>
        </el-table>
        <!-- 试卷分页 -->
        <el-pagination
          v-model:current-page="paperPage"
          v-model:page-size="paperPageSize"
          :page-sizes="[20, 50, 100]"
          :total="filteredPapers.length"
          :hide-on-single-page="true"
          layout="total, sizes, prev, pager, next, jumper"
          style="margin-top: 12px;"
        />
      </el-card>

      <!-- 题目列表卡片 -->
      <el-card class="page-card" shadow="never">
        <div class="card-title">
          <span class="title-text">题目列表（{{ filteredQuestions.length }}）</span>
          <div style="display: flex; flex-wrap: wrap; gap: 12px;">
            <el-input v-model="qKeyword" placeholder="关键字查询" clearable style="width: 200px;" />
            <el-select v-model="qChapter" placeholder="章节筛选" clearable style="width: 150px;">
              <el-option v-for="c in chapterOptions" :key="c" :label="c" :value="c" />
            </el-select>
            <el-select v-model="qType" placeholder="题型筛选" clearable style="width: 100px;">
              <el-option v-for="t in TYPE_OPTIONS" :key="t.value" :label="t.label" :value="t.value" />
            </el-select>
            <el-select v-model="qSource" placeholder="来源筛选" clearable style="width: 100px;">
              <el-option v-for="t in sourceOptions" :key="t.value" :label="t.label" :value="t.value" />
            </el-select>
            <el-button plain :disabled="!qSelection.length" @click="openAddToPaper" style="margin-left: 0px;">
              添加到试卷（{{ qSelection.length }}）
            </el-button>
            <el-button type="primary" plain :icon="Plus" @click="openQuestionDialog()" style="margin-left: 0px;">新增题目</el-button>
            <el-button type="danger" plain :disabled="!qSelection.length" @click="removeQuestionBatch" style="margin-left: 0px;">
              批量删除（{{ qSelection.length }}）
            </el-button>
          </div>
        </div>
        <el-table
          :data="pagedQuestions"
          style="margin-top: 12px"
          @selection-change="(rows: Question[]) => (qSelection = rows)"
        >
          <el-table-column type="selection" width="40" />
          <el-table-column label="题号" width="80">
            <template #default="{ row }">
              <span :title="row.id">{{ shortId(row.id) }}</span>
            </template>
          </el-table-column>
          <el-table-column prop="chapter" label="章节" width="150" show-overflow-tooltip />
          <el-table-column label="题型" width="80">
            <template #default="{ row }">{{ typeLabel(row.type) }}</template>
          </el-table-column>
          <el-table-column label="题干" min-width="200" show-overflow-tooltip>
            <template #default="{ row }">{{ truncate(plainText(row.stem), 60) }}</template>
          </el-table-column>
          <el-table-column label="难度" width="130">
            <template #default="{ row }">
              <el-rate v-model="row.difficulty" :max="5" size="small" disabled />
            </template>
          </el-table-column>
          <el-table-column prop="source" label="来源" width="120" show-overflow-tooltip />
          <el-table-column label="操作" width="120" fixed="right">
            <template #default="{ row }">
              <el-button link type="primary" @click="openQuestionDialog(row)">编辑</el-button>
              <el-button link type="danger" @click="removeQuestion(row)">删除</el-button>
            </template>
          </el-table-column>
        </el-table>
        <!-- 试卷分页 -->
        <el-pagination
          v-model:current-page="questionPage"
          v-model:page-size="questionPageSize"
          :page-sizes="[20, 50, 100]"
          :total="filteredQuestions.length"
          :hide-on-single-page="true"
          layout="total, sizes, prev, pager, next, jumper"
          style="margin-top: 12px;"
        />
      </el-card>

      <!-- 试卷管理窗口 -->
      <PaperFormDialog v-model="paperDialogVisible" :paper="editingPaper" :questions="data.Questions" @save="onSavePaper" />

      <!-- 题目管理窗口 -->
      <QuestionFormDialog
        v-model="qDialogVisible"
        :question="editingQuestion"
        :bank-id="meta.id"
        :chapters="chapterOptions"
        :chapter-type="chapterType"
        :chapter-option-count="chapterOptionCount"
        :all-tags="allTags"
        :existing-ids="data.Questions.map((q) => q.id)"
        @save="onSaveQuestion"
      />

      <!-- 添加到目标试卷 -->
      <el-dialog v-model="addToPaperVisible" title="添加到目标试卷" width="420px">
        <el-select v-model="addToPaperTarget" style="width: 100%">
          <el-option v-for="p in data.Papers" :key="p.id" :label="`${p.name}（${p.questionIds.length} 题）`" :value="p.id" />
        </el-select>
        <template #footer>
          <el-button @click="addToPaperVisible = false">取消</el-button>
          <el-button type="primary" @click="confirmAddToPaper">确定</el-button>
        </template>
      </el-dialog>
    </template>

    <el-card v-else class="page-card" shadow="never">
      <el-alert type="info" :closable="false" show-icon title="先填写上方基本信息并创建题库，随后即可管理试卷与题目。" />
    </el-card>
  </div>
</template>