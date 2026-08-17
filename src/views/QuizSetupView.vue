<script setup lang="ts">
/**
 * 做题设置页：一张卡片，按入口渲染练习模式 / 考试模式两套配置。
 * 进入时自动恢复对应模式的上次设置（设置页记忆）；支持从错题本/收藏夹带范围跳入。
 */
import { computed, onMounted, reactive } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useBankStore } from '@/stores/bank'
import { useSettingsStore } from '@/stores/settings'
import { useUserDataStore } from '@/stores/userData'
import type { ExamConfig, PracticeConfig, PracticeScope, QuestionType } from '@/types'
import { buildExamQuestions, buildPracticeQuestions, makeSession, saveSession, setUnfinished } from '@/services/session'

const route = useRoute()
const router = useRouter()
const bankStore = useBankStore()
const settingsStore = useSettingsStore()
const userStore = useUserDataStore()

const mode = computed<'practice' | 'exam'>(() => (route.params.mode === 'exam' ? 'exam' : 'practice'))

const practice = reactive<PracticeConfig>({ scope: 'all', chapter: '', count: 10, types: [] })
const exam = reactive<ExamConfig>({ source: 'simulate', paperId: '' })

const TYPE_OPTIONS: { label: string; value: QuestionType }[] = [
  { label: '单选', value: 'single' },
  { label: '多选', value: 'multiple' },
  { label: '判断', value: 'judge' },
  { label: '简答', value: 'text' }
]

const SCOPE_OPTIONS: { label: string; value: PracticeScope }[] = [
  { label: '全部', value: 'all' },
  { label: '按章节', value: 'chapter' },
  { label: '仅错题', value: 'wrong' },
  { label: '仅收藏', value: 'favorite' }
]

onMounted(() => {
  // 恢复上次对应模式的设置
  if (mode.value === 'practice') {
    Object.assign(practice, JSON.parse(JSON.stringify(settingsStore.settings.practice)))
    // 错题本 / 收藏夹「练习」入口带范围跳入
    const scope = route.query.scope
    if (scope === 'all' || scope === 'chapter' || scope === 'wrong' || scope === 'favorite') {
      practice.scope = scope
    }
    if (!practice.chapter) practice.chapter = bankStore.chapters[0] ?? ''
  } else {
    Object.assign(exam, JSON.parse(JSON.stringify(settingsStore.settings.exam)))
    if (!exam.paperId) exam.paperId = bankStore.bank?.Papers[0]?.id ?? ''
  }
})

const papers = computed(() => bankStore.bank?.Papers ?? [])
const rule = computed(() => bankStore.meta?.rule)

function start(): void {
  const bank = bankStore.bank
  const meta = bankStore.meta
  if (!bank || !meta) {
    ElMessage.error('题库尚未加载完成')
    return
  }
  try {
    if (mode.value === 'practice') {
      const cfg = JSON.parse(JSON.stringify(practice)) as PracticeConfig
      const questions = buildPracticeQuestions(bank, cfg, userStore.wrongIds, userStore.favoriteIds)
      if (!questions.length) {
        ElMessage.warning('按当前条件没有可练习的题目')
        return
      }
      settingsStore.rememberPractice(cfg)
      const session = makeSession(meta.id, 'practice', cfg, questions, 0)
      saveSession(session)
      setUnfinished(meta.id, session.id)
      router.push(`/quiz/${session.id}`)
    } else {
      const cfg = JSON.parse(JSON.stringify(exam)) as ExamConfig
      if (cfg.source === 'paper' && !cfg.paperId) {
        ElMessage.warning('请选择试卷')
        return
      }
      if (cfg.source === 'simulate' && !meta.rule.composition.length) {
        ElMessage.warning('当前题库未配置组卷规则，请先在题库管理中设置')
        return
      }
      const { questions, paperName } = buildExamQuestions(bank, cfg, meta.rule)
      if (!questions.length) {
        ElMessage.warning('按当前组卷规则没有可出卷的题目')
        return
      }
      settingsStore.rememberExam(cfg)
      const session = makeSession(meta.id, 'exam', cfg, questions, meta.rule.durationMinutes, paperName)
      saveSession(session)
      setUnfinished(meta.id, session.id)
      router.push(`/quiz/${session.id}`)
    }
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '组卷失败')
  }
}
</script>

<template>
  <el-card class="page-card" shadow="never">
    <div class="card-title">
      <span class="title-text">{{ mode === 'practice' ? '练习模式' : '考试模式' }} · 做题设置</span>
      <span class="muted">{{ bankStore.meta?.name }}</span>
    </div>

    <!-- 练习模式 -->
    <template v-if="mode === 'practice'">
      <el-form label-width="80px" style="margin-top: 16px; max-width: 640px">
        <el-form-item label="范围">
          <el-radio-group v-model="practice.scope">
            <el-radio-button v-for="o in SCOPE_OPTIONS" :key="o.value" :value="o.value">{{ o.label }}</el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item v-if="practice.scope === 'chapter'" label="章节">
          <el-select v-model="practice.chapter" style="width: 240px">
            <el-option v-for="c in bankStore.chapters" :key="c" :label="c" :value="c" />
          </el-select>
        </el-form-item>
        <el-form-item label="题量">
          <el-radio-group v-model="practice.count">
            <el-radio-button :value="10">10</el-radio-button>
            <el-radio-button :value="20">20</el-radio-button>
            <el-radio-button :value="50">50</el-radio-button>
            <el-radio-button value="all">全部</el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="题型">
          <el-checkbox-group v-model="practice.types">
            <el-checkbox v-for="t in TYPE_OPTIONS" :key="t.value" :value="t.value">{{ t.label }}</el-checkbox>
          </el-checkbox-group>
          <div class="muted" style="margin-left: 8px">不勾选表示全部题型</div>
        </el-form-item>
      </el-form>
      <el-alert type="info" :closable="false" show-icon style="max-width: 640px">
        乱序抽题，每答一题即时反馈结果与解析，答错自动入错题本；可随时手动交卷结算。
      </el-alert>
    </template>

    <!-- 考试模式 -->
    <template v-else>
      <el-form label-width="80px" style="margin-top: 16px; max-width: 640px">
        <el-form-item label="模式">
          <el-radio-group v-model="exam.source">
            <el-radio-button value="simulate">模拟模式</el-radio-button>
            <el-radio-button value="paper">真题模式</el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item v-if="exam.source === 'paper'" label="试卷">
          <el-select v-model="exam.paperId" style="width: 640px" placeholder="选择试卷">
            <el-option v-for="p in papers" :key="p.id" :label="`${p.name}（${p.questionIds.length} 题）`" :value="p.id" />
          </el-select>
        </el-form-item>
      </el-form>
      <el-alert v-if="exam.source === 'simulate' && rule" type="info" :closable="false" show-icon style="max-width: 640px">
        按组卷规则随机组卷：时长 {{ rule.durationMinutes }} 分钟，总分 {{ rule.totalScore }} 分{{
          rule.passScore ? `，及格线 ${rule.passScore} 分` : ''
        }}。交卷或超时后统一判分。
      </el-alert>
      <el-alert v-else-if="rule" type="info" :closable="false" show-icon style="max-width: 640px">
        按试卷原始顺序出题，时长 {{ rule.durationMinutes }} 分钟。交卷或超时后统一判分。
      </el-alert>
    </template>

    <div style="margin-top: 20px">
      <el-button type="primary" size="large" @click="start">开始答题</el-button>
      <el-button size="large" @click="router.back()">返回</el-button>
    </div>
  </el-card>
</template>
