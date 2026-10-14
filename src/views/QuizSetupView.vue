<script setup lang="ts">
/**
 * 做题设置页：一张卡片，按入口渲染练习模式 / 考试模式两套配置。
 * 进入时自动恢复对应模式的上次设置（设置页记忆）；支持从错题本/收藏夹带范围跳入。
 */
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useIsMobile } from '@/composables/useIsMobile'
import { useRoute, useRouter } from 'vue-router'
import { useBankStore } from '@/stores/bankStore'
import { useSettingsStore } from '@/stores/settings'
import { useUserDataStore } from '@/stores/userData'
import type { BankData, BankMeta, ExamConfig, ExamSource, PracticeConfig, PracticeScope, QuizSession } from '@/types'
import { buildExamQuestionsAsync, buildPracticeQuestionsAsync } from '@/services/quizWorkerApi'
import { loadStoredSession, makeSession, pruneOrphanSessions, replaceUnfinished, saveSession } from '@/stores/session'
import { bankProgressText } from '@/utils/bankProgress'
import { TYPE_OPTIONS } from '@/utils/format'
import SegmentedControl, { type SegOption } from '@/components/SegmentedControl.vue'
import BusyOverlay from '@/components/BusyOverlay.vue'

const route = useRoute()
const router = useRouter()
const bankStore = useBankStore()
const settingsStore = useSettingsStore()
const userStore = useUserDataStore()
const isMobile = useIsMobile()

const mode = computed<'practice' | 'exam'>(() => (route.params.mode === 'exam' ? 'exam' : 'practice'))

const practice = reactive<PracticeConfig>({ scope: 'all', chapter: '', count: 10, types: [] })
const exam = reactive<ExamConfig>({ source: 'simulate', paperId: '' })

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
/**
 * 指示条挂在题库的**真实状态**上，而不是挂载时拍下的那张快照。
 *
 * 快照版本（`ref(!hasFullBank)`，只在 `await ensureFullBank()` 返回后置 false）会跟真相脱节：
 * 首页预取与本次进入页面共享同一次加载，全文真正到手的时刻是 `bank.value` 被赋值，
 * 而"解析完成 → 本次 await 恢复执行"之间还隔着一次微任务调度，甚至可能是会话恢复那类
 * 完全不带进度的加载路径。那段时间里进度条已经走满、按钮却仍是 loading，
 * 用户看到的是"条走完了却什么都没发生"。
 */
const bankLoading = computed<boolean>(() => !bankStore.hasFullBank)

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

/* ---------------- 组卷进行中（Worker 异步执行，遮罩展示真实进度） ---------------- */
const building = ref(false)
const buildDetail = ref('')
/** null = 还没拿到第一批进度，进度环先走不确定态，不编假百分比 */
const buildRatio = ref<number | null>(null)

/** 让浏览器把当前这一帧（"100% / 正在进入答题页…"）画出来再去做同步的收尾工作 */
function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()))
}

function resetBuilding(): void {
  building.value = false
  buildRatio.value = null
  buildDetail.value = ''
}

/** 路由真的切走了才算这次跳转成功：由路由 watch 收尾，别在跳转途中把遮罩撤掉 */
let navigated = false
watch(
  () => route.fullPath,
  () => {
    navigated = true
    // 推到下一帧再撤遮罩：路由改完还要等答题页那个异步 chunk 到位，
    // 而答题页自己的恢复遮罩（同一个环形进度）是在挂载时才出现的。
    // 这里立刻撤掉的话，两块遮罩之间会露出空白的一拍
    void nextFrame().then(resetBuilding)
  }
)

