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

  async function loadCurrent(): Promise<void> {
    if (!currentId.value) {
      bank.value = null
      return
    }
    loading.value = true
    try {
      bank.value = await loadBank(currentId.value)
    } finally {
      loading.value = false
    }
  }

  async function switchBank(id: string): Promise<void> {
    if (id === currentId.value && bank.value) return
    currentId.value = id
    storage.writeJSON(K_CURRENT, id)
    await loadCurrent()
  }

  /** 题库被编辑/新增/删除后刷新清单与缓存 */
  async function afterBankEdited(id?: string): Promise<void> {
    manifest.value = (await loadManifest(true)).Banks
    if (id && id === currentId.value) {
      bank.value = await loadBank(id, true)
    }
    if (currentId.value && !manifest.value.some((b) => b.id === currentId.value)) {
      currentId.value = manifest.value[0]?.id ?? ''
      storage.writeJSON(K_CURRENT, currentId.value)
      bank.value = null
      if (currentId.value) await loadCurrent()
    }
  }

  async function deleteBank(id: string): Promise<void> {
    await svcDeleteBank(id)
    await afterBankEdited(id)
  }

  return { manifest, currentId, bank, meta, loading, chapters, sources, questionMap, init, loadCurrent, switchBank, afterBankEdited, removeBank: deleteBank }
})
