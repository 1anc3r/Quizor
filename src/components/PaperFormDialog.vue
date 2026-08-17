<script setup lang="ts">
/**
 * 试卷管理窗口：名称/来源/难度 + 已添加题目（可移除）/ 未添加题目（可添加），
 * 两个列表均可折叠，支持单项与批量操作。
 */
import { computed, ref, watch } from 'vue'
import type { Paper, Question } from '@/types'
import { difficultyStars, plainText, shortId, truncate, typeLabel } from '@/utils/format'

const props = defineProps<{
  modelValue: boolean
  /** 编辑中的试卷副本（新增时为空白试卷） */
  paper: Paper
  /** 题库全部题目 */
  questions: Question[]
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', v: boolean): void
  (e: 'save', paper: Paper): void
}>()

const visible = computed({
  get: () => props.modelValue,
  set: (v) => emit('update:modelValue', v)
})

const form = ref<Paper>({ id: '', name: '', source: '', difficulty: 3, questionIds: [] })
const inKeyword = ref('')
const outKeyword = ref('')
const inSelection = ref<Question[]>([])
const outSelection = ref<Question[]>([])
const activePanels = ref<string[]>([])

const qMap = computed(() => new Map(props.questions.map((q) => [q.id, q])))

watch(visible, (v) => {
  if (v) {
    form.value = JSON.parse(JSON.stringify(props.paper)) as Paper
    inKeyword.value = ''
    outKeyword.value = ''
    inSelection.value = []
    outSelection.value = []
    activePanels.value = []
  }
})

function matchKeyword(q: Question, kw: string): boolean {
  if (!kw) return true
  const t = kw.toLowerCase()
  return (
    plainText(q.stem).toLowerCase().includes(t) ||
    q.chapter.toLowerCase().includes(t) ||
    q.id.toLowerCase().includes(t)
  )
}

const inList = computed(() =>
  form.value.questionIds
    .map((id) => qMap.value.get(id))
    .filter((q): q is Question => !!q)
    .filter((q) => matchKeyword(q, inKeyword.value))
)

const outList = computed(() =>
  props.questions.filter((q) => !form.value.questionIds.includes(q.id)).filter((q) => matchKeyword(q, outKeyword.value))
)

function addOne(q: Question): void {
  if (!form.value.questionIds.includes(q.id)) form.value.questionIds.push(q.id)
}

function removeOne(q: Question): void {
  form.value.questionIds = form.value.questionIds.filter((id) => id !== q.id)
}

function addBatch(): void {
  outSelection.value.forEach(addOne)
  outSelection.value = []
}

function removeBatch(): void {
  const ids = new Set(inSelection.value.map((q) => q.id))
  form.value.questionIds = form.value.questionIds.filter((id) => !ids.has(id))
  inSelection.value = []
}

function onSave(): void {
  if (!form.value.name.trim()) {
    ElMessage.warning('请填写试卷名称')
    return
  }
  emit('save', JSON.parse(JSON.stringify(form.value)) as Paper)
  visible.value = false
}
</script>

<template>
  <el-dialog v-model="visible" title="试卷管理" width="92%" :close-on-click-modal="false" top="3vh" style="padding: 20px;">
    <el-form label-width="90px">
      <el-form-item label="试卷名称" required>
        <el-input v-model="form.name" placeholder="如：2010年199管理类综合能力考试" />
      </el-form-item>
      <el-form-item label="来源">
        <el-input v-model="form.source" placeholder="如：2010年真题" />
      </el-form-item>
      <el-form-item label="难度">
        <el-rate v-model="form.difficulty" :max="5" allow-half show-score text-color="#ff9900"/>
      </el-form-item>
    </el-form>

    <el-collapse v-model="activePanels">
      <el-collapse-item name="in">
        <template #title>
          <span>已添加题目（{{ form.questionIds.length }}）</span>
        </template>
        <div style="display: flex; gap: 12px; margin-bottom: 8px">
          <el-input v-model="inKeyword" placeholder="关键字查询" clearable style="max-width: 240px" />
          <el-button type="danger" plain :disabled="!inSelection.length" @click="removeBatch">
            批量移除（{{ inSelection.length }}）
          </el-button>
        </div>
        <el-table
          :data="inList"
          @selection-change="(rows: Question[]) => (inSelection = rows)"
        >
          <el-table-column type="selection" width="40" />
          <el-table-column label="题号" width="80">
            <template #default="{ row }">{{ shortId(row.id) }}</template>
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
          <el-table-column label="操作" width="80" fixed="right">
            <template #default="{ row }">
              <el-button link type="danger" @click="removeOne(row)">移除</el-button>
            </template>
          </el-table-column>
        </el-table>
      </el-collapse-item>

      <el-collapse-item name="out">
        <template #title>
          <span>未添加题目（{{ outList.length }}）</span>
        </template>
        <div style="display: flex; gap: 12px; margin-bottom: 8px">
          <el-input v-model="outKeyword" placeholder="关键字查询" clearable style="max-width: 240px" />
          <el-button type="primary" plain :disabled="!outSelection.length" @click="addBatch">
            批量添加（{{ outSelection.length }}）
          </el-button>
        </div>
        <el-table
          :data="outList"
          max-height="260"
          @selection-change="(rows: Question[]) => (outSelection = rows)"
        >
          <el-table-column type="selection" width="40" />
          <el-table-column label="题号" width="90">
            <template #default="{ row }">{{ shortId(row.id) }}</template>
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
          <el-table-column label="操作" width="80" fixed="right">
            <template #default="{ row }">
              <el-button link type="primary" @click="addOne(row)">添加</el-button>
            </template>
          </el-table-column>
        </el-table>
      </el-collapse-item>
    </el-collapse>

    <template #footer>
      <el-button @click="visible = false">取消</el-button>
      <el-button type="primary" @click="onSave">保存</el-button>
    </template>
  </el-dialog>
</template>
