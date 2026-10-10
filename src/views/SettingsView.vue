<script setup lang="ts">
/**
 * 设置页：外观偏好、练习/考试偏好记忆、做题偏好、备份管理、存储管理。
 * Corporate Clean（企业简洁风）：统一的设置行结构 + 一致的按钮层级。
 */
import { computed, ref, onMounted } from 'vue'
import { Download, Moon, RefreshCw, SquareArrowOutUpRight, Sun, Trash2, Upload } from '@lucide/vue'
import { useBankStore } from '@/stores/bankStore'
import { useSettingsStore } from '@/stores/settings'
import { createBank, defaultRule, exportBackup, exportBankFile, loadBank, saveBank } from '@/services/bankService'
import { useIsMobile } from '@/composables/useIsMobile'
import * as storage from '@/services/storage'
import type { BankData, BankRule } from '@/types'
import { findStaleSessions, gcSessions } from '@/stores/session'
import { fmtTime, typeLabel } from '@/utils/format'
import SegmentedControl from '@/components/SegmentedControl.vue'

const bankStore = useBankStore()
const settingsStore = useSettingsStore()
const s = settingsStore.settings
const isMobile = useIsMobile()

/* ---------- 外观偏好 ---------- */

const themeOptions = [
  { value: 'light', label: '浅色', icon: Sun },
  { value: 'dark', label: '深色', icon: Moon }
] as const

const fontOptions = [
  { value: 'small', label: '小' },
  { value: 'standard', label: '标准' },
  { value: 'large', label: '大' }
] as const

/* ---------- 备份管理 ---------- */

const importing = ref(false)

function onExportBank(): void {
  const meta = bankStore.meta
  if (!meta) {
    ElMessage.warning('当前没有可用题库')
    return
  }
  void loadBank(meta.id).then((data) => {
    exportBankFile(meta, data)
    ElMessage.success('题库已导出')
  })
}

async function onExportBackup(): Promise<void> {
  await exportBackup()
  ElMessage.success('备份已导出')
}

function isBankFile(json: unknown): json is { name?: string; rule?: BankRule } & BankData {
  return !!json && typeof json === 'object' && Array.isArray((json as BankData).Questions)
}

function isBackupFile(json: unknown): json is Record<string, unknown> {
  return !!json && typeof json === 'object' && Object.keys(json as object).some((k) => k.startsWith('quizor:'))
}

async function readJsonFile(file: File): Promise<unknown> {
  const text = await file.text()
  return JSON.parse(text)
}

/** 导入题库 JSON：{ name?, rule?, Questions, Papers? }，作为新题库加入 */
async function onImportBankFile(uploadFile: { raw?: File }): Promise<void> {
  const file = uploadFile.raw
  if (!file) return
  importing.value = true
  try {
    const json = await readJsonFile(file)
    if (!isBankFile(json)) {
      ElMessage.error('文件格式不符：题库文件应包含 Questions 数组（{ name?, rule?, Questions, Papers? }）')
      return
    }
    const name = json.name || file.name.replace(/\.json$/i, '')
    const meta = await createBank(name, json.rule ?? defaultRule())
    const data: BankData = {
      Questions: Array.isArray(json.Questions) ? json.Questions : [],
      Papers: Array.isArray(json.Papers) ? json.Papers : []
    }
    await saveBank(meta, data)
    await bankStore.afterBankEdited(meta.id)
    ElMessage.success(`题库「${meta.name}」导入成功`)
  } catch {
    ElMessage.error('文件解析失败，请确认是合法的 JSON 文件')
  } finally {
    importing.value = false
  }
}

