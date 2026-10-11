import { ref, type Ref } from 'vue'
import type { Question, QuestionType } from '@/types'
import { plainText } from '@/utils/format'

export interface QuestionFilters {
  /** 关键字（匹配题干纯文本、章节名，以及 extraKeywords 给出的字段） */
  keyword: Ref<string>
  chapter: Ref<string>
  type: Ref<'' | QuestionType>
  source: Ref<string>
  /** 单题是否通过全部筛选条件 */
  matches: (q: Question) => boolean
}

/**
 * 题目列表的筛选状态：关键字 + 章节 / 题型 / 来源。
 *
 * 错题本、收藏夹、题库管理的题目列表都各写了一份同样的四个 ref 和四行 `if (... ) continue`，
 * 但关键字比对的字段并不一致（题库管理还会比题号、来源、标签）。这里统一成一个
 * `matches(q)`，字段差异通过 `extraKeywords` 传入。
 *
 * @param extraKeywords 额外的关键字匹配字段（如在题库管理里要比对题号、来源、标签）
 */
export function useQuestionFilters(extraKeywords?: (q: Question) => string[]): QuestionFilters {
  const keyword = ref('')
  const chapter = ref('')
  const type = ref<'' | QuestionType>('')
  const source = ref('')

  function matches(q: Question): boolean {
    if (chapter.value && q.chapter !== chapter.value) return false
    if (type.value && q.type !== type.value) return false
    if (source.value && q.source !== source.value) return false

    const kw = keyword.value.trim().toLowerCase()
    if (!kw) return true
    if (plainText(q.stem).toLowerCase().includes(kw)) return true
    if (q.chapter.toLowerCase().includes(kw)) return true
    return !!extraKeywords?.(q).some((text) => text && text.toLowerCase().includes(kw))
  }

  return { keyword, chapter, type, source, matches }
}
