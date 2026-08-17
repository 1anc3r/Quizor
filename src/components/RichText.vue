<script setup lang="ts">
/**
 * 富文本渲染：支持 HTML（图文并排）、纯文本（自动换行）、LaTeX 公式。
 * Fluent Editor 插入的公式以 <span class="ql-formula" data-value="..."> 存储，
 * 渲染时用 KaTeX 就地排版。
 */
import { nextTick, onMounted, ref, watch } from 'vue'
import katex from 'katex'

const props = defineProps<{ content: string }>()

const el = ref<HTMLElement>()

function isHtml(s: string): boolean {
  return /<\w+[^>]*>/.test(s)
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

async function render(): Promise<void> {
  await nextTick()
  const root = el.value
  if (!root) return
  const content = props.content ?? ''
  root.innerHTML = isHtml(content) ? content : escapeHtml(content).replace(/\n/g, '<br>')
  root.querySelectorAll('span.ql-formula').forEach((node) => {
    const value = node.getAttribute('data-value') ?? ''
    try {
      katex.render(value, node as HTMLElement, { throwOnError: false })
    } catch {
      node.textContent = value
    }
  })
}

watch(() => props.content, render)
onMounted(render)
</script>

<template>
  <div ref="el" class="rich-text"></div>
</template>
