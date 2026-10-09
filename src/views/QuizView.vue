<script setup lang="ts">
/**
 * 做题页：凭路由参数 sessionId 从 localStorage 恢复会话（不通过路由传配置）。
 * - 顶部栏：退出 / 计时器 / 进度 / 收藏 / 答题卡 / 交卷
 * - 练习模式：每答一题即时反馈（单选/判断点击即判，多选确认后判，简答提交后自评）
 * - 考试模式：倒计时（截止时间 - 当前时间重算）、答题卡、标记，交卷或超时自动交卷统一判分
 * - 断点续答：localStorage 只存题号，挂载时先加载题库再回填题干（hydrateSession），
 *   作答变更防抖 300ms 落盘 + beforeunload 强制落盘
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { LayoutGrid, SquarePen, Star, Timer, X, Send } from '@lucide/vue'
import { useBankStore } from '@/stores/bankStore'
import { useSettingsStore } from '@/stores/settings'
import { useUserDataStore } from '@/stores/userData'
import {
  answerToText,
  flushSession,
  gradeSession,
  hydrateSession,
  isChoiceCorrect,
  loadStoredSession,
  persistSessionDebounced,
  removeSession,
  saveSession,
  setUnfinished
} from '@/stores/session'
import { saveBank } from '@/services/bankService'
import { useIsMobile } from '@/composables/useIsMobile'
import type { Question, QuestionType, QuizSession, SessionQuestion } from '@/types'
import { fmtDuration, typeLabel } from '@/utils/format'
import AnswerSheet from '@/components/AnswerSheet.vue'
import OptionGroup from '@/components/OptionGroup.vue'
import QuizFormDialog from '@/components/QuizFormDialog.vue'
import RichText from '@/components/RichText.vue'

const route = useRoute()
const router = useRouter()
const bankStore = useBankStore()
const settingsStore = useSettingsStore()
const userStore = useUserDataStore()

/**
 * 会话在挂载时异步恢复（要先 await 题库），期间 restoring 为 true 显示加载态。
 * 不能像以前那样在 setup 里同步 loadSession：那时只有题号，题干还没回填。
 */
const session = ref<QuizSession | null>(null)
const restoring = ref(true)
const submitted = ref(false)

const mode = computed(() => session.value?.mode ?? 'practice')
const questions = computed<SessionQuestion[]>(() => session.value?.questions ?? [])
const total = computed(() => questions.value.length)
const index = computed(() => session.value?.currentIndex ?? 0)
const current = computed<SessionQuestion | null>(() => questions.value[index.value] ?? null)
const answer = computed(() => (current.value && session.value ? session.value.answers[current.value.id] : null))
const revealed = computed(() => !!answer.value?.revealed)
const marked = computed(() => (current.value && session.value ? session.value.marks.includes(current.value.id) : false))
const isFaved = computed(() => (current.value ? userStore.favoriteIds.has(current.value.id) : false))
const isMobile = useIsMobile()
const sheetOpen = ref(window.innerWidth > 768)

function persist(): void {
  if (session.value) persistSessionDebounced(session.value)
}

/* ---------- 作答交互 ---------- */

function onSelect(keys: string[]): void {
  if (!session.value || !current.value || !answer.value || revealed.value) return
  answer.value.keys = keys
  persist()
  // 练习模式：单选/判断点击即判
  if (mode.value === 'practice' && current.value.type !== 'multiple') {
    reveal()
  }
}

function reveal(): void {
  if (!session.value || !current.value || !answer.value || revealed.value) return
  const q = current.value
  const ans = answer.value
  if (q.type === 'text') {
    // 简答：展示解析后由用户自评
    ans.revealed = true
    ans.correct = null
  } else {
    ans.revealed = true
    ans.correct = isChoiceCorrect(q, ans.keys)
    userStore.practiceResult(q.id, ans.correct, answerToText(q, ans), settingsStore.settings.wrongThreshold)
  }
  persist()
}

/** 练习模式简答题自评 */
function selfGradePractice(correct: boolean): void {
  if (!session.value || !current.value || !answer.value) return
  answer.value.correct = correct
  userStore.practiceResult(current.value.id, correct, answerToText(current.value, answer.value), settingsStore.settings.wrongThreshold)
  persist()
}

function onTextInput(v: string): void {
  if (!answer.value) return
  answer.value.text = v
  persist()
}

function toggleMark(): void {
  if (!session.value || !current.value) return
  const marks = session.value.marks
  const i = marks.indexOf(current.value.id)
  if (i >= 0) marks.splice(i, 1)
  else marks.push(current.value.id)
  persist()
}

function jump(i: number): void {
  if (!session.value || i < 0 || i >= total.value) return
  session.value.currentIndex = i
  persist()
  if (isMobile.value) sheetOpen.value = false
}

