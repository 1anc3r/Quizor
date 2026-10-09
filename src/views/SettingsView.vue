<script setup lang="ts">
/**
 * 设置页：外观偏好、练习/考试偏好记忆、滑动切题、错题阈值、导入导出。
 */
import { computed, ref, onMounted } from 'vue'
import { Link } from '@element-plus/icons-vue'
import { useBankStore } from '@/stores/bankStore'
import { useSettingsStore } from '@/stores/settings'
import { createBank, defaultRule, exportBackup, exportBankFile, loadBank, normalizeQuestions, saveBank } from '@/services/bankService'
import { useIsMobile } from '@/composables/useIsMobile'
import * as storage from '@/services/storage'
import type { BankData, BankRule, Paper } from '@/types'
import { findStaleSessions, gcSessions } from '@/stores/session'
import { fmtTime, typeLabel } from '@/utils/format'

const bankStore = useBankStore()
const settingsStore = useSettingsStore()
const s = settingsStore.settings
const isMobile = useIsMobile()

const theme = computed({
  get: () => s.theme === 'dark',
  set: (v: boolean) => (s.theme = v ? 'dark' : 'light')
})

/* ---------- 导入导出 ---------- */

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
const budgetStatus = computed(() =>
  budgetPercent.value >= 90 ? 'exception' : budgetPercent.value >= 70 ? 'warning' : 'success'
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

/* ---------- 清理缓存 ---------- */

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
  window.location.href = 'https://1anc3r.github.io/Flashcard-Collector/#/';
};
</script>

