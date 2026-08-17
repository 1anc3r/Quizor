import { computed, ref, watch } from 'vue'
import { defineStore } from 'pinia'
import type { AppSettings, ExamConfig, FontSize, PracticeConfig, ThemeMode } from '@/types'
import * as storage from '@/services/storage'

const K_SETTINGS = 'settings'

function defaults(): AppSettings {
  return {
    theme: 'light',
    fontSize: 'standard',
    swipe: true,
    wrongThreshold: 3,
    practice: { scope: 'all', chapter: '', count: 10, types: ['single', 'multiple', 'judge', 'text'] },
    exam: { source: 'simulate', paperId: '' }
  }
}

export const useSettingsStore = defineStore('settings', () => {
  const settings = ref<AppSettings>({ ...defaults(), ...storage.get<Partial<AppSettings>>(K_SETTINGS, {}) })

  const theme = computed<ThemeMode>({
    get: () => settings.value.theme,
    set: (v) => (settings.value.theme = v)
  })
  const fontSize = computed<FontSize>({
    get: () => settings.value.fontSize,
    set: (v) => (settings.value.fontSize = v)
  })

  /** 应用外观（深色模式 + 题干/选项字号）到 DOM */
  function apply(): void {
    document.documentElement.classList.toggle('dark', settings.value.theme === 'dark')
    document.body.classList.remove('font-small', 'font-standard', 'font-large')
    document.body.classList.add(`font-${settings.value.fontSize}`)
  }

  watch(
    settings,
    () => {
      storage.set(K_SETTINGS, settings.value)
      apply()
    },
    { deep: true }
  )

  /** 记住上次练习模式设置 */
  function rememberPractice(cfg: PracticeConfig): void {
    settings.value.practice = JSON.parse(JSON.stringify(cfg)) as PracticeConfig
  }

  /** 记住上次考试模式设置 */
  function rememberExam(cfg: ExamConfig): void {
    settings.value.exam = JSON.parse(JSON.stringify(cfg)) as ExamConfig
  }

  function resetPractice(): void {
    settings.value.practice = defaults().practice
  }

  function resetExam(): void {
    settings.value.exam = defaults().exam
  }

  return { settings, theme, fontSize, apply, rememberPractice, rememberExam, resetPractice, resetExam }
})
