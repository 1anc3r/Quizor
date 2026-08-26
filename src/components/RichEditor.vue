<script setup lang="ts">
/**
 * Fluent Editor 富文本编辑器封装：
 * - 支持富文本排版、图文并排（Base64 内嵌 + 外链 URL 混合）、LaTeX 公式；
 * - 图片超过 500KB 时提示"图片较大，建议使用外链以减小牌组体积"，不强制阻止；
 * - formula 模块依赖 window.katex，在组件加载时注入。
 */
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import FluentEditor from '@opentiny/fluent-editor'
import '@opentiny/fluent-editor/style.css'
import katex from 'katex'

  // Fluent Editor 的 formula 模块从 window.katex 读取渲染器
  ; (window as unknown as { katex: typeof katex }).katex = katex

const props = withDefaults(defineProps<{ modelValue: string; placeholder?: string }>(), {
  placeholder: '请输入内容'
})
const emit = defineEmits<{ (e: 'update:modelValue', v: string): void }>()

const IMAGE_WARN_BYTES = 500 * 1024 // 500KB

const host = ref<HTMLElement>()
let editor: InstanceType<typeof FluentEditor> | null = null
let internalChange = false
/** 已提示过的 base64 图片（按 src 前缀 + 长度去重，避免重复弹窗） */
const warnedImages = new Set<string>()

function warnLargeImage(): void {
  ElMessage.warning('图片较大，建议使用外链以减小牌组体积')
}

/** 自定义图片上传 handler：读取本地文件并以内嵌 Base64 插入，超限仅提示不阻止 */
function pickImage(): void {
  if (!editor) return
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = 'image/*'
  input.onchange = () => {
    const file = input.files?.[0]
    if (!file || !editor) return
    if (file.size > IMAGE_WARN_BYTES) warnLargeImage()
    const reader = new FileReader()
    reader.onload = () => {
      if (!editor) return
      const range = editor.getSelection(true)
      editor.insertEmbed(range.index, 'image', reader.result as string, 'user')
      editor.setSelection(range.index + 1, 0, 'user')
    }
    reader.readAsDataURL(file)
  }
  input.click()
}

/** 粘贴 / 拖拽进来的 base64 图片：扫描编辑器内容，对超过 500KB 的提示一次 */
function checkPastedImages(): void {
  if (!editor) return
  editor.root.querySelectorAll('img[src^="data:"]').forEach((img) => {
    const src = img.getAttribute('src') ?? ''
    // base64 体积 ≈ 原始字节 × 4/3
    const approxBytes = Math.floor((src.length * 3) / 4)
    if (approxBytes > IMAGE_WARN_BYTES) {
      const key = `${src.slice(0, 64)}:${src.length}`
      if (!warnedImages.has(key)) {
        warnedImages.add(key)
        warnLargeImage()
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
        container: [
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
  editor = null
  if (host.value) host.value.innerHTML = ''
})
</script>

<template>
  <div class="rich-editor">
    <div ref="host"></div>
  </div>
</template>
