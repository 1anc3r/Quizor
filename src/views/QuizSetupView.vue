<script setup lang="ts">
/**
 * 做题设置页：一张卡片，按入口渲染练习模式 / 考试模式两套配置。
 * 进入时自动恢复对应模式的上次设置（设置页记忆）；支持从错题本/收藏夹带范围跳入。
 */
import { computed, onMounted, ref, reactive } from 'vue'
import { useIsMobile } from '@/composables/useIsMobile'
import { useRoute, useRouter } from 'vue-router'
import { useBankStore } from '@/stores/bankStore'
import { useSettingsStore } from '@/stores/settings'
import { useUserDataStore } from '@/stores/userData'
import type { ExamConfig, ExamSource, PracticeConfig, PracticeScope, QuestionType } from '@/types'
import { buildExamQuestions, buildPracticeQuestions, loadStoredSession, makeSession, pruneOrphanSessions, replaceUnfinished, saveSession } from '@/stores/session'
import { bankProgressText } from '@/utils/bankProgress'
import SegmentedControl, { type SegOption } from '@/components/SegmentedControl.vue'

const route = useRoute()
const router = useRouter()
const bankStore = useBankStore()
const settingsStore = useSettingsStore()
const userStore = useUserDataStore()
const isMobile = useIsMobile()

const mode = computed<'practice' | 'exam'>(() => (route.params.mode === 'exam' ? 'exam' : 'practice'))

const practice = reactive<PracticeConfig>({ scope: 'all', chapter: '', count: 10, types: [] })
const exam = reactive<ExamConfig>({ source: 'simulate', paperId: '' })

const TYPE_OPTIONS: { label: string; value: QuestionType }[] = [
  { label: '单选', value: 'single' },
  { label: '多选', value: 'multiple' },
  { label: '判断', value: 'judge' },
  { label: '简答', value: 'text' }
]

// 范围 / 题量 / 考试模式：统一用设置页那套分段选择器（全局 .seg 样式）
const SCOPE_OPTIONS: SegOption<PracticeScope>[] = [
  { value: 'all', label: '全部' },
  { value: 'chapter', label: '按章节' },
  { value: 'wrong', label: '仅错题' },
  { value: 'favorite', label: '仅收藏' }
]

const COUNT_OPTIONS: SegOption<number | 'all'>[] = [
  { value: 10, label: '10' },
  { value: 20, label: '20' },
  { value: 50, label: '50' },
  { value: 'all', label: '全部' }
]

const EXAM_SOURCE_OPTIONS: SegOption<ExamSource>[] = [
  { value: 'simulate', label: '模拟模式' },
  { value: 'paper', label: '真题模式' }
]

/* ---------------- 全文加载状态 ----------------
 * 本页要等全文到位才能挑默认章节/试卷，而首页只加载了索引：
 * 用户从首页点进来时如果预取还没跑完，这里会实打实地等一次下载。
 * 因此必须把"在等什么、还要等多久"显式画出来 —— 没有提示的等待，体感就是卡住。
 */
/** 只在"真的还没到位"时才显示指示条，避免每次进页面闪一下 */
const bankLoading = ref(!bankStore.hasFullBank)

/**
 * 等待文案，与首页进度条同一口径：分母是**解压后**的字节数。
 * 拿不到可信总量时只说"已下载 X"，不编百分比。
 */
const bankLoadingText = computed<string>(() => bankProgressText(bankStore.progress))

/** 与首页同一条判据：下载阶段拿不到可信总量时用不确定态动画，别画一条卡在 0% 的实心条 */
const bankProgressIndeterminate = computed<boolean>(
  () => bankStore.progress.phase === 'download' && !bankStore.progress.total
)

onMounted(async () => {
  // 组卷需要题干、选项与答案，必须先把题库全文拉下来（首页只加载了索引）。
  // await 是必要的：下面的默认章节/试卷要从题库数据里挑第一个。
  await bankStore.ensureFullBank()
  bankLoading.value = false
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
      launch(makeSession(meta.id, 'practice', cfg, questions, 0))
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
      launch(makeSession(meta.id, 'exam', cfg, questions, meta.rule.durationMinutes, paperName))
    }
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '组卷失败')
  }
}

/**
 * 发起新会话：取消并删除同题库的旧未完成会话，落盘成功后进入答题页。
 * 落盘失败（配额不足）时清理孤儿会话后重试一次。
 * 校验用的是落盘结果（loadStoredSession），它不含题干——会话只存题号，
 * 题干由答题页按 id 回填，因此"存得上"与"题量"无关。
 */
