<script setup lang="ts">
/**
 * Fluent Editor 富文本编辑器封装：
 * - 支持富文本排版、图文并排（Base64 内嵌 + 外链 URL 混合）、LaTeX 公式；
 * - 内嵌图片统一走"压缩 → 限额"：等比缩到最长边 1280px 后按质量 0.82 重编码（优先 WebP）；
 *   压缩后仍超过 IMAGE_EMBED_MAX_BYTES，或格式无法内嵌（SVG），则弹出对话框引导改用外链图片；
 *   工具栏选图、粘贴、拖拽三条路径都走同一入口，避免大截图绕过限制；
 * - formula 模块依赖 window.katex，在组件加载时注入。
 */
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import FluentEditor from '@opentiny/fluent-editor'
import '@opentiny/fluent-editor/style.css'
import katex from 'katex'
import { IMAGE_EMBED_MAX_BYTES, dataUrlBytes, embedStorageBytes, isEmbeddableType, prepareImageFile } from '@/utils/image'
import { fmtBytes } from '@/utils/format'

  // Fluent Editor 的 formula 模块从 window.katex 读取渲染器
  ; (window as unknown as { katex: typeof katex }).katex = katex

const props = withDefaults(defineProps<{ modelValue: string; placeholder?: string; compact?: boolean }>(), {
  placeholder: '请输入内容',
  compact: false
})
const emit = defineEmits<{ (e: 'update:modelValue', v: string): void }>()

const host = ref<HTMLElement>()
let editor: InstanceType<typeof FluentEditor> | null = null
let internalChange = false
/** 已提示过的过大内嵌图片（按 src 前缀 + 长度去重，避免重复弹窗） */
const warnedImages = new Set<string>()

function warnOversizedImage(): void {
  ElMessage.warning(
    `检出超过 ${fmtBytes(IMAGE_EMBED_MAX_BYTES)} 的内嵌图片，建议改用外链图片以减小题库体积`
  )
}

/**
 * 外链插图：图片过大或格式无法内嵌（SVG）时的退路。
 * 题库支持外链图片（sanitizeHtml 允许 http(s)），既不占本地存储也不涨题库体积。
 */
async function promptExternalImage(reason: string): Promise<void> {
  const target = editor
  if (!target) return
  const index = Math.min(target.getSelection(true)?.index ?? target.getLength(), target.getLength())
  try {
    const { value } = await ElMessageBox.prompt(
      `${reason}可填入图片外链地址（http/https），或取消后先裁剪、缩小图片再试。`,
      '改用外链图片',
      {
        confirmButtonText: '插入外链图片',
        cancelButtonText: '取消',
        inputPlaceholder: 'https://example.com/diagram.png',
        inputValidator: (v: string) =>
          /^https?:\/\/\S+$/i.test(v.trim()) ? true : '请填写以 http:// 或 https:// 开头的图片地址'
      }
    )
    target.insertEmbed(index, 'image', String(value).trim(), 'user')
    target.setSelection(index + 1, 0, 'user')
  } catch {
    /* 用户取消：不插入任何内容 */
  }
}

/**
 * 统一的图片插入入口：先压缩再内嵌，超限或格式不支持则引导改用外链。
 * 内嵌图片会同时进入 bankdata（题库数据）与 session（答题快照），
 * 不压缩的话一张手机截图就能吃掉数 MB 配额。
 */
async function insertImageFile(file: File, at?: number): Promise<void> {
  const target = editor
  if (!target) return
  if (!file.type.startsWith('image/')) {
    ElMessage.warning('只能插入图片文件')
    return
  }
  if (!isEmbeddableType(file.type, file.name)) {
    await promptExternalImage('SVG 矢量图无法内嵌（渲染时会受安全策略拦截）。')
    return
  }
  // 先固定插入位置：压缩是异步的，完成后光标可能已经移动
  const index = Math.min(at ?? target.getSelection(true)?.index ?? target.getLength(), target.getLength())
  const loading = ElMessage({ message: '正在压缩图片…', duration: 0 })
  try {
    const result = await prepareImageFile(file)
    loading.close()
    if (result.tooLarge) {
      await promptExternalImage(
        `图片压缩后仍有 ${fmtBytes(result.bytes)}，超过内嵌上限 ${fmtBytes(IMAGE_EMBED_MAX_BYTES)}。`
      )
      return
    }
    target.insertEmbed(index, 'image', result.dataUrl, 'user')
    target.setSelection(index + 1, 0, 'user')
    // 只在压缩确实明显见效时提示，避免每次插图都弹窗
    if (result.bytes < result.rawBytes * 0.8) {
      ElMessage.success(
        `图片已压缩内嵌：${fmtBytes(result.rawBytes)} → ${fmtBytes(result.bytes)}，` +
          `约占本地存储 ${fmtBytes(embedStorageBytes(result.bytes))}`
      )
    }
  } catch (e) {
    loading.close()
    console.warn('[quizor] 图片处理失败：', e)
    ElMessage.error('图片处理失败，请换一张图片试试')
  }
}

