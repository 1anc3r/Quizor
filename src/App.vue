<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, watch } from 'vue'
import { useRoute } from 'vue-router'
import zhCn from 'element-plus/es/locale/lang/zh-cn'
import AppNav from '@/components/AppNav.vue'
import { useBankStore } from '@/stores/bankStore'
import { useSettingsStore } from '@/stores/settings'
import { useUserDataStore } from '@/stores/userData'
import { EVENT_STORAGE_FULL } from '@/services/storage'

const route = useRoute()
const settingsStore = useSettingsStore()
const bankStore = useBankStore()
const userStore = useUserDataStore()

// 做题页全屏沉浸：隐藏全局导航（做题页自带顶部栏）
const immersive = computed(() => route.path.startsWith('/quiz/'))

/** localStorage 写入被拒时提示用户一次（30s 内不重复打扰），避免误以为数据已保存 */
let storageFullNotified = false
function onStorageFull(): void {
  if (storageFullNotified) return
  storageFullNotified = true
  window.setTimeout(() => (storageFullNotified = false), 30_000)
  ElMessage.warning({
    message: '本地存储空间不足，本次改动未能保存。请在「设置 → 存储占用」查看占用并清理数据，或先导出备份。',
    duration: 6000,
    showClose: true
  })
}

onMounted(async () => {
  window.addEventListener(EVENT_STORAGE_FULL, onStorageFull)
  settingsStore.apply()
  await bankStore.init()
})

onBeforeUnmount(() => {
  window.removeEventListener(EVENT_STORAGE_FULL, onStorageFull)
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