function start(): void {
  const bank = bankStore.bank
  const meta = bankStore.meta
  if (!bank || !meta) {
    ElMessage.error('题库尚未加载完成')
    return
  }
  // 先做不依赖题库计算的校验：不通过就直接提示，不弹遮罩
  if (mode.value === 'exam') {
    if (exam.source === 'paper' && !exam.paperId) {
      ElMessage.warning('请选择试卷')
      return
    }
    if (exam.source === 'simulate' && !meta.rule.composition.length) {
      ElMessage.warning('当前题库未配置组卷规则，请先在题库管理中设置')
      return
    }
  }
  navigated = false
  building.value = true
  buildRatio.value = null
  buildDetail.value = '正在准备…'
  const onProgress = (ratio: number, label: string): void => {
    buildRatio.value = ratio
    buildDetail.value = label
  }
  // 组卷整体异步：过滤/乱序/题目快照克隆在 Worker 里分批完成，
  // 期间主线程只更新遮罩进度，"全部"这种几百题的会话也不会卡界面
  void (async () => {
    try {
      const session =
        mode.value === 'practice'
          ? await practiceSession(bank, meta.id, onProgress)
          : await examSession(bank, meta, onProgress)
      // 组卷没出题时不能走到这里：进度条上去了就必须真的换页，
      // "走满却停在原地"正是本页最容易被读成卡死的一种状态
      if (!session) return
      // 进度环走满 = 下一步就是答题页。落盘（会话序列化 + localStorage 写入）
      // 是同步的实打实耗时，把它放进"已完成"这一格，别让它顶着一个没满的环
      buildRatio.value = 1
      buildDetail.value = '正在进入答题页…'
      await nextFrame()
      launch(session)
    } catch (e) {
      ElMessage.error(e instanceof Error ? e.message : '组卷失败')
    } finally {
      // 跳转成功时由路由 watch 收尾（它在新页面挂载后才会跑到，遮罩能一路盖到答题页出现）；
      // 走到这里说明这次没能前进（校验/落盘失败），遮罩必须撤掉，
      // 否则界面会停在一个永远不动的进度环上
      if (!navigated) resetBuilding()
    }
  })()
}

/** 练习组卷：没有可出的题返回 null（调用方据此提示并停在设置页） */
async function practiceSession(
  bank: BankData,
  bankId: string,
  onProgress: (ratio: number, label: string) => void
): Promise<QuizSession | null> {
  const cfg = JSON.parse(JSON.stringify(practice)) as PracticeConfig
  const questions = await buildPracticeQuestionsAsync(bank, cfg, userStore.wrongIds, userStore.favoriteIds, onProgress)
  if (!questions.length) {
    ElMessage.warning('按当前条件没有可练习的题目')
    return null
  }
  settingsStore.rememberPractice(cfg)
  return makeSession(bankId, 'practice', cfg, questions, 0)
}

/** 考试组卷：同上 */
async function examSession(
  bank: BankData,
  meta: BankMeta,
  onProgress: (ratio: number, label: string) => void
): Promise<QuizSession | null> {
  const cfg = JSON.parse(JSON.stringify(exam)) as ExamConfig
  const { questions, paperName } = await buildExamQuestionsAsync(bank, cfg, meta.rule, onProgress)
  if (!questions.length) {
    ElMessage.warning('按当前组卷规则没有可出卷的题目')
    return null
  }
  settingsStore.rememberExam(cfg)
  return makeSession(meta.id, 'exam', cfg, questions, meta.rule.durationMinutes, paperName)
}

/**
 * 发起新会话：取消并删除同题库的旧未完成会话，落盘成功后进入答题页。
 * 落盘失败（配额不足）时清理孤儿会话后重试一次。
 * 校验用的是落盘结果（loadStoredSession），它不含题干——会话只存题号，
 * 题干由答题页按 id 回填，因此"存得上"与"题量"无关。
 */
function launch(session: import('@/types').QuizSession): void {
  if (storeSession(session)) {
    router.push(`/quiz/${session.id}`)
    return
  }
  // 会话确实没存上：删除旧会话并撤掉指针，避免首页出现无法恢复的"继续上次答题"
  replaceUnfinished(session.bankId, '')
  // 这里是本页唯一一处"进度条走满却没换页"的合法出口，必须给出下一步动作：
  // 只报一句错，用户盯着走完的进度环只会以为卡死了
  ElMessage.error({
    message: '本地存储空间不足，会话保存失败。请在「设置」先导出题库和备份，再查看占用并清理数据',
    duration: 8000,
    showClose: true
  })
}

/** 落盘并在写失败时清理孤儿会话重试一次，返回会话是否真的存进去了 */
function storeSession(session: import('@/types').QuizSession): boolean {
  pruneOrphanSessions()
  replaceUnfinished(session.bankId, session.id)
  saveSession(session)
  if (loadStoredSession(session.id)) return true
  pruneOrphanSessions()
  saveSession(session)
  return !!loadStoredSession(session.id)
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

    <!-- 组卷遮罩：Worker 分批执行，进度环展示真实进度；完成前挡住重复点击 -->
    <BusyOverlay :visible="building" title="正在组卷…" :detail="buildDetail" :ratio="buildRatio" />
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
