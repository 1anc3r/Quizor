<script setup lang="ts">
/**
 * 设置页：外观偏好、练习/考试偏好记忆、滑动切题、错题阈值、导入导出。
 */
import { computed, ref, onMounted } from 'vue'
import { useBankStore } from '@/stores/bank'
import { useSettingsStore } from '@/stores/settings'
import { createBank, defaultRule, exportBackup, exportBankFile, saveBank } from '@/services/bank'
import { loadBank } from '@/services/bank'
import * as storage from '@/services/storage'
import type { BankData, BankRule } from '@/types'
import { fmtTime, typeLabel } from '@/utils/format'

const bankStore = useBankStore()
const settingsStore = useSettingsStore()
const s = settingsStore.settings
const isMobile = ref(window.innerWidth <= 768)

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

function onExportBackup(): void {
  exportBackup()
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
    storage.importBackup(json)
    ElMessage.success('备份导入成功，即将刷新页面')
    window.setTimeout(() => window.location.reload(), 800)
  } catch {
    ElMessage.error('文件解析失败，请确认是合法的 JSON 文件')
  } finally {
    importing.value = false
  }
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
  storage.clearAll()
  ElMessage.success('缓存已清理，即将刷新页面')
  window.setTimeout(() => window.location.reload(), 800)
}

function onResize(): void {
  isMobile.value = window.innerWidth <= 768
}

onMounted(async () => {
  window.addEventListener('resize', onResize)
})
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

    <!-- 清理缓存 -->
    <el-card class="page-card" shadow="never">
      <div class="card-title"><span class="title-text">清理缓存</span></div>
      <div style="display: flex; gap: 10px; flex-wrap: wrap; margin-top: 12px">
        <el-button type="danger" @click="onClearCache">清理缓存</el-button>
      </div>
      <el-alert type="warning" :closable="false" show-icon style="margin-top: 12px">
        将清空本浏览器 localStorage 中保存的全部应用数据（题库编辑与本地新增题库、错题本、收藏夹、做题记录、未完成会话与所有设置），清理后自动刷新页面，且不可恢复。
      </el-alert>
    </el-card>
  </div>
</template>
