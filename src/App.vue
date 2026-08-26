<script setup lang="ts">
import { computed, onMounted, watch } from 'vue'
import { useRoute } from 'vue-router'
import zhCn from 'element-plus/es/locale/lang/zh-cn'
import AppNav from '@/components/AppNav.vue'
import { useBankStore } from '@/stores/bankStore'
import { useSettingsStore } from '@/stores/settings'
import { useUserDataStore } from '@/stores/userData'

const route = useRoute()
const settingsStore = useSettingsStore()
const bankStore = useBankStore()
const userStore = useUserDataStore()

// 做题页全屏沉浸：隐藏全局导航（做题页自带顶部栏）
const immersive = computed(() => route.path.startsWith('/quiz/'))

onMounted(async () => {
  settingsStore.apply()
  await bankStore.init()
})

// 当前题库切换后加载对应的错题/收藏/记录
watch(
  () => bankStore.currentId,
  (id) => {
    if (id) userStore.load(id)
  },
  { immediate: true }
)
</script>

<template>
  <el-config-provider :locale="zhCn">
    <AppNav v-if="!immersive" />
    <main class="app-main" :class="{ immersive }">
      <router-view />
    </main>
  </el-config-provider>
</template>