/** 导入备份 JSON：应用全部本地数据（quizor: 前缀键值对），覆盖式恢复 */
async function onImportBackupFile(uploadFile: { raw?: File }): Promise<void> {
  const file = uploadFile.raw
  if (!file) return
  importing.value = true
  try {
    const json = await readJsonFile(file)
    if (!isBackupFile(json)) {
      ElMessage.error('文件格式不符：备份文件应为应用导出的全部本地数据（quizor: 前缀键值对）')
      return
    }
    try {
      await ElMessageBox.confirm('导入备份将覆盖本浏览器内的全部题库编辑、错题、收藏、记录与设置，确定继续吗？', '导入备份', {
        type: 'warning',
        confirmButtonText: '覆盖导入',
        cancelButtonText: '取消'
      })
    } catch {
      return
    }
    await storage.importBackup(json)
    ElMessage.success('备份导入成功，即将刷新页面')
    window.setTimeout(() => window.location.reload(), 800)
  } catch {
    ElMessage.error('文件解析失败，请确认是合法的 JSON 文件')
  } finally {
    importing.value = false
  }
}

/* ---------- 存储占用 ---------- */

const usageInfo = ref(storage.usage())
const staleSessions = ref<string[]>([])
/** IndexedDB（题库存档）占用，需异步读取 */
const idbInfo = ref<storage.IdbUsage | null>(null)

/** localStorage 按 UTF-16 计，字符数 × 2 ≈ 字节数 */
const BUDGET_BYTES = storage.SOFT_BUDGET_CHARS * 2

const budgetPercent = computed(() =>
  Math.min(100, Math.round((usageInfo.value.chars / storage.SOFT_BUDGET_CHARS) * 100))
)
const budgetColor = computed(() =>
  budgetPercent.value >= 90 ? 'var(--q-danger)' : budgetPercent.value >= 70 ? 'var(--q-warning)' : 'var(--q-success)'
)

/** 数据 key → 可读分类名 */
function kindOf(fullKey: string): string {
  const name = fullKey.slice(storage.PREFIX.length)
  if (name.startsWith('bankdata:')) return '题库数据'
  if (name.startsWith('bankmeta:')) return '题库信息'
  if (name.startsWith('records:')) return '做题记录'
  if (name.startsWith('session:')) return '答题会话'
  if (name.startsWith('wrong:')) return '错题本'
  if (name.startsWith('fav:')) return '收藏夹'
  if (name.startsWith('unfinished:')) return '续答指针'
  if (name.startsWith('localbanks')) return '本地题库清单'
  if (name.startsWith('deletedbanks')) return '已删题库名单'
  if (name.startsWith('settings')) return '应用设置'
  if (name.startsWith('currentBank')) return '当前题库'
  return '其他'
}

const groups = computed(() => {
  const m = new Map<string, number>()
  for (const e of usageInfo.value.keys) {
    const label = kindOf(e.key)
    m.set(label, (m.get(label) ?? 0) + e.chars)
  }
  return [...m.entries()]
    .map(([label, chars]) => ({ label, chars }))
    .sort((a, b) => b.chars - a.chars)
})

const topKeys = computed(() => usageInfo.value.keys.slice(0, 5))

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}

function shortKey(fullKey: string): string {
  const name = fullKey.slice(storage.PREFIX.length)
  return name.length > 42 ? `${name.slice(0, 42)}…` : name
}

async function refreshUsage(): Promise<void> {
  usageInfo.value = storage.usage()
  staleSessions.value = findStaleSessions()
  idbInfo.value = await storage.idbUsage()
}

function onGcSessions(): void {
  const n = gcSessions()
  void refreshUsage()
  if (n > 0) ElMessage.success(`已回收 ${n} 个废弃会话`)
  else ElMessage.info('没有需要回收的废弃会话')
}

/* ---------- 危险操作 ---------- */

