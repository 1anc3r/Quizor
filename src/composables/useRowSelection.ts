import { shallowRef, type ShallowRef } from 'vue'

export interface RowSelection<T> {
  /** 当前选中的行 */
  selection: ShallowRef<T[]>
  /** 直接绑 el-table 的 `@selection-change` */
  onSelectionChange: (rows: T[]) => void
  /** 批量操作完成后清空选中 */
  clearSelection: () => void
}

/**
 * el-table 的选中行状态。
 *
 * 每个表格此前都写着 `const xxxSelection = ref<T[]>([])`、
 * `@selection-change="(rows: T[]) => (xxxSelection = rows)"` 和一句 `xxxSelection.value = []`，
 * 内联箭头函数的参数类型还得跟着表格行类型抄一遍。这里收敛成一份。
 *
 * 用 `shallowRef` 而不是 `ref`：选中的是题库里的原始对象，深度响应式既没必要
 * （列表数据变化时 el-table 本来就会重新派发 selection-change），还会给每一行套一层 proxy。
 */
export function useRowSelection<T>(): RowSelection<T> {
  const selection = shallowRef<T[]>([])

  function onSelectionChange(rows: T[]): void {
    selection.value = rows
  }

  function clearSelection(): void {
    selection.value = []
  }

  return { selection, onSelectionChange, clearSelection }
}
