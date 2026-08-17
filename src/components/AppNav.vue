<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import { Document, HomeFilled, Notebook, Setting, Star } from '@element-plus/icons-vue'

const route = useRoute()

const items = [
  { path: '/', label: '首页', icon: HomeFilled },
  { path: '/wrong', label: '错题本', icon: Notebook },
  { path: '/favorite', label: '收藏夹', icon: Star },
  { path: '/records', label: '记录', icon: Document },
  { path: '/settings', label: '设置', icon: Setting }
]

const currentPath = computed(() => route.path)

function isActive(path: string): boolean {
  if (path === '/') return currentPath.value === '/' || currentPath.value.startsWith('/bank') || currentPath.value.startsWith('/setup') || currentPath.value.startsWith('/result')
  return currentPath.value.startsWith(path)
}
</script>

<template>
  <nav class="app-nav">
    <div class="brand">Quizor<span>做题家</span></div>
    <router-link
      v-for="item in items"
      :key="item.path"
      :to="item.path"
      class="nav-item"
      :class="{ active: isActive(item.path) }"
    >
      <el-icon :size="18"><component :is="item.icon" /></el-icon>
      <span>{{ item.label }}</span>
    </router-link>
  </nav>
</template>
