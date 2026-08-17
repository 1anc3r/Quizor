/** 题型：单选 / 多选 / 判断 / 简答 */
export type QuestionType = 'single' | 'multiple' | 'judge' | 'text'

export interface OptionItem {
  key: string
  text: string
}

export interface Question {
  id: string
  type: QuestionType
  chapter: string
  /** 难度 1-5 */
  difficulty: number
  /** 题干，支持富文本 HTML（Fluent Editor 产出，含 ql-formula 公式节点） */
  stem: string
  options: OptionItem[]
  /** 正确答案的选项 key 列表；简答题为空数组（参考答案写入 analysis） */
  answer: string[]
  /** 解析，富文本 HTML */
  analysis: string
  source: string
  tags: string[]
}

export interface Paper {
  id: string
  name: string
  source: string
  difficulty: number
  /** 有序引用题目 id */
  questionIds: string[]
}

/** 题库 JSON 文件结构（public/data/banks/*.json） */
export interface BankData {
  Questions: Question[]
  Papers: Paper[]
}

/** 组卷规则项 */
export interface ComposeItem {
  chapter: string
  type: QuestionType
  count: number
  scoreEach: number
  /** 单题选项数（创建题目时初始化选项用），简答题为 0 */
  optionCount?: number
}

export interface BankRule {
  durationMinutes: number
  totalScore: number
  passScore?: number
  composition: ComposeItem[]
}

/** BankManifest 中的题库条目 */
export interface BankMeta {
  id: string
  name: string
  bankFile: string
  questionCount: number
  rule: BankRule
  /** 是否为用户本地新增的题库（仅存于 localStorage） */
  local?: boolean
}

export interface BankManifest {
  Banks: BankMeta[]
}

/* ---------------- 答题会话 ---------------- */

export type QuizMode = 'practice' | 'exam'

export type PracticeScope = 'all' | 'chapter' | 'wrong' | 'favorite'

export interface PracticeConfig {
  scope: PracticeScope
  chapter: string
  /** 10 / 20 / 50 / 'all' */
  count: number | 'all'
  /** 空数组表示全部题型 */
  types: QuestionType[]
}

export type ExamSource = 'simulate' | 'paper'

export interface ExamConfig {
  source: ExamSource
  paperId: string
}

/** 会话内的题目快照（含本题分值），保证断点续答与会话期间数据一致 */
export interface SessionQuestion extends Question {
  score: number
}

export interface AnswerState {
  /** 选择题已选 key（已排序） */
  keys: string[]
  /** 简答题作答文本 */
  text: string
  /** 练习模式下该题是否已提交作答（即时反馈） */
  revealed: boolean
  /** 判分结果；null 表示未判分/待自评 */
  correct: boolean | null
}

export interface QuizSession {
  id: string
  bankId: string
  mode: QuizMode
  config: PracticeConfig | ExamConfig
  questions: SessionQuestion[]
  answers: Record<string, AnswerState>
  /** 已标记题目 id */
  marks: string[]
  currentIndex: number
  startTime: number
  /** 考试模式截止时间戳；练习模式为 null */
  endTime: number | null
  totalScore: number
  paperName?: string
  createdAt: number
  updatedAt: number
}

/* ---------------- 做题记录 ---------------- */

export interface RecordDetail {
  questionId: string
  chapter: string
  type: QuestionType
  stem: string
  difficulty: number
  yourAnswer: string
  rightAnswer: string
  /** true 答对 / false 答错 / null 未作答或待自评 */
  correct: boolean | null
  score: number
  gotScore: number
}

export interface QuizRecord {
  id: string
  bankId: string
  bankName: string
  mode: QuizMode
  paperName?: string
  /** 总题数 */
  total: number
  answered: number
  correct: number
  wrong: number
  /** 0-100 */
  accuracy: number
  score: number
  totalScore: number
  /** 用时（秒） */
  durationSec: number
  startTime: number
  endTime: number
  details: RecordDetail[]
}

/* ---------------- 错题本 / 收藏夹 ---------------- */

export interface WrongItem {
  questionId: string
  /** 累计错误次数 */
  count: number
  /** 最近一次错误时间戳 */
  lastTime: number
  /** 最近一次错误时的作答文本 */
  lastAnswer: string
  /** 练习模式连续答对次数（达到阈值自动移出） */
  streak: number
}

export interface FavoriteItem {
  questionId: string
  time: number
}

/* ---------------- 应用设置 ---------------- */

export type ThemeMode = 'light' | 'dark'
export type FontSize = 'small' | 'standard' | 'large'

export interface AppSettings {
  theme: ThemeMode
  fontSize: FontSize
  /** 滑动切题开关 */
  swipe: boolean
  /** 错题连续答对移出阈值 */
  wrongThreshold: number
  /** 记住的练习模式偏好 */
  practice: PracticeConfig
  /** 记住的考试模式偏好 */
  exam: ExamConfig
}
