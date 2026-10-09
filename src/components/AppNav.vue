<script setup lang="ts">
/**
 * 应用导航栏：桌面端固定顶部；移动端固定页面最下端（图标 + 文字标签栏）。
 * 5 个入口：首页、错题本、收藏夹、记录、设置。
 */
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import { CircleX, House, List, Settings, Star, Wrench } from '@lucide/vue'

const route = useRoute()

const items = [
  { path: '/', label: '首页', icon: House },
  { path: '/wrong', label: '错题本', icon: CircleX },
  { path: '/favorite', label: '收藏夹', icon: Star },
  { path: '/records', label: '记录', icon: List },
  { path: '/settings', label: '设置', icon: Settings },
]

const currentPath = computed(() => route.path)

function isActive(path: string): boolean {
  if (path === '/') 
    return (
      currentPath.value === '/' ||
      currentPath.value.startsWith('/bank') || 
      currentPath.value.startsWith('/setup') || 
      currentPath.value.startsWith('/result')
    )
  return currentPath.value.startsWith(path)
}
</script>

<template>
  <nav class="app-nav">
    <div class="brand"><em>Quizor</em><span>做题家</span></div>
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
