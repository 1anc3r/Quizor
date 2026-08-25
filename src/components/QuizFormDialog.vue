<script setup lang="ts">
/**
 * 题目管理窗口：
 * 章节下拉选择并自动匹配题型（只读）、难度、富文本题干（Fluent Editor，支持图文并排与 LaTeX 公式）、
 * 选项勾选正确答案（单选/判断单选、多选多选）、富文本解析、来源与标签。
 */
import { computed, ref, watch } from 'vue'
import type { OptionItem, Question, QuestionType } from '@/types'
import RichEditor from './RichEditor.vue'
import { genId, nextQuestionId } from '@/utils/id'
import { plainText, typeLabel } from '@/utils/format'

const isMobile = ref(window.innerWidth <= 768)

const props = defineProps<{
  modelValue: boolean
  /** 编辑中的题目；null 表示新增 */
  question: Question | null
  bankId: string
  /** 章节列表（组卷规则 + 已有题目） */
  chapters: string[]
  /** 章节 → 题型 映射（来自组卷规则） */
  chapterType: Record<string, QuestionType>
  /** 章节 → 单题选项数 映射（来自组卷规则） */
  chapterOptionCount: Record<string, number>
  /** 已有标签 */
  allTags: string[]
  /** 已有题目 id（生成新题号用） */
  existingIds: string[]
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', v: boolean): void
  (e: 'save', q: Question): void
}>()

const visible = computed({
  get: () => props.modelValue,
  set: (v) => emit('update:modelValue', v)
})

interface OptionForm {
  key: string
  text: string
}

const form = ref({
  id: '',
  chapter: '',
  difficulty: 3,
  stem: '',
  analysis: '',
  source: '',
  tags: [] as string[]
})
const options = ref<OptionForm[]>([])
/** 单选/判断：正确选项 key；多选：正确选项 key 数组 */
const correctSingle = ref('')
const correctMulti = ref<string[]>([])

/** 题型由章节自动匹配，仅展示不可编辑 */
const questionType = computed<QuestionType>(() => {
  if (props.question) return props.question.type
  return props.chapterType[form.value.chapter] ?? 'single'
})

const KEY_SEQ = 'ABCDEFGH'

function defaultOptions(count: number): OptionForm[] {
  return Array.from({ length: Math.max(2, Math.min(8, count)) }, (_, i) => ({ key: KEY_SEQ[i], text: '' }))
}

watch(visible, (v) => {
  if (!v) return
  if (props.question) {
    const q = props.question
    form.value = {
      id: q.id,
      chapter: q.chapter,
      difficulty: q.difficulty,
      stem: q.stem,
      analysis: q.analysis,
      source: q.source,
      tags: [...q.tags]
    }
    options.value = q.options.map((o) => ({ ...o }))
    correctSingle.value = q.answer[0] ?? ''
    correctMulti.value = [...q.answer]
  } else {
    form.value = {
      id: '',
      chapter: props.chapters[0] ?? '',
      difficulty: 3,
      stem: '',
      analysis: '',
      source: '',
      tags: []
    }
    const t = props.chapterType[form.value.chapter] ?? 'single'
    if (t === 'judge') {
      options.value = [
        { key: 'A', text: '正确' },
        { key: 'B', text: '错误' }
      ]
    } else if (t === 'text') {
      options.value = []
    } else {
      options.value = defaultOptions(props.chapterOptionCount[form.value.chapter] ?? 4)
    }
    correctSingle.value = ''
    correctMulti.value = []
  }
})

/** 新增模式下切换章节：题型联动，选项按规则重建（仅当尚未录入选项内容时） */
function onChapterChange(): void {
  if (props.question) return
  const t = questionType.value
  const hasContent = options.value.some((o) => o.text.trim())
  if (t === 'judge') {
    options.value = [
      { key: 'A', text: '正确' },
      { key: 'B', text: '错误' }
    ]
  } else if (t === 'text') {
    options.value = []
  } else if (!hasContent) {
    options.value = defaultOptions(props.chapterOptionCount[form.value.chapter] ?? 4)
  }
  correctSingle.value = ''
  correctMulti.value = []
}

function addOption(): void {
  if (options.value.length >= 8) {
    ElMessage.warning('最多 8 个选项')
    return
  }
  options.value.push({ key: KEY_SEQ[options.value.length], text: '' })
}

function removeOption(i: number): void {
  if (options.value.length <= 2) {
    ElMessage.warning('至少保留 2 个选项')
    return
  }
  const removed = options.value.splice(i, 1)[0]
  options.value.forEach((o, idx) => (o.key = KEY_SEQ[idx]))
  if (correctSingle.value === removed.key) correctSingle.value = ''
  correctMulti.value = correctMulti.value.filter((k) => k !== removed.key)
}