/** 工具栏图片按钮：选本地文件 → 压缩 → 内嵌 */
function pickImage(): void {
  if (!editor) return
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = 'image/*'
  input.onchange = () => {
    const file = input.files?.[0]
    if (file) void insertImageFile(file)
  }
  input.click()
}

/** 从剪切板/拖拽数据里取第一张图片文件；带 HTML 内容时返回 null，交给编辑器原样处理 */
function extractImageFile(data: DataTransfer | null): File | null {
  if (!data) return null
  // 从网页复制图文时带 text/html：让编辑器保留外链与排版，不要转成内嵌 base64
  if (data.types.includes('text/html')) return null
  const item = Array.from(data.items ?? []).find((i) => i.kind === 'file' && i.type.startsWith('image/'))
  if (item) return item.getAsFile()
  return Array.from(data.files ?? []).find((f) => f.type.startsWith('image/')) ?? null
}

function interceptImageFile(e: Event, data: DataTransfer | null): void {
  const file = extractImageFile(data)
  if (!file) return
  e.preventDefault()
  e.stopPropagation()
  void insertImageFile(file)
}

function isInsideEditor(target: EventTarget | null): boolean {
  return !!editor && target instanceof Node && editor.root.contains(target)
}

/**
 * 在 document 的捕获阶段拦截：document 是传播路径的起点，必然早于 Quill 自己
 * 挂在编辑器上的监听，因此不依赖"谁先注册"；再用包含判断把作用范围限制在编辑区内，
 * 避免影响页面其它地方的粘贴。
 */
const onPaste = (e: ClipboardEvent): void => {
  if (isInsideEditor(e.target)) interceptImageFile(e, e.clipboardData)
}
const onDrop = (e: DragEvent): void => {
  if (isInsideEditor(e.target)) interceptImageFile(e, e.dataTransfer)
}

/** 兜底：扫描编辑器内容，对仍然超过上限的内嵌图片提示一次 */
function checkPastedImages(): void {
  if (!editor) return
  editor.root.querySelectorAll('img[src^="data:"]').forEach((img) => {
    const src = img.getAttribute('src') ?? ''
    if (dataUrlBytes(src) > IMAGE_EMBED_MAX_BYTES) {
      const key = `${src.slice(0, 64)}:${src.length}`
      if (!warnedImages.has(key)) {
        warnedImages.add(key)
        warnOversizedImage()
      }
    }
  })
}

onMounted(() => {
  if (!host.value) return
  editor = new FluentEditor(host.value, {
    theme: 'snow',
    placeholder: props.placeholder,
    modules: {
      toolbar: {
        // compact：精简工具栏（选项等轻量场景），只保留基础格式与公式，去掉图片/表格等重按钮
        container: props.compact
          ? [['bold', 'italic', 'underline', 'strike'], [{ script: 'sub' }, { script: 'super' }], ['formula'], ['clean']]
          : [
              ['undo', 'redo'],
              ['bold', 'italic', 'underline', 'strike'],
              [{ color: [] }, { background: [] }],
              [{ align: [] }],
              [{ list: 'ordered' }, { list: 'bullet' }],
              [{ indent: '-1' }, { indent: '+1' }],
              [{ script: 'sub' }, { script: 'super' }],
              ['formula', 'image', 'better-table'],
              ['clean']
            ],
        handlers: {
          image: pickImage
        }
      }
    }
  })
  if (props.modelValue) editor!.root.innerHTML = props.modelValue
  document.addEventListener('paste', onPaste, true)
  document.addEventListener('drop', onDrop, true)
  editor!.on('text-change', () => {
    internalChange = true
    checkPastedImages()
    emit('update:modelValue', editor!.root.innerHTML)
    void nextTick(() => {
      internalChange = false
    })
  })
})

// 外部（如切换编辑对象）重置内容时同步进编辑器；自身输入不回流，避免光标跳动
watch(
  () => props.modelValue,
  (v) => {
    if (internalChange || !editor) return
    if ((editor.root.innerHTML || '') !== (v || '')) {
      editor.root.innerHTML = v || ''
    }
  }
)

onBeforeUnmount(() => {
  document.removeEventListener('paste', onPaste, true)
  document.removeEventListener('drop', onDrop, true)
  editor = null
  if (host.value) host.value.innerHTML = ''
})
</script>

<template>
  <div class="rich-editor">
    <div ref="host"></div>
  </div>
</template>