function prev(): void {
  jump(index.value - 1)
}
function next(): void {
  jump(index.value + 1)
}

function toggleFav(): void {
  if (current.value) userStore.toggleFavorite(current.value.id)
}

/* ---------- 开发模式：就地编辑当前题目 ---------- */

const editDialogVisible = ref(false)
const editingQuestion = ref<Question | null>(null)

/** 题目编辑窗口所需的章节/映射/标签（来自当前题库与组卷规则） */
const editChapters = computed<string[]>(() => bankStore.chapters)
const editChapterType = computed<Record<string, QuestionType>>(() => {
  const m: Record<string, QuestionType> = {}
  bankStore.meta?.rule.composition.forEach((c) => {
    if (c.chapter && !m[c.chapter]) m[c.chapter] = c.type
  })
  return m
})
const editChapterOptionCount = computed<Record<string, number>>(() => {
  const m: Record<string, number> = {}
  bankStore.meta?.rule.composition.forEach((c) => {
    if (c.chapter && !m[c.chapter]) m[c.chapter] = c.optionCount ?? 4
  })
  return m
})
const editAllTags = computed<string[]>(() => {
  const set = new Set<string>()
  bankStore.bank?.Questions.forEach((q) => q.tags.forEach((t) => t && set.add(t)))
  return [...set]
})
const editExistingIds = computed<string[]>(() => (bankStore.bank?.Questions ?? []).map((q) => q.id))

function openEdit(): void {
  if (!current.value) return
  editingQuestion.value = current.value
  editDialogVisible.value = true
}

/** 保存编辑：实时更新会话内题目快照与判分状态，并写回题库持久化 */
async function onSaveQuestion(q: Question): Promise<void> {
  const s = session.value
  if (!s) return
  const i = s.questions.findIndex((x) => x.id === q.id)
  if (i >= 0) {
    const score = s.questions[i].score
    s.questions[i] = { ...q, score }
    // 若该题已判分（练习即时反馈），按新答案重算正误
    const ans = s.answers[q.id]
    if (ans?.revealed && q.type !== 'text') {
      ans.correct = isChoiceCorrect(q, ans.keys)
    }
    persistSessionDebounced(s)
  }
  // 写回题库数据（localStorage 覆盖层），保证下次组卷/浏览同步
  const meta = bankStore.meta
  const bank = bankStore.bank
  if (meta && bank && meta.id === s.bankId) {
    const qi = bank.Questions.findIndex((x) => x.id === q.id)
    if (qi >= 0) {
      const prev = bank.Questions[qi]
      bank.Questions[qi] = q
      try {
        await saveBank(JSON.parse(JSON.stringify(meta)), JSON.parse(JSON.stringify(bank)))
      } catch (e) {
        // 写盘失败（多为 localStorage 配额溢出）时回滚内存改动，
        // 否则界面显示已更新、刷新后却丢失，用户无从察觉
        bank.Questions[qi] = prev
        ElMessage.error(e instanceof Error ? e.message : '题库保存失败')
        return
      }
      await bankStore.afterBankEdited(meta.id)
    }
  }
  ElMessage.success('题目已更新')
}

/* ---------- 计时（截止时间 - 当前时间 重算） ---------- */

const now = ref(Date.now())
let timer: number | null = null

const timeText = computed(() => {
  const s = session.value
  if (!s) return '00:00'
  if (s.mode === 'exam' && s.endTime) {
    return fmtDuration(Math.max(0, Math.round((s.endTime - now.value) / 1000)))
  }
  return fmtDuration(Math.round((now.value - s.startTime) / 1000))
})

const timeDanger = computed(() => {
  const s = session.value
  return !!(s && s.mode === 'exam' && s.endTime && s.endTime - now.value < 5 * 60_000)
})

watch(now, () => {
  const s = session.value
  if (s && !submitted.value && s.mode === 'exam' && s.endTime && now.value >= s.endTime) {
    void submit(true)
  }
})

/* ---------- 交卷 ---------- */

async function submit(auto: boolean): Promise<void> {
  const s = session.value
  if (!s || submitted.value) return
  if (!auto) {
    const unanswered = s.questions.filter((q) => {
      const a = s.answers[q.id]
      return q.type === 'text' ? !a.text.trim() : a.keys.length === 0
    }).length
    try {
      await ElMessageBox.confirm(
        unanswered > 0 ? `还有 ${unanswered} 题未作答，确定交卷吗？` : '确定交卷吗？',
        '交卷确认',
        { type: 'warning', confirmButtonText: '交卷', cancelButtonText: '再想想' }
      )
    } catch {
      return
    }
  }
  submitted.value = true
  flushSession()
  saveSession(s)
  const record = gradeSession(s, bankStore.meta?.name ?? s.bankId)
  // 考试模式：交卷后将答错题目统一收录错题本
  if (s.mode === 'exam') {
    for (const d of record.details) {
      if (d.correct === false) userStore.addWrong(d.questionId, d.yourAnswer)
    }
  }
  userStore.addRecord(record)
  removeSession(s.id)
  setUnfinished(s.bankId, null)
  session.value = null
  router.replace(`/result/${record.bankId}/${record.id}`)
}