function onSave(): void {
  if (!form.value.chapter) {
    ElMessage.warning('请选择章节')
    return
  }
  if (!plainText(form.value.stem)) {
    ElMessage.warning('请填写题干')
    return
  }
  const type = questionType.value
  let answer: string[] = []
  let finalOptions: OptionItem[] = []
  if (type !== 'text') {
    if (options.value.some((o) => !o.text.trim())) {
      ElMessage.warning('请补全所有选项内容')
      return
    }
    answer = type === 'multiple' ? [...correctMulti.value] : correctSingle.value ? [correctSingle.value] : []
    if (!answer.length) {
      ElMessage.warning('请勾选正确答案')
      return
    }
    finalOptions = options.value.map((o) => ({ key: o.key, text: o.text }))
  }
  const q: Question = {
    id: props.question?.id ?? nextQuestionId(props.bankId || 'bank', props.existingIds),
    type,
    chapter: form.value.chapter,
    difficulty: form.value.difficulty,
    stem: form.value.stem,
    options: finalOptions,
    answer,
    analysis: form.value.analysis,
    source: form.value.source,
    tags: [...form.value.tags]
  }
  emit('save', q)
  visible.value = false
}

// 保持引用，避免模板未使用告警（新增题目 id 预生成场景预留）
void genId
</script>

<template>
  <el-dialog v-model="visible" title="题目管理" width="92%" :close-on-click-modal="false" top="3vh" 
    :style="{ padding: '20px', width: isMobile ? '92%' : '60vw' }">
    <el-form label-width="90px">
      <el-form-item label="章节" required>
        <el-select
          v-model="form.chapter"
          filterable
          allow-create
          default-first-option
          placeholder="选择或录入章节"
          :disabled="!!question"
          @change="onChapterChange"
        >
          <el-option v-for="c in chapters" :key="c" :label="c" :value="c" />
        </el-select>
      </el-form-item>
      <el-form-item label="题型">
        <el-tag>{{ typeLabel(questionType) }}</el-tag>
        <span class="muted" style="margin-left: 8px">由章节按组卷规则自动匹配</span>
      </el-form-item>
      <el-form-item label="难度">
        <el-rate v-model="form.difficulty" :max="5" allow-half show-score text-color="#ff9900"/>
      </el-form-item>
      <el-form-item label="题干" required>
        <RichEditor v-model="form.stem" placeholder="请输入题干，支持富文本 / 图片 / LaTeX 公式" style="width: 100%;"/>
      </el-form-item>

      <template v-if="questionType !== 'text'">
        <el-form-item :label="questionType === 'multiple' ? '选项(多选)' : '选项(单选)'">
          <div style="width: 100%">
            <div
              v-for="(opt, i) in options"
              :key="i"
              style="display: flex; align-items: center; gap: 8px; margin-bottom: 8px"
            >
              <el-radio
                v-if="questionType !== 'multiple'"
                v-model="correctSingle"
                :value="opt.key"
                title="设为正确答案"
                size="large"
                style="margin-right: 0px;"
                >{{ '' }}</el-radio
              >
              <el-checkbox
                v-else
                v-model="correctMulti"
                :value="opt.key"
                :label="opt.key"
                title="设为正确答案"
                size="large"
                style="margin-right: 0px;"
              />
              <el-tag effect="plain" style="flex: none">{{ opt.key }}</el-tag>
              <el-input v-model="opt.text" placeholder="选项内容" :disabled="questionType === 'judge'" />
              <el-button
                v-if="questionType !== 'judge'"
                link
                type="danger"
                :disabled="options.length <= 2"
                @click="removeOption(i)"
                >删除</el-button
              >
            </div>
            <el-button v-if="questionType !== 'judge'" size="small" @click="addOption">添加选项</el-button>
            <span class="muted" style="margin-left: 10px">勾选左侧圆圈 / 方框标记正确答案</span>
          </div>
        </el-form-item>
      </template>

      <el-form-item :label="questionType === 'text' ? '参考答案' : '解析'">
        <RichEditor v-model="form.analysis" placeholder="请输入解析，支持富文本 / 图片 / LaTeX 公式"  style="width: 100%;" />
      </el-form-item>
      <el-form-item label="来源">
        <el-input v-model="form.source" placeholder="如：2010年真题" />
      </el-form-item>
      <el-form-item label="标签">
        <el-select
          v-model="form.tags"
          multiple
          filterable
          allow-create
          default-first-option
          placeholder="选择或录入标签"
          style="width: 100%"
        >
          <el-option v-for="t in allTags" :key="t" :label="t" :value="t" />
        </el-select>
      </el-form-item>
    </el-form>

    <template #footer>
      <el-button @click="visible = false">取消</el-button>
      <el-button type="primary" @click="onSave">保存</el-button>
    </template>
  </el-dialog>
</template>