function launch(session: import('@/types').QuizSession): void {
  pruneOrphanSessions()
  replaceUnfinished(session.bankId, session.id)
  saveSession(session)
  if (!loadStoredSession(session.id)) {
    // 写入失败：再清理一次并重试
    pruneOrphanSessions()
    saveSession(session)
  }
  if (!loadStoredSession(session.id)) {
    // 会话确实没存上：删除旧会话并撤掉指针，避免首页出现无法恢复的"继续上次答题"
    replaceUnfinished(session.bankId, '')
    ElMessage.error('本地存储空间不足，会话保存失败。请在设置页导出备份后清理缓存。')
    return
  }
  router.push(`/quiz/${session.id}`)
}
</script>

<template>
  <div class="app-content">
    <div v-if="isMobile" class="brand" style="margin-bottom: 16px;">Quizor<span>做题家 · 做题设置</span></div>
    <el-card class="page-card" shadow="never">
      <div class="card-title">
        <span class="title-text">{{ mode === 'practice' ? '练习模式' : '考试模式' }} · 做题设置</span>
        <span class="muted">{{ bankStore.meta?.name }}</span>
      </div>

      <!-- 全文加载指示：组卷要用题干/选项/答案，这一步没走完就开不了局。
           明确画出来（含真实进度），避免用户点了「开始答题」才发现还要等 -->
      <div v-if="bankLoading" class="setup-progress">
        <div class="progress-track" :class="{ 'is-indeterminate': bankProgressIndeterminate }">
          <div class="progress-fill"
            :style="bankProgressIndeterminate ? undefined : { width: `${Math.round(Math.min(1, Math.max(0, bankStore.progress.ratio)) * 100)}%` }">
          </div>
        </div>
        <div class="muted setup-progress-text">{{ bankLoadingText }}</div>
      </div>

      <!-- 练习模式 -->
      <template v-if="mode === 'practice'">
        <el-form label-width="40px" style="margin-top: 16px; max-width: 640px">
          <el-form-item label="范围">
            <SegmentedControl v-model:value="practice.scope" :options="SCOPE_OPTIONS" aria-label="练习范围" />
          </el-form-item>
          <el-form-item v-if="practice.scope === 'chapter'" label="章节">
            <el-select v-model="practice.chapter" style="width: 240px">
              <el-option v-for="c in bankStore.chapters" :key="c" :label="c" :value="c" />
            </el-select>
          </el-form-item>
          <el-form-item label="题量">
            <SegmentedControl v-model:value="practice.count" :options="COUNT_OPTIONS" aria-label="题量" />
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
        <el-form label-width="40px" style="margin-top: 16px; max-width: 640px">
          <el-form-item label="模式">
            <SegmentedControl v-model:value="exam.source" :options="EXAM_SOURCE_OPTIONS" aria-label="考试模式" />
          </el-form-item>
          <el-form-item v-if="exam.source === 'paper'" label="试卷">
            <el-select v-model="exam.paperId" style="width: 640px" placeholder="选择试卷">
              <el-option v-for="p in papers" :key="p.id" :label="`${p.name}（${p.questionIds.length} 题）`"
                :value="p.id" />
            </el-select>
          </el-form-item>
        </el-form>
        <el-alert v-if="exam.source === 'simulate' && rule" type="info" :closable="false" show-icon
          style="max-width: 640px">
          按组卷规则随机组卷：时长 {{ rule.durationMinutes }} 分钟，总分 {{ rule.totalScore }} 分{{
            rule.passScore ? `，及格线 ${rule.passScore} 分` : ''
          }}。交卷或超时后统一判分结算。
        </el-alert>
        <el-alert v-else-if="rule" type="info" :closable="false" show-icon style="max-width: 640px">
          按试卷原始顺序出题，时长 {{ rule.durationMinutes }} 分钟。交卷或超时后统一判分结算。
        </el-alert>
      </template>

      <div style="margin-top: 20px">
        <!-- loading 兼作禁用：加载期间点它只会弹一句"题库尚未加载完成"，
             不如直接不给点，等就绪后自动放开 -->
        <el-button type="primary" size="large" :loading="bankLoading" @click="start">开始答题</el-button>
        <el-button size="large" @click="router.back()">返回</el-button>
      </div>
    </el-card>
  </div>
</template>

<style scoped>
.setup-progress {
  margin-top: 16px;
  max-width: 640px;
}

.setup-progress .progress-track {
  height: 6px;
}

.setup-progress-text {
  margin-top: 6px;
  font-variant-numeric: tabular-nums;
}
</style>