<template>
  <div class="app-content">
    <div v-if="isMobile" class="brand" style="margin-bottom: 16px;">Quizor<span>做题家 · 设置</span></div>
    <!-- 外观偏好 -->
    <el-card class="page-card" shadow="never">
      <div class="card-title"><span class="title-text">外观偏好</span></div>
      <el-form label-width="110px" style="margin-top: 12px; max-width: 560px">
        <el-form-item label="深色模式">
          <el-switch v-model="theme" active-text="深色" inactive-text="浅色" />
        </el-form-item>
        <el-form-item label="题干/选项字号">
          <el-radio-group v-model="s.fontSize">
            <el-radio-button value="small">小</el-radio-button>
            <el-radio-button value="standard">标准</el-radio-button>
            <el-radio-button value="large">大</el-radio-button>
          </el-radio-group>
        </el-form-item>
      </el-form>
    </el-card>

    <!-- 练习偏好 -->
    <el-card class="page-card" shadow="never">
      <div class="card-title">
        <span class="title-text">练习偏好</span>
        <el-button size="small" @click="settingsStore.resetPractice()">重置</el-button>
      </div>
      <div class="muted" style="margin-top: 8px">
        自动记住上次练习模式设置，进入做题设置页时恢复。当前记忆：范围「{{
          { all: '全部', chapter: '按章节', wrong: '仅错题', favorite: '仅收藏' }[s.practice.scope]
        }}」、题量「{{ s.practice.count === 'all' ? '全部' : s.practice.count }}」、题型「{{
          s.practice.types.length ? s.practice.types.map(typeLabel).join('、') : '全部'
        }}」
      </div>
    </el-card>

    <!-- 考试偏好 -->
    <el-card class="page-card" shadow="never">
      <div class="card-title">
        <span class="title-text">考试偏好</span>
        <el-button size="small" @click="settingsStore.resetExam()">重置</el-button>
      </div>
      <div class="muted" style="margin-top: 8px">
        自动记住上次考试模式设置。当前记忆：模式「{{ s.exam.source === 'simulate' ? '模拟模式' : '真题模式' }}」
      </div>
    </el-card>

    <!-- 做题偏好 -->
    <el-card class="page-card" shadow="never">
      <div class="card-title"><span class="title-text">做题偏好</span></div>
      <el-form label-width="110px" style="margin-top: 12px; max-width: 560px">
        <el-form-item label="滑动切题">
          <el-switch v-model="s.swipe" active-text="开" inactive-text="关" />
          <span class="muted" style="margin-left: 10px">左滑下一题、右滑上一题</span>
        </el-form-item>
        <el-form-item label="编辑模式">
          <el-switch v-model="s.devMode" active-text="开" inactive-text="关" />
          <span class="muted" style="margin-left: 10px">开启后答题页显示「编辑」按钮，可编辑当前题目</span>
        </el-form-item>
        <el-form-item label="错题移出阈值">
          <el-input-number v-model="s.wrongThreshold" :min="1" :max="10" />
          <span class="muted" style="margin-left: 10px">练习中连续答对达到该次数后自动移出错题本</span>
        </el-form-item>
      </el-form>
    </el-card>

    <!-- 导入导出 -->
    <el-card class="page-card" shadow="never">
      <div class="card-title"><span class="title-text">导入导出</span></div>
      <div style="display: flex; gap: 12px; flex-wrap: wrap; margin-top: 12px">
        <el-button type="warning" plain @click="onExportBank" style="margin: 0px;">导出题库 JSON</el-button>
        <el-upload :show-file-list="false" accept=".json,application/json" :http-request="() => { }"
          :on-change="onImportBankFile">
          <el-button type="success" plain :loading="importing">导入题库 JSON</el-button>
        </el-upload>
        <el-button type="warning" plain @click="onExportBackup" style="margin: 0px;">导出备份 JSON</el-button>
        <el-upload :show-file-list="false" accept=".json,application/json" :http-request="() => { }"
          :on-change="onImportBackupFile">
          <el-button type="success" plain :loading="importing" style="margin: 0px;">导入备份 JSON</el-button>
        </el-upload>
      </div>
      <el-alert type="info" :closable="false" show-icon style="margin-top: 12px">
        题库文件格式：{ name, rule, Questions, Papers }；备份文件为应用全部本地数据（quizor: 前缀）。当前题库 ID：{{
          bankStore.currentId || '无'
        }}<template v-if="bankStore.meta">，最近更新以浏览器本地存储为准（{{ fmtTime(Date.now()) }}）</template>。
      </el-alert>
    </el-card>

    <!-- 存储管理 -->
    <el-card class="page-card" shadow="never">
      <div class="card-title">
        <span class="title-text">存储管理</span>
        <el-button size="small" @click="refreshUsage">刷新</el-button>
      </div>

      <div style="margin-top: 12px; max-width: 100%">
        <el-progress :percentage="budgetPercent" :status="budgetStatus" :stroke-width="14" />
        <div class="muted" style="margin-top: 8px">
          已用 {{ fmtSize(usageInfo.bytes) }} / 预算 {{ fmtSize(BUDGET_BYTES) }}
        </div>
      </div>

      <!-- 题库存档在 IndexedDB：不受上面的 5MB 限制 -->
      <div class="usage-list" style="margin-top: 14px">
        <div class="usage-row usage-head">
          <span>题库存档（IndexedDB）</span>
          <span>占用</span>
        </div>
        <template v-if="idbInfo?.available">
          <div v-for="e in idbInfo.entries.slice(0, 5)" :key="e.key" class="usage-row">
            <span class="usage-key">
              <el-tag size="small" effect="plain">{{ kindOf(e.key) }}</el-tag>
              <span class="muted mono">{{ shortKey(e.key) }}</span>
            </span>
            <span class="usage-size">{{ fmtSize(e.chars * 2) }}</span>
          </div>
          <div v-if="!idbInfo.entries.length" class="usage-row muted">暂无题库编辑/导入数据</div>
        </template>
        <div v-else class="usage-row muted">
          {{ idbInfo === null ? '读取中…' : '不可用（浏览器禁用或隐私模式），题库存档已退回 localStorage' }}
        </div>
      </div>

      <div class="usage-groups">
        <el-tag v-for="g in groups" :key="g.label" type="info" effect="plain">
          {{ g.label }} · {{ fmtSize(g.chars * 2) }}
        </el-tag>
        <span v-if="!groups.length" class="muted">暂无本地数据</span>
      </div>

      <div class="usage-list">
        <div class="usage-row usage-head">
          <span>占用最大的数据项</span>
          <span>占用</span>
        </div>
        <div v-for="e in topKeys" :key="e.key" class="usage-row">
          <span class="usage-key">
            <el-tag size="small" effect="plain">{{ kindOf(e.key) }}</el-tag>
            <span class="muted mono">{{ shortKey(e.key) }}</span>
          </span>
          <span class="usage-size">{{ fmtSize(e.chars * 2) }}</span>
        </div>
        <div v-if="!topKeys.length" class="usage-row muted">暂无本地数据</div>
      </div>

      <div style="display: flex; gap: 10px; flex-wrap: wrap; align-items: center; margin-top: 14px">
        <el-button type="warning" plain :disabled="!staleSessions.length" @click="onGcSessions">
          清理废弃会话（{{ staleSessions.length }}）
        </el-button>
        <el-alert type="info" :closable="false" show-icon>
          废弃会话＝已无法从「继续上次答题」进入或超过 7 天未更新的会话；应用启动时也会自动回收。
        </el-alert>
      </div>

      <el-alert v-if="budgetPercent >= 80" type="warning" :closable="false" show-icon style="margin-top: 12px">
        本地存储占用偏高：建议先「导出备份 JSON」，再清理做题记录，或把大图改为外链以减小题库体积。
      </el-alert>

      <div style="display: flex; gap: 10px; flex-wrap: wrap; margin-top: 12px">
        <el-button type="danger" @click="onClearCache">清理缓存</el-button>
      </div>
      <el-alert type="warning" :closable="false" show-icon style="margin-top: 12px">
        将清空本浏览器中保存的全部应用数据（题库编辑与本地新增题库、错题本、收藏夹、做题记录、未完成会话与所有设置），
        包括 IndexedDB 中的题库存档；清理后自动刷新页面，且不可恢复。
      </el-alert>
    </el-card>

    <!-- 外链跳转 -->
    <el-card class="page-card" shadow="never">
      <div class="card-title"><span class="title-text">外链跳转</span></div>
      <div style="display: flex; gap: 10px; flex-wrap: wrap; margin-top: 12px">
        <el-button type="primary" plain :icon="Link" @click="redirectToExternalLink">跳转到 Collector · 闪卡收藏家</el-button>
      </div>
    </el-card>

    <!-- 赞赏码 -->
    <el-card class="page-card" shadow="never">
      <img src="/WechatCode.jpg" style="width: 100%"/>
    </el-card>
  </div>
</template>

<style scoped>
.usage-groups {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin-top: 14px;
}

.usage-list {
  margin-top: 14px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 6px;
  overflow: hidden;
}

.usage-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 6px 12px;
  font-size: 13px;
}

.usage-row + .usage-row {
  border-top: 1px solid var(--el-border-color-lighter);
}

.usage-head {
  background: var(--el-fill-color-light);
  color: var(--el-text-color-secondary);
  font-size: 12px;
}

.usage-key {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.usage-key .mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.usage-size {
  flex: none;
  font-variant-numeric: tabular-nums;
}
</style>