function exit(): void {
  flushSession()
  if (session.value) saveSession(session.value)
  router.replace('/')
}

/* ---------- 滑动切题 ---------- */

let touchX = 0
let touchY = 0

function onTouchStart(e: TouchEvent): void {
  touchX = e.touches[0].clientX
  touchY = e.touches[0].clientY
}

function onTouchEnd(e: TouchEvent): void {
  if (!settingsStore.settings.swipe) return
  const dx = e.changedTouches[0].clientX - touchX
  const dy = e.changedTouches[0].clientY - touchY
  if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) {
    if (dx < 0) next() // 左滑下一题
    else prev() // 右滑上一题
  }
}

/* ---------- 生命周期 ---------- */

onMounted(async () => {
  try {
    const stored = loadStoredSession(String(route.params.sessionId))
    if (!stored) {
      ElMessage.error('会话不存在或已完成')
      router.replace('/')
      return
    }
    // 题干要按 id 从题库回填，所以必须先把会话所属题库加载好
    if (stored.bankId !== bankStore.currentId || !bankStore.bank) {
      await bankStore.switchBank(stored.bankId)
    }
    // 题库没加载出来（被删除/加载失败）时不能用空题目去 hydrate：
    // 那会把所有题判成"已从题库删除"从而清掉会话数据。此时保留会话，让用户先恢复题库。
    if (!bankStore.bank || bankStore.currentId !== stored.bankId) {
      ElMessage.error('题库加载失败，无法恢复本次会话')
      router.replace('/')
      return
    }
    const { session: full, missing } = hydrateSession(stored, bankStore.bank.Questions)
    if (!full.questions.length) {
      ElMessage.error('本次会话的题目已不在题库中，会话已失效')
      removeSession(stored.id)
      setUnfinished(stored.bankId, null)
      router.replace('/')
      return
    }
    session.value = full
    if (missing.length) {
      ElMessage.warning(`有 ${missing.length} 道题已不在题库中，已从本次会话移除`)
    }
    // 旧版本的会话里存着整题快照（单条可达 3MB 以上，写不进 localStorage），
    // 恢复成功就按轻量形态回写一次，把历史数据顺势瘦身
    saveSession(full)
    userStore.load(stored.bankId)
    timer = window.setInterval(() => {
      now.value = Date.now()
    }, 500)
    window.addEventListener('beforeunload', flushSession)
  } finally {
    restoring.value = false
  }
})

onBeforeUnmount(() => {
  if (timer !== null) window.clearInterval(timer)
  window.removeEventListener('beforeunload', flushSession)
  flushSession()
})
</script>

