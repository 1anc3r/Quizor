<script setup lang="ts">
/**
 * Fluent Editor 富文本编辑器封装：
 * 支持富文本编辑、图片插入（图文并排）、LaTeX 公式（formula 模块依赖 window.katex）。
 */
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import FluentEditor from '@opentiny/fluent-editor'
import '@opentiny/fluent-editor/style.css'
import katex from 'katex'

// Fluent Editor 的 formula 模块从 window.katex 读取渲染器
;(window as unknown as { katex: typeof katex }).katex = katex

const props = withDefaults(defineProps<{ modelValue: string; placeholder?: string }>(), {
  placeholder: '请输入内容'
})
const emit = defineEmits<{ (e: 'update:modelValue', v: string): void }>()

const host = ref<HTMLElement>()
let editor: InstanceType<typeof FluentEditor> | null = null
let internalChange = false

onMounted(() => {
  if (!host.value) return
  editor = new FluentEditor(host.value, {
    theme: 'snow',
    placeholder: props.placeholder,
    modules: {
      toolbar: [
        ['bold', 'italic', 'underline', 'strike'],
        [{ color: [] }, { background: [] }],
        [{ align: [] }],
        [{ list: 'ordered' }, { list: 'bullet' }],
        ['image', 'formula'],
        ['clean']
      ]
    }
  })
  if (props.modelValue) editor!.root.innerHTML = props.modelValue
  editor!.on('text-change', () => {
    internalChange = true
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
