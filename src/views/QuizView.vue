<script setup lang="ts">
/**
 * 做题页：凭路由参数 sessionId 从 localStorage 恢复完整会话（不通过路由传配置）。
 * - 顶部栏：退出 / 计时器 / 进度 / 收藏 / 答题卡 / 交卷
 * - 练习模式：每答一题即时反馈（单选/判断点击即判，多选确认后判，简答提交后自评）
 * - 考试模式：倒计时（截止时间 - 当前时间重算）、答题卡、标记，交卷或超时自动交卷统一判分
 * - 断点续答：作答变更防抖 300ms 落盘 + beforeunload 强制落盘
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { Close, Star, StarFilled, Timer, Grid } from '@element-plus/icons-vue'
import { useBankStore } from '@/stores/bank'
import { useSettingsStore } from '@/stores/settings'
import { useUserDataStore } from '@/stores/userData'
import {
  answerToText,
  flushSession,
  gradeSession,
  isChoiceCorrect,
  loadSession,
  persistSessionDebounced,
  removeSession,
  saveSession,
  setUnfinished
} from '@/services/session'
import type { QuizSession, SessionQuestion } from '@/types'
import { fmtDuration, typeLabel } from '@/utils/format'
import AnswerSheet from '@/components/AnswerSheet.vue'
import OptionGroup from '@/components/OptionGroup.vue'
import RichText from '@/components/RichText.vue'

const route = useRoute()
const router = useRouter()
const bankStore = useBankStore()
const settingsStore = useSettingsStore()
const userStore = useUserDataStore()

const session = ref<QuizSession | null>(loadSession(String(route.params.sessionId)))
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
const isMobile = ref(window.innerWidth <= 768)
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

function onResize(): void {
  isMobile.value = window.innerWidth <= 768
}

onMounted(async () => {
  if (!session.value) {
    ElMessage.error('会话不存在或已完成')
    router.replace('/')
    return
  }
  // 确保用户数据（错题/收藏/记录）与会话所属题库对齐
  if (session.value.bankId !== bankStore.currentId) {
    await bankStore.switchBank(session.value.bankId)
  }
  userStore.load(session.value.bankId)
  timer = window.setInterval(() => {
    now.value = Date.now()
  }, 500)
  window.addEventListener('beforeunload', flushSession)
  window.addEventListener('resize', onResize)
})

onBeforeUnmount(() => {
  if (timer !== null) window.clearInterval(timer)
  window.removeEventListener('beforeunload', flushSession)
  window.removeEventListener('resize', onResize)
  flushSession()
})
</script>

<template>
  <div v-if="session" class="quiz-page" @touchstart.passive="onTouchStart" @touchend.passive="onTouchEnd">
    <!-- 顶部栏 -->
    <header class="quiz-top">
      <el-button text :icon="Close" @click="exit">退出</el-button>
      <span class="timer" :class="{ danger: timeDanger }">
        <el-icon>
          <Timer />
        </el-icon>{{ timeText }}
      </span>
      <span v-if="!isMobile" class="progress">{{ index + 1 }}/{{ total }}</span>
      <span class="spacer"></span>
      <el-button text @click="toggleFav">
        <el-icon :color="isFaved ? '#e6a23c' : undefined">
          <StarFilled v-if="isFaved" />
          <Star v-else />
        </el-icon>
      </el-button>
      <el-button text :icon="Grid" @click="sheetOpen = !sheetOpen" style="margin-left: 0px;">答题卡</el-button>
      <el-button type="primary" size="small" @click="submit(false)"
        style="margin-left: 0px; margin-right: 15px;">交卷</el-button>
    </header>

    <div class="quiz-body">
      <!-- 题目卡片 -->
      <div class="quiz-main">
        <el-card v-if="current" shadow="never" class="page-card">
          <div class="muted" style="margin-bottom: 10px">
            第 {{ index + 1 }} 题 · {{ current.chapter }} · {{ typeLabel(current.type) }} · 难度
            <el-rate v-model="current.difficulty" size="small" :max="5" disabled />
            <template v-if="mode === 'exam'"> · {{ current.score }} 分</template>
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
