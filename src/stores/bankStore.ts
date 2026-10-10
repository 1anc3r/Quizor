import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type { BankData, BankIndex, BankMeta } from '@/types'
import * as storage from '@/services/storage'
import { deleteBank as svcDeleteBank, loadBank, loadBankIndex, loadManifest } from '@/services/bankService'

const K_CURRENT = 'currentBank'

export const useBankStore = defineStore('bank', () => {
  const manifest = ref<BankMeta[]>([])
  const currentId = ref<string>(storage.readJSON<string>(K_CURRENT, ''))
  /**
   * 题库**索引**（摘要形态，约全文的 4%）：首页只依赖它，因此它是启动时唯一会拉取的题库数据。
   * 详见 services/bankService 的说明 —— GitHub Pages 不压缩静态 JSON，首屏拉全文就是 5MB。
   */
  const index = ref<BankIndex | null>(null)
  /**
   * 题库**全文**（含题干富文本、选项、答案解析、内嵌图片）：只有要答题/组卷/浏览详情时才加载。
   * 为 null 表示"还没加载"，与"题库为空"不同。
   */
  const bank = ref<BankData | null>(null)
  const indexLoading = ref(false)
  const loading = ref(false)

  const meta = computed<BankMeta | null>(() => manifest.value.find((b) => b.id === currentId.value) ?? null)

  /** 当前题库章节列表（索引里就有，无需全文） */
  const chapters = computed<string[]>(() => {
    const set = new Set<string>()
    index.value?.questions.forEach((q) => q.chapter && set.add(q.chapter))
    meta.value?.rule.composition.forEach((c) => c.chapter && set.add(c.chapter))
    return [...set]
  })

  /** 当前题库来源列表 */
  const sources = computed<string[]>(() => {
    const set = new Set<string>()
    index.value?.questions.forEach((q) => q.source && set.add(q.source))
    return [...set]
  })

  /** 题目总数（索引为准，比 manifest 里可能过期的 questionCount 可靠） */
  const questionCount = computed<number>(() => index.value?.questionCount ?? meta.value?.questionCount ?? 0)

  /** 全文是否已加载 */
  const hasFullBank = computed<boolean>(() => !!bank.value)

  const questionMap = computed<Map<string, import('@/types').Question>>(() => {
    const m = new Map()
    bank.value?.Questions.forEach((q) => m.set(q.id, q))
    return m
  })

  /**
   * 应用启动初始化：加载清单 → 选定当前题库 → **只加载索引**（首屏不做 5MB 下载）。
   *
   * 幂等且只跑一次：子路由的 onMounted 早于 App 的 onMounted，
   * 因此"设置页要组卷"这类场景必须能自己触发并等待初始化，而不是依赖 App。
   */
  let initPromise: Promise<void> | null = null
  function init(): Promise<void> {
    if (initPromise) return initPromise
    initPromise = (async () => {
      const m = await loadManifest()
      manifest.value = m.Banks
      if (!currentId.value || !m.Banks.some((b) => b.id === currentId.value)) {
        currentId.value = m.Banks[0]?.id ?? ''
      }
      if (!currentId.value) return
      if (!index.value) await loadCurrentIndex()
    })()
    return initPromise
  }

  /**
   * 加载当前题库的索引。失败不抛异常：失败时清空索引并提示，返回是否成功，
   * 避免调用方留下「指针指向新题库、数据还是旧题库」的错位状态。
   */
  async function loadCurrentIndex(): Promise<boolean> {
    if (!currentId.value) {
      index.value = null
      return true
    }
    indexLoading.value = true
    try {
      // 切换题库后旧的全文数据必须失效，否则会与新题库索引错位
      bank.value = null
      index.value = await loadBankIndex(currentId.value)
      if (!index.value) {
        ElMessage.error('题库索引加载失败')
        return false
      }
      return true
    } catch (e) {
      index.value = null
      ElMessage.error(e instanceof Error ? e.message : '题库索引加载失败')
      return false
    } finally {
      indexLoading.value = false
    }
  }

  /**
   * 按需加载当前题库全文（5MB 级）。
   * 首次调用真正走网络，之后命中内存缓存；并发调用共享同一次加载。
   * 会先确保初始化完成（设置页挂在 App 之前，不能假设清单已就绪）。
   */
  let fullBankPromise: Promise<boolean> | null = null
  async function ensureFullBank(): Promise<boolean> {
    if (bank.value) return true
    if (fullBankPromise) return fullBankPromise
    if (!manifest.value.length || !currentId.value) await init()
    if (!currentId.value) return false
    const id = currentId.value
    loading.value = true
    fullBankPromise = (async () => {
      try {
        bank.value = await loadBank(id, false, index.value)
        return true
      } catch (e) {
        bank.value = null
        ElMessage.error(e instanceof Error ? e.message : '题库加载失败')
        return false
      } finally {
        loading.value = false
        fullBankPromise = null
      }
    })()
    return fullBankPromise
  }

  /**
   * 切换题库：只换索引（首屏快速反馈），全文按需再加载。
   */
  async function switchBank(id: string): Promise<void> {
    if (id === currentId.value && index.value) return
    const prevId = currentId.value
    const prevIndex = index.value
    currentId.value = id
    storage.writeJSON(K_CURRENT, id)
    if (await loadCurrentIndex()) return
    // 加载失败：回滚到上一个题库，否则标题会是新题库、内容却是旧题库
    currentId.value = prevId
    index.value = prevIndex
    storage.writeJSON(K_CURRENT, prevId)
  }

  /** 题库被编辑/新增/删除后刷新清单与缓存 */
  async function afterBankEdited(id?: string): Promise<void> {
    manifest.value = (await loadManifest(true)).Banks

    // 当前题库已从清单中消失（典型场景：删除当前题库）时，必须先把指针挪走。
    // 否则下面的加载会抛「题库不存在」，善后逻辑永远不会执行，
    // 界面会停在 currentId 指向已删题库、meta 为 null 的坏状态。
    const currentGone = !!currentId.value && !manifest.value.some((b) => b.id === currentId.value)
    if (currentGone) {
      currentId.value = manifest.value[0]?.id ?? ''
      storage.writeJSON(K_CURRENT, currentId.value)
      bank.value = null
      index.value = null
      if (currentId.value) await loadCurrentIndex()
      return
    }

    // 题库仍然存在（编辑保存场景）：索引与全文都要重新加载，否则界面还显示旧内容
    if (id && id === currentId.value) {
      bank.value = await loadBank(id, true, null)
      index.value = await loadBankIndex(id, true)
    }
  }

  async function deleteBank(id: string): Promise<void> {
    await svcDeleteBank(id)
    await afterBankEdited(id)
  }

  return {
    manifest,
    currentId,
    index,
    bank,
    meta,
    loading,
    indexLoading,
    chapters,
    sources,
    questionCount,
    hasFullBank,
    questionMap,
    init,
    loadCurrentIndex,
    ensureFullBank,
    loadCurrent: ensureFullBank,
    switchBank,
    afterBankEdited,
    removeBank: deleteBank
  }
})
