import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type { BankData, BankMeta } from '@/types'
import * as storage from '@/services/storage'
import { deleteBank as svcDeleteBank, loadBank, loadManifest } from '@/services/bankService'

const K_CURRENT = 'currentBank'

export const useBankStore = defineStore('bank', () => {
  const manifest = ref<BankMeta[]>([])
  const currentId = ref<string>(storage.readJSON<string>(K_CURRENT, ''))
  const bank = ref<BankData | null>(null)
  const loading = ref(false)

  const meta = computed<BankMeta | null>(() => manifest.value.find((b) => b.id === currentId.value) ?? null)

  /** 当前题库章节列表（按出现顺序去重） */
  const chapters = computed<string[]>(() => {
    const set = new Set<string>()
    bank.value?.Questions.forEach((q) => q.chapter && set.add(q.chapter))
    meta.value?.rule.composition.forEach((c) => c.chapter && set.add(c.chapter))
    return [...set]
  })

  /** 当前题库来源列表 */
  const sources = computed<string[]>(() => {
    const set = new Set<string>()
    bank.value?.Questions.forEach((q) => q.source && set.add(q.source))
    return [...set]
  })

  const questionMap = computed<Map<string, import('@/types').Question>>(() => {
    const m = new Map()
    bank.value?.Questions.forEach((q) => m.set(q.id, q))
    return m
  })

  /** 应用启动初始化：加载清单 → 选定当前题库 → 懒加载题库数据 */
  async function init(): Promise<void> {
    const m = await loadManifest()
    manifest.value = m.Banks
    if (!currentId.value || !m.Banks.some((b) => b.id === currentId.value)) {
      currentId.value = m.Banks[0]?.id ?? ''
    }
    if (currentId.value) await loadCurrent()
  }

  /**
   * 加载当前题库。不抛异常：失败时清空 bank 并提示，返回是否成功，
   * 避免调用方留下「指针指向新题库、数据还是旧题库」的错位状态。
   */
  async function loadCurrent(): Promise<boolean> {
    if (!currentId.value) {
      bank.value = null
      return true
    }
    loading.value = true
    try {
      bank.value = await loadBank(currentId.value)
      return true
    } catch (e) {
      bank.value = null
      ElMessage.error(e instanceof Error ? e.message : '题库加载失败')
      return false
    } finally {
      loading.value = false
    }
  }

  async function switchBank(id: string): Promise<void> {
    if (id === currentId.value && bank.value) return
    const prev = currentId.value
    currentId.value = id
    storage.writeJSON(K_CURRENT, id)
    if (await loadCurrent()) return
    // 加载失败：回滚到上一个题库，否则标题会是新题库、内容却是旧题库
    currentId.value = prev
    storage.writeJSON(K_CURRENT, prev)
    if (prev) await loadCurrent()
  }

  /** 题库被编辑/新增/删除后刷新清单与缓存 */
  async function afterBankEdited(id?: string): Promise<void> {
    manifest.value = (await loadManifest(true)).Banks

    // 当前题库已从清单中消失（典型场景：删除当前题库）时，必须先把指针挪走。
    // 否则下面的 loadBank 会抛「题库不存在」，善后逻辑永远不会执行，
    // 界面会停在 currentId 指向已删题库、meta 为 null 的坏状态。
    const currentGone = !!currentId.value && !manifest.value.some((b) => b.id === currentId.value)
    if (currentGone) {
      currentId.value = manifest.value[0]?.id ?? ''
      storage.writeJSON(K_CURRENT, currentId.value)
      bank.value = null
      if (currentId.value) await loadCurrent()
      return
    }

    // 题库仍然存在（编辑保存场景）才跳过缓存重新加载
    if (id && id === currentId.value) {
      bank.value = await loadBank(id, true)
    }
  }

  async function deleteBank(id: string): Promise<void> {
    await svcDeleteBank(id)
    await afterBankEdited(id)
  }

  return { manifest, currentId, bank, meta, loading, chapters, sources, questionMap, init, loadCurrent, switchBank, afterBankEdited, removeBank: deleteBank }
})