<template>
  <!-- 恢复中：题干要从题库按 id 回填后再渲染，避免先闪一屏空题 -->
  <div v-if="restoring" class="quiz-page">
    <div class="quiz-main">
      <el-card v-loading="true" element-loading-text="正在恢复会话…" shadow="never" class="page-card"
        style="min-height: 180px" />
    </div>
  </div>
  <div v-else-if="session" class="quiz-page" @touchstart.passive="onTouchStart" @touchend.passive="onTouchEnd">
    <!-- 顶部栏 -->
    <header class="quiz-top">
      <el-button size="large" text :icon="X" @click="exit"
        style="margin-left: 0px; display: inline-flex; align-items: center;">
        <span v-if="!isMobile">退出</span>
      </el-button>
      <span class="timer" :class="{ danger: timeDanger }">
        <el-icon>
          <Timer />
        </el-icon>{{ timeText }}
      </span>
      <span v-if="!isMobile" class="progress">{{ index + 1 }}/{{ total }}</span>
      <span class="spacer"></span>
      <el-button v-if="settingsStore.settings.devMode" text :icon="SquarePen" @click="openEdit"
        style="margin-left: 0px; display: inline-flex; align-items: center;">
        <span v-if="!isMobile">编辑</span>
      </el-button>
      <el-button text @click="toggleFav" style="margin-left: 0px; display: inline-flex; align-items: center;">
        <el-icon :color="isFaved ? '#e6a23c' : undefined">
          <Star :fill="isFaved ? 'currentColor' : 'none'" />
        </el-icon>
        <span v-if="!isMobile">收藏</span>
      </el-button>
      <el-button text :icon="LayoutGrid" @click="sheetOpen = !sheetOpen"
        style="margin-left: 0px; display: inline-flex; align-items: center;">
        <span v-if="!isMobile">答题卡</span>
      </el-button>
      <el-button :icon="Send" type="primary" @click="submit(false)"
        style="margin-left: 0px; margin-right: 15px;">交卷</el-button>
    </header>

    <div class="quiz-body">
      <!-- 题目卡片 -->
      <div class="quiz-main">
        <el-card v-if="current" shadow="never" class="page-card">
          <div class="muted" style="margin-bottom: 10px">
            第 {{ index + 1 }} 题 · {{ current.chapter }} · {{ typeLabel(current.type) }} · {{ current.score }} 分
            <template v-if="mode !== 'exam'"> · 难度</template>
            <el-rate v-if="mode !== 'exam'" v-model="current.difficulty" size="small" :max="5" disabled />
          </div>
          <RichText class="q-stem" :content="current.stem" />

          <!-- 选择题 -->
          <OptionGroup v-if="current.type !== 'text' && answer" :question="current" :selected="answer.keys"
            :revealed="revealed" @select="onSelect" />
          <div v-if="mode === 'practice' && current.type === 'multiple' && !revealed" style="margin-top: 12px">
            <el-button type="primary" :disabled="!answer || !answer.keys.length" @click="reveal">确认作答</el-button>
          </div>

          <!-- 简答题 -->
          <template v-if="current.type === 'text' && answer">
            <el-input :model-value="answer.text" type="textarea" :rows="5" placeholder="请输入你的作答"
              :disabled="mode === 'practice' && revealed" style="margin-top: 12px" @update:model-value="onTextInput" />
            <div v-if="mode === 'practice' && !revealed" style="margin-top: 12px">
              <el-button type="primary" @click="reveal">提交作答</el-button>
            </div>
          </template>

          <!-- 练习模式即时反馈 -->
          <div v-if="mode === 'practice' && revealed && answer" class="feedback">
            <div class="fb-line">
              <el-tag v-if="answer.correct === true" type="success">回答正确</el-tag>
              <el-tag v-else-if="answer.correct === false" type="danger">回答错误</el-tag>
              <el-tag v-else type="info">请对照解析自评</el-tag>
            </div>
            <div v-if="current.type !== 'text'" class="fb-line">
              <span class="fb-label">正确答案：</span>{{ [...current.answer].sort().join('、') }}
            </div>
            <div class="fb-line"><span class="fb-label">解析：</span></div>
            <RichText :content="current.analysis || '（无解析）'" />
            <div v-if="current.type === 'text' && answer.correct === null" style="margin-top: 10px">
              <el-button size="small" type="success" @click="selfGradePractice(true)">我答对了</el-button>
              <el-button size="small" type="danger" @click="selfGradePractice(false)">我答错了</el-button>
            </div>
          </div>

          <!-- 操作按钮 -->
          <div class="q-actions">
            <el-button :disabled="index === 0" @click="prev">上一题</el-button>
            <el-button :type="marked ? 'warning' : 'default'" @click="toggleMark">
              {{ marked ? '取消标记' : '标记' }}
            </el-button>
            <el-button :disabled="index === total - 1" @click="next">下一题</el-button>
          </div>
        </el-card>
      </div>

      <!-- Web 端答题卡：默认展示，点击按钮向右侧滑出/滑入 -->
      <transition name="slide">
        <aside v-show="sheetOpen && !isMobile" class="sheet-side">
          <div class="card-title" style="margin-bottom: 12px">
            <span class="title-text">答题卡</span>
          </div>
          <AnswerSheet :questions="questions" :answers="session.answers" :marks="session.marks" :current="index"
            :mode="mode" @jump="jump" />
        </aside>
      </transition>
    </div>

    <!-- 移动端答题卡：右侧抽屉滑入 -->
    <el-drawer v-if="isMobile" v-model="sheetOpen" direction="rtl" title="答题卡" size="70%">
      <AnswerSheet :questions="questions" :answers="session.answers" :marks="session.marks" :current="index"
        :mode="mode" @jump="jump" />
    </el-drawer>

    <!-- 开发模式：题目编辑窗口 -->
    <QuizFormDialog v-if="settingsStore.settings.devMode" v-model="editDialogVisible" :question="editingQuestion"
      :bank-id="session.bankId" :chapters="editChapters" :chapter-type="editChapterType"
      :chapter-option-count="editChapterOptionCount" :all-tags="editAllTags" :existing-ids="editExistingIds"
      @save="onSaveQuestion" />
  </div>
</template>

<style scoped>
.slide-enter-active,
.slide-leave-active {
  transition: all 0.25s ease;
}

.slide-enter-from,
.slide-leave-to {
  transform: translateX(40px);
  opacity: 0;
}
</style>