async function onClearCache(): Promise<void> {
  try {
    await ElMessageBox.confirm(
      '将清空本浏览器内的全部应用数据（题库编辑与本地新增题库、错题本、收藏夹、做题记录、未完成会话与所有设置），且不可恢复。确定清理吗？',
      '清理缓存',
      { type: 'error', confirmButtonText: '清空全部数据', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  await storage.clearAll()
  ElMessage.success('缓存已清理，即将刷新页面')
  window.setTimeout(() => window.location.reload(), 800)
}

function onResize(): void {
  isMobile.value = window.innerWidth <= 768
}

onMounted(async () => {
  window.addEventListener('resize', onResize)
  void refreshUsage()
})

/* ---------- 外链跳转 ---------- */

const redirectToExternalLink = () => {
  window.location.href = 'https://1anc3r.github.io/Flashcard-Collector/#/'
}
</script>

<template>
  <div class="app-content settings-page">
    <div v-if="isMobile" class="brand" style="margin-bottom: 16px">Quizor<span>做题家 · 设置</span></div>

    <!-- 外观偏好 -->
    <section class="cc-card settings-card">
      <div class="cc-card-title">
        <span class="title-text">外观偏好</span>
      </div>
      <div class="set-list">
        <div class="set-row">
          <div class="set-info">
            <div class="set-label">外观模式</div>
            <div class="set-desc">深色模式适合弱光环境，切换后即时生效。</div>
          </div>
          <SegmentedControl v-model:value="s.theme" :options="themeOptions" aria-label="外观模式" />
        </div>
        <div class="set-row">
          <div class="set-info">
            <div class="set-label">题干 / 选项字号</div>
            <div class="set-desc">调整答题页的题干、选项的文字大小。</div>
          </div>
          <SegmentedControl v-model:value="s.fontSize" :options="fontOptions" aria-label="字号" />
        </div>
      </div>
    </section>

    <!-- 做题偏好 -->
    <section class="cc-card settings-card">
      <div class="cc-card-title">
        <span class="title-text">做题偏好</span>
      </div>
      <div class="set-list">
        <div class="set-row">
          <div class="set-info">
            <div class="set-label">练习偏好</div>
            <div class="set-desc">
              当前记忆：范围「{{ { all: '全部', chapter: '按章节', wrong: '仅错题', favorite: '仅收藏' }[s.practice.scope]
              }}」、题量「{{ s.practice.count === 'all' ? '全部' : s.practice.count }}」、题型「{{
                s.practice.types.length ? s.practice.types.map(typeLabel).join('、') : '全部'
              }}」
            </div>
          </div>
          <button type="button" class="cc-btn cc-btn-secondary btn-sm"
            @click="settingsStore.resetPractice()">重置</button>
        </div>
        <div class="set-row">
          <div class="set-info">
            <div class="set-label">考试偏好</div>
            <div class="set-desc">
              当前记忆：模式「{{ s.exam.source === 'simulate' ? '模拟模式' : '真题模式' }}」
            </div>
          </div>
          <button type="button" class="cc-btn cc-btn-secondary btn-sm" @click="settingsStore.resetExam()">重置</button>
        </div>
        <div class="set-row" v-if="isMobile">
          <div class="set-info">
            <div class="set-label">滑动切题</div>
            <div class="set-desc">开启后，答题页支持滑动切题：左滑下一题、右滑上一题。</div>
          </div>
          <el-switch v-model="s.swipe" />
        </div>
        <div class="set-row" v-if="!isMobile">
          <div class="set-info">
            <div class="set-label">键盘切题</div>
            <div class="set-desc">开启后，答题页支持键盘切题：按 ← / ↑ 切到上一题，按 → / ↓ 切到下一题。</div>
          </div>
          <el-switch v-model="s.keyNav" />
        </div>
        <div class="set-row" v-if="!isMobile">
          <div class="set-info">
            <div class="set-label">键盘作答</div>
            <div class="set-desc">
              开启后，答题页支持键盘作答：按字母键（A、B、C…）或数字键（1、2、3…），对应选项 A、B、C…
            </div>
          </div>
          <el-switch v-model="s.keyAnswer" />
        </div>
        <div class="set-row" v-if="!isMobile">
          <div class="set-info">
            <div class="set-label">编辑模式</div>
            <div class="set-desc">开启后，答题页导航栏显示「编辑」按钮，支持直接编辑当前题目。</div>
          </div>
          <el-switch v-model="s.devMode" />
        </div>
        <div class="set-row">
          <div class="set-info">
            <div class="set-label">错题移出阈值</div>
            <div class="set-desc">练习中连续答对达到该次数后，自动移出错题本。</div>
          </div>
          <el-input-number v-model="s.wrongThreshold" :min="1" :max="10" />
        </div>
      </div>
    </section>

    <!-- 备份管理 -->
    <section class="cc-card settings-card">
      <div class="cc-card-title">
        <span class="title-text">备份管理</span>
      </div>
      <div class="set-row" style="margin-top: 4px">
        <div class="set-info">
          <div class="set-label">题库文件</div>
          <div class="set-desc">格式：{ name, rule, Questions, Papers }，用于备份旧题库或加入新题库。</div>
        </div>
        <div class="btn-group">
          <button type="button" class="cc-btn btn-sm" @click="onExportBank">
            <el-icon :size="14">
              <Download />
            </el-icon>导出题库
          </button>
          <el-upload :show-file-list="false" accept=".json,application/json" :http-request="() => { }"
            :on-change="onImportBankFile">
            <button type="button" class="cc-btn cc-btn-secondary btn-sm" :disabled="importing">
              <el-icon :size="14">
                <Upload />
              </el-icon>导入题库
            </button>
          </el-upload>
        </div>
      </div>
      <div class="set-row">
        <div class="set-info">
          <div class="set-label">完整备份</div>
          <div class="set-desc">包含全部本地数据（quizor: 前缀），用于换机或浏览器迁移。</div>
        </div>
        <div class="btn-group">
          <button type="button" class="cc-btn btn-sm" @click="onExportBackup">
            <el-icon :size="14">
              <Download />
            </el-icon>导出备份
          </button>
          <el-upload :show-file-list="false" accept=".json,application/json" :http-request="() => { }"
            :on-change="onImportBackupFile">
            <button type="button" class="cc-btn cc-btn-secondary btn-sm" :disabled="importing">
              <el-icon :size="14">
                <Upload />
              </el-icon>导入备份
            </button>
          </el-upload>
        </div>
      </div>
      <el-alert type="info" :closable="false" show-icon>
        当前题库 ID：{{ bankStore.currentId || '无'
        }}<template v-if="bankStore.meta">，最近更新以浏览器本地存储为准（{{ fmtTime(Date.now()) }}）</template>。
      </el-alert>
    </section>

    <!-- 存储管理 -->
    <section class="cc-card settings-card">
      <div class="cc-card-title">
        <span class="title-text">存储管理</span>
        <button type="button" class="cc-btn cc-btn-secondary btn-sm" @click="refreshUsage">
          <el-icon :size="14">
            <RefreshCw />
          </el-icon>刷新
        </button>
      </div>

      <!-- 用量进度 -->
      <div class="usage-meter">
        <div class="usage-meter-head">
          <span class="set-label">本地存储（localStorage）用量</span>
          <span class="muted">已用 {{ fmtSize(usageInfo.bytes) }} / 预算 {{ fmtSize(BUDGET_BYTES) }}</span>
        </div>
        <div class="progress-track" role="progressbar" :aria-valuenow="budgetPercent" aria-valuemin="0"
          aria-valuemax="100">
          <div class="progress-fill" :style="{ width: budgetPercent + '%', background: budgetColor }" />
        </div>
      </div>

      <!-- 分类占比 -->
      <!-- <div class="usage-groups">
        <span v-for="g in groups" :key="g.label" class="usage-tag">
          {{ g.label }} · {{ fmtSize(g.chars * 2) }}
        </span>
        <span v-if="!groups.length" class="muted">暂无本地数据</span>
      </div> -->

      <!-- 本地存储（localStorage） -->
      <div class="usage-block">
        <div class="usage-block-title">本地存储（localStorage），受 5MB 限制</div>
        <div class="usage-table">
          <div class="usage-row usage-head">
            <span>数据项</span>
            <span class="usage-size">占用</span>
          </div>
          <div v-for="e in topKeys" :key="e.key" class="usage-row">
            <span class="usage-key">
              <span class="usage-tag">{{ kindOf(e.key) }}</span>
              <span class="muted usage-mono">{{ shortKey(e.key) }}</span>
            </span>
            <span class="usage-size">{{ fmtSize(e.chars * 2) }}</span>
          </div>
          <div v-if="!topKeys.length" class="usage-row muted">暂无本地数据</div>
        </div>
      </div>

      <!-- 异步数据库（IndexedDB） -->
      <div class="usage-block">
        <div class="usage-block-title">异步数据库（IndexedDB），不受 5MB 限制</div>
        <div class="usage-table">
          <div class="usage-row usage-head">
            <span>数据项</span>
            <span class="usage-size">占用</span>
          </div>
          <template v-if="idbInfo?.available">
            <div v-for="e in idbInfo.entries.slice(0, 5)" :key="e.key" class="usage-row">
              <span class="usage-key">
                <span class="usage-tag">{{ kindOf(e.key) }}</span>
                <span class="muted usage-mono">{{ shortKey(e.key) }}</span>
              </span>
              <span class="usage-size">{{ fmtSize(e.chars * 2) }}</span>
            </div>
            <div v-if="!idbInfo.entries.length" class="usage-row muted">暂无题库编辑/导入数据</div>
          </template>
          <div v-else class="usage-row muted">
            {{ idbInfo === null ? '读取中…' : '不可用（浏览器禁用或隐私模式），题库存档已退回 localStorage' }}
          </div>
        </div>
      </div>

      <div style="margin-top: 16px">
        <button type="button" class="cc-btn cc-btn-secondary btn-sm" :disabled="!staleSessions.length"
          @click="onGcSessions">
          <el-icon :size="14">
            <Trash2 />
          </el-icon>清理废弃会话（{{ staleSessions.length }}）
        </button>
      </div>
      <el-alert type="info" :closable="false" show-icon style="margin-top: 16px">
        废弃会话：已无法从「继续上次答题」进入或超过 7 天未更新的会话；应用启动时也会自动回收。
      </el-alert>

      <div style="margin-top: 16px">
        <button type="button" class="cc-btn cc-btn-danger btn-sm" @click="onClearCache">
          <el-icon :size="14">
            <Trash2 />
          </el-icon>清理缓存
        </button>
      </div>
      <el-alert type="warning" :closable="false" show-icon style="margin-top: 16px">
        将清空本浏览器中保存的全部应用数据（题库编辑与本地新增题库、错题本、收藏夹、做题记录、未完成会话与所有设置），包括：本地存储（localStorage）和异步数据库（IndexedDB）。清理后自动刷新页面，且不可恢复。
      </el-alert>
      <el-alert v-if="budgetPercent >= 80" type="warning" :closable="false" show-icon style="margin-top: 16px">
        本地存储占用偏高：建议先「导出备份」，再清理缓存。
      </el-alert>
    </section>

    <!-- 外链与赞赏 -->
    <section class="cc-card settings-card about-card">
      <div class="cc-card-title">
        <span class="title-text">支持与外链</span>
      </div>
      <div class="set-row" style="margin-top: 4px">
        <div class="set-info">
          <div class="set-label">闪卡收藏家 Collector</div>
          <div class="set-desc">同作者的卡片记忆应用，与 Quizor 搭配使用。</div>
        </div>
        <button type="button" class="cc-btn cc-btn-secondary btn-sm" @click="redirectToExternalLink">
          <el-icon :size="14">
            <SquareArrowOutUpRight />
          </el-icon>前往
        </button>
      </div>

      <div class="donate">
        <img src="/WechatCode.jpg" alt="赞赏码" class="donate-img" />
        <p class="donate-quote">「知识因流动而有价值，感谢您的支持和鼓励！」</p>
      </div>
    </section>
  </div>
</template>

<style scoped>
.settings-card {
  margin-bottom: 20px;
}
</style>
