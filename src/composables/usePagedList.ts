import { computed, ref, toValue, watch, type ComputedRef, type MaybeRefOrGetter, type Ref } from 'vue'

/** 默认每页条数 */
export const DEFAULT_PAGE_SIZE = 20

/** el-pagination 的每页条数候选，全站统一 */
export const PAGE_SIZES = [DEFAULT_PAGE_SIZE, 50, 100]

/** el-pagination 的布局，全站统一 */
export const PAGINATION_LAYOUT = 'total, sizes, prev, pager, next, jumper'

/** 总条数 → 总页数（至少 1 页：空列表也停在第一页，而不是第 0 页） */
export function pageCount(total: number, pageSize: number): number {
  return Math.max(1, Math.ceil(total / pageSize))
}

/** 把页码收进有效区间（过滤后条数变少、或删掉最后一页的条目时用） */
export function clampPage(page: number, total: number, pageSize: number): number {
  return Math.min(Math.max(1, page), pageCount(total, pageSize))
}

/** 按页码取切片 */
export function pageSlice<T>(list: readonly T[], page: number, pageSize: number): T[] {
  const start = (page - 1) * pageSize
  return list.slice(start, start + pageSize)
}

export interface PagedList<T> {
  /** 当前页（从 1 开始） */
  currentPage: Ref<number>
  pageSize: Ref<number>
  total: ComputedRef<number>
  /** 当前页的数据，直接绑给 el-table 的 `:data` */
  pagedRows: ComputedRef<T[]>
  /** 回到第一页：过滤条件变化时调用 */
  resetPage: () => void
}

/**
 * 列表分页状态：页码、每页条数、当前页切片与两条必要的修正规则。
 *
 * 各页面此前各自复制了 `pageSize`/`currentPage` 两个 ref、一段 slice 计算，
 * 以及"每页条数变化重置页码"和"条数变少修正页码"两个 watch。复制出来的版本并不一致：
 * 有的在数据任何变化时都跳回第 1 页（在第 3 页删掉一条就被弹回开头），有的则会把页码
 * 收进有效区间。这里统一成后者 —— 页码只在越界时收拢，换过滤条件由调用方显式
 * `resetPage()`，行为可预期。
 *
 * 注意：返回的是 ref，模板里要用 `v-model:current-page="currentPage"` 就必须**解构**使用
 * （`const { currentPage } = usePagedList(rows)`）；写成 `paging.currentPage` 会让 v-model
 * 去改 ref 对象的属性而不是 `.value`，分页会失效。
 *
 * @param source 全量数据（ref / computed / getter 均可）
 * @param pageSize 初始每页条数，默认 20
 */
export function usePagedList<T>(
  source: MaybeRefOrGetter<T[]>,
  pageSize: number = DEFAULT_PAGE_SIZE
): PagedList<T> {
  const currentPage = ref(1)
  const size = ref(pageSize)
  const total = computed(() => toValue(source).length)

  const pagedRows = computed(() => pageSlice(toValue(source), currentPage.value, size.value))

  function resetPage(): void {
    currentPage.value = 1
  }

  // 每页条数变了，原页码几乎必然指向别的位置，直接回到第 1 页
  watch(size, resetPage)

  // 数据变少（删除条目、过滤出更少结果）时收拢页码，避免停在空白页
  watch(total, () => {
    currentPage.value = clampPage(currentPage.value, total.value, size.value)
  })

  return { currentPage, pageSize: size, total, pagedRows, resetPage }
}
