import { computed, reactive, ref } from 'vue'
import { defineStore } from 'pinia'
import type { BankData, BankIndex, BankMeta } from '@/types'
import * as storage from '@/services/storage'
import { deleteBank as svcDeleteBank, loadBank, loadBankIndex, loadManifest } from '@/services/bankService'
import type { BankLoadProgress } from '@/services/bankWorkerApi'

const K_CURRENT = 'currentBank'

/** 慢速网络不做后台预取：一次预取等于替用户花掉 6MB 流量却毫无即时收益 */
const SLOW_TYPES = new Set(['slow-2g', '2g', '3g'])

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

  /**
   * 全文加载进度（0-1 的总进度，下载 40% + 解析 30% + 规整 30%）。
   *
   * 由 `loadBank` 的 `onProgress` 回调驱动，供首页画真实进度条。
   * 用 `reactive` 而不是 `ref`：每 256KB 就可能更新一次，逐字段赋值能避免整对象替换带来的无谓重渲染。
   */
  const progress = reactive<BankLoadProgress>({ phase: 'download', ratio: 0, loaded: 0, total: 0 })

  /** 是否正在加载全文（按需 + 后台预取都算） */
  const fullLoading = computed<boolean>(() => loading.value)
  /** 进度条是否应该显示：只有真正在拉数据、并且还没走完时才显示 */
  const showProgress = computed<boolean>(() => loading.value && progress.ratio < 1)

  function resetProgress(): void {
    progress.phase = 'download'
    progress.ratio = 0
    progress.loaded = 0
    progress.total = 0
  }

  function applyProgress(p: BankLoadProgress): void {
    // 不做"只增不减"保护：重试时上游会把进度显式打回 0，
    // 压住回退反而会让进度条永久停在失败点。
    progress.phase = p.phase
    progress.ratio = p.ratio
    progress.loaded = p.loaded
    progress.total = p.total
  }

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
      // 首屏渲染完再默默预取全文：用户点「开始答题」时多半已经就绪，不必再等 5MB
      if (prefetchCancelled) prefetchCancelled = false
      schedulePrefetch()
    })()
    return initPromise
  }

  /**
   * 加载当前题库的索引。失败不抛异常：失败时清空索引并提示，返回是否成功，
   * 避免调用方留下「指针指向新题库、数据还是旧题库」的错位状态。
   *
   * 这里**不取消预取**：本方法在启动与切换题库时都会被调用，
   * 在启动路径上取消等于把后台预取彻底关掉；换题库时的取消由 `switchBank` 自己做。
   */
  async function loadCurrentIndex(): Promise<boolean> {
    resetProgress()
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
   *
   * `showError` 为 false 时静默失败（后台预取用：用户没主动要求，弹错只会干扰）。
   * 点击按钮会取消尚未开始的预取定时器，避免"点了按钮却要等预取先完成"。
   */
  let fullBankPromise: Promise<boolean> | null = null
  /**
   * 全文加载代次：`switchBank` 会把它 +1，使所有在飞的加载结果作废。
   *
   * 没有这道闸就会出现"换到 B 题库后，A 的全文姗姗来迟并写进 `bank`"：
   * 此刻 `currentId` 是 B、`bank` 是 A，而 `hasFullBank` 只判 `!!bank`，
   * 于是 B 的全文永远不会再加载，界面显示索引(B) + 详情(A) 的错位数据。后台预取会
   * 让这种在飞加载经常存在，所以必须防。
   */
  let bankGeneration = 0

  async function ensureFullBank(showError = true): Promise<boolean> {
    if (bank.value) return true
    // 先把取消标记复位再取消：主动加载是"用户/调用方明确要全文"的最高优先级请求，
    // 要顺带解掉换题库或上次取消留下的封锁，否则这里的取消反倒会把自己锁死。
    prefetchCancelled = false
    cancelIdlePrefetch()
    // 判空要放在取消之前：已有在飞的加载时若先取消，就会把预取自己发起的请求标记成已取消
    if (fullBankPromise) return fullBankPromise
    if (!manifest.value.length || !currentId.value) await init()
    if (!currentId.value) return false
    const id = currentId.value
    const gen = bankGeneration
    loading.value = true
    resetProgress()
    fullBankPromise = (async () => {
      try {
        const data = await loadBank(id, false, index.value, applyProgress)
        // 加载期间换过题库：结果属于旧题库，直接丢弃。
        // 不提示错误 —— 用户主动换的题库，报错只会让人以为新题库坏了。
        if (gen !== bankGeneration) return false
        bank.value = data
        return true
      } catch (e) {
        // 只有仍然是当前题库时才清空：否则会把新题库已经加载好的全文误清掉
        if (gen === bankGeneration) {
          bank.value = null
          if (showError) ElMessage.error(e instanceof Error ? e.message : '题库加载失败')
        }
        return false
      } finally {
        loading.value = false
        fullBankPromise = null
        // 作废的那次加载留下了"进度停在半途"的假象，重置掉；
        // 若新题库的加载正在跑，它会自己继续更新进度，这里不打断
        if (gen !== bankGeneration) resetProgress()
      }
    })()
    return fullBankPromise
  }

  /**
   * 后台空闲预取。
   *
   * 只在"确定不会白白浪费用户流量、也不会抢占首屏资源"时才启动：
   * - 关掉流量节省、且不是 2G/3G；
   * - 页面可见（后台标签页里预取意义不大，切回来时 `visibilitychange` 会再试一次）；
   * - 首屏空转后（`requestIdleCallback`）才真正发请求；
   * - 失败静默 —— 用户没要求过，弹错只会变成噪音，真正需要时按钮会再拉一次。
   */
  let prefetchTimer: number | null = null
  let prefetchHandle: number | null = null
  let prefetchCancelled = false

  function cancelIdlePrefetch(): void {
    prefetchCancelled = true
    if (prefetchTimer !== null) {
      clearTimeout(prefetchTimer)
      prefetchTimer = null
    }
    if (prefetchHandle !== null && typeof cancelIdleCallback === 'function') {
      cancelIdleCallback(prefetchHandle)
      prefetchHandle = null
    }
  }

  function prefetchAllowed(): boolean {
    const conn = navigator.connection
    if (conn?.saveData) return false
    if (conn?.effectiveType && SLOW_TYPES.has(conn.effectiveType)) return false
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return false
    return true
  }

  function schedulePrefetch(): void {
    if (prefetchCancelled || bank.value || prefetchTimer !== null || prefetchHandle !== null) return
    if (!prefetchAllowed()) return

    const start = (): void => {
      prefetchTimer = null
      prefetchHandle = null
      if (bank.value || prefetchCancelled || !prefetchAllowed()) return
      // showError=false：后台预取失败不打扰用户
      void ensureFullBank(false)
    }

    if (typeof requestIdleCallback === 'function') {
      // 句柄要留下来：只存 setTimeout 的话，idle 分支里 prefetchTimer 一直是 null，
      // 同一帧内再调一次 schedulePrefetch 就会排进第二个回调，把预取做两遍。
      prefetchHandle = requestIdleCallback(start, { timeout: 3000 })
    } else {
      // 1500ms 足够让首屏的索引渲染、图表、图片各就各位
      prefetchTimer = window.setTimeout(start, 1500)
    }
  }

  // 页面从后台切回来时补一次预取：既尊重了"后台不预取"，又不会永远错过这次机会
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && !bank.value) schedulePrefetch()
    })
  }

  /**
   * 切换题库：只换索引（首屏快速反馈），全文按需再加载。
   */
  async function switchBank(id: string): Promise<void> {
    if (id === currentId.value && index.value) return
    // 换题库 → 上一次的预取与进度都作废，否则进度条会把旧题库的字节数画到新题库头上
    bankGeneration++
    cancelIdlePrefetch()
    resetProgress()
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
      // 指针要挪走，在飞的全文加载也随之作废，否则旧题库的数据会写进新的 bank
      bankGeneration++
      cancelIdlePrefetch()
      resetProgress()
      currentId.value = manifest.value[0]?.id ?? ''
      storage.writeJSON(K_CURRENT, currentId.value)
      bank.value = null
      index.value = null
      if (currentId.value) await loadCurrentIndex()
      return
    }

    // 题库仍然存在（编辑保存场景）：索引与全文都要重新加载，否则界面还显示旧内容
    if (id && id === currentId.value) {
      // 直接改 bank 而不是走 ensureFullBank：后者见 bank 非空会立刻返回 true，
      // 于是编辑完保存后界面还显示旧内容。同时作废在飞的旧加载，避免它稍后覆盖回来。
      bankGeneration++
      bank.value = await loadBank(id, true, null)
      resetProgress()
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
    progress,
    showProgress,
    fullLoading,
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
