/**
 * 用户数据 store：错题本、收藏夹、做题记录。
 * 均按题库隔离存储（key 带 bankId），随当前题库切换而加载。
 */
import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type { FavoriteItem, QuizRecord, WrongItem } from '@/types'
import * as storage from '@/services/storage'
import { stemSummary } from '@/utils/text'

const K_WRONG = 'wrong:' // + bankId → Record<questionId, WrongItem>
const K_FAV = 'fav:' // + bankId → Record<questionId, FavoriteItem>
const K_RECORDS = 'records:' // + bankId → QuizRecord[]

/**
 * 历史记录瘦身：旧版本把完整富文本题干写进 details[].stem，这里一次性压缩为纯文本摘要。
 * stemSummary 对已够短的题干原样返回，因此可安全重复执行（幂等）。
 * @returns 是否有字段被改写（需要回写）
 */
function compactRecords(recs: QuizRecord[]): boolean {
  let changed = false
  for (const r of recs) {
    if (!r || !Array.isArray(r.details)) continue
    for (const d of r.details) {
      const slim = stemSummary(d.stem)
      if (slim !== d.stem) {
        d.stem = slim
        changed = true
      }
    }
  }
  return changed
}

export const useUserDataStore = defineStore('userData', () => {
  const bankId = ref('')
  const wrong = ref<Record<string, WrongItem>>({})
  const favorites = ref<Record<string, FavoriteItem>>({})
  const records = ref<QuizRecord[]>([])

  const wrongIds = computed(() => new Set(Object.keys(wrong.value)))
  const favoriteIds = computed(() => new Set(Object.keys(favorites.value)))

  /** 加载指定题库的用户数据（切换题库时调用） */
  function load(id: string): void {
    bankId.value = id
    wrong.value = id ? storage.readJSON(K_WRONG + id, {}) : {}
    favorites.value = id ? storage.readJSON(K_FAV + id, {}) : {}
    records.value = id ? storage.readJSON(K_RECORDS + id, []) : []
    // 压缩历史记录里的全量题干后立刻回写；写失败也不影响使用，下次加载会再试
    if (id && Array.isArray(records.value) && records.value.length && compactRecords(records.value)) {
      storage.writeJSON(K_RECORDS + id, records.value)
    }
  }

  /* ---------------- 错题本 ---------------- */

  /** 答错收录：同题更新（错误次数 +1、刷新时间与最近作答），不重复收录 */
  function addWrong(questionId: string, lastAnswer: string): void {
    const cur = wrong.value[questionId]
    wrong.value[questionId] = {
      questionId,
      count: (cur?.count ?? 0) + 1,
      lastTime: Date.now(),
      lastAnswer,
      streak: 0
    }
    storage.writeJSON(K_WRONG + bankId.value, wrong.value)
  }

  /**
   * 练习模式作答结果回流错题本：
   * 答对 → 若已在错题本则连续答对计数 +1，达到阈值自动移出；
   * 答错 → 收录/更新。
   */
  function practiceResult(questionId: string, correct: boolean, lastAnswer: string, threshold: number): void {
    if (correct) {
      const cur = wrong.value[questionId]
      if (cur) {
        const streak = cur.streak + 1
        if (streak >= threshold) {
          delete wrong.value[questionId]
        } else {
          wrong.value[questionId] = { ...cur, streak, lastTime: Date.now() }
        }
        storage.writeJSON(K_WRONG + bankId.value, wrong.value)
      }
    } else {
      addWrong(questionId, lastAnswer)
    }
  }

  function removeWrong(ids: string[]): void {
    ids.forEach((id) => delete wrong.value[id])
    storage.writeJSON(K_WRONG + bankId.value, wrong.value)
  }

  /* ---------------- 收藏夹 ---------------- */

  function toggleFavorite(questionId: string): boolean {
    if (favorites.value[questionId]) {
      delete favorites.value[questionId]
    } else {
      favorites.value[questionId] = { questionId, time: Date.now() }
    }
    storage.writeJSON(K_FAV + bankId.value, favorites.value)
    return !!favorites.value[questionId]
  }

  function removeFavorites(ids: string[]): void {
    ids.forEach((id) => delete favorites.value[id])
    storage.writeJSON(K_FAV + bankId.value, favorites.value)
  }

  /* ---------------- 做题记录 ---------------- */

  function addRecord(rec: QuizRecord): void {
    records.value.unshift(rec)
    storage.writeJSON(K_RECORDS + bankId.value, records.value)
  }

  function updateRecord(rec: QuizRecord): void {
    const i = records.value.findIndex((r) => r.id === rec.id)
    if (i >= 0) {
      records.value[i] = rec
      storage.writeJSON(K_RECORDS + bankId.value, records.value)
    }
  }

  function getRecord(id: string): QuizRecord | null {
    return records.value.find((r) => r.id === id) ?? null
  }

  return {
    bankId,
    wrong,
    favorites,
    records,
    wrongIds,
    favoriteIds,
    load,
    addWrong,
    practiceResult,
    removeWrong,
    toggleFavorite,
    removeFavorites,
    addRecord,
    updateRecord,
    getRecord
  }
})
