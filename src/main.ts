import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import router from './router'
import { gcSessions } from './stores/session'
import { migrateBankDataToIdb } from './services/bankService'
import { idbAvailable } from './services/idb'

// Element Plus 组件样式由 unplugin 按需注入；这里额外引入深色模式 CSS 变量
import 'element-plus/theme-chalk/dark/css-vars.css'
// KaTeX 公式渲染样式（Fluent Editor 的 formula 模块依赖 window.katex，在编辑器组件内注入）
import 'katex/dist/katex.min.css'
import './styles/index.css'

// 启动时回收无主/超龄的答题会话，避免废弃草稿长期占用 localStorage
try {
  const reclaimed = gcSessions()
  if (reclaimed > 0) console.info(`[quizor] 已回收 ${reclaimed} 个废弃答题会话`)
} catch (e) {
  console.warn('[quizor] 会话垃圾回收失败：', e)
}

async function bootstrap(): Promise<void> {
  // 先把 localStorage 里的大题库存档搬进 IndexedDB。
  // 必须在挂载（也就是用户能触发保存）之前完成：否则迁移的"读旧值 → 写 IDB"
  // 可能盖掉期间发生的一次保存。迁移本身幂等且有校验，失败只会退回 localStorage。
  // 没有任何待迁移项时（绝大多数启动）只遍历一次 localStorage 就返回，
  // 不会打开 IDB，因此这一步基本不占启动时间。
  try {
    const moved = await migrateBankDataToIdb()
    if (moved > 0) console.info(`[quizor] 已把 ${moved} 个题库存档迁移到 IndexedDB`)
  } catch (e) {
    console.warn('[quizor] 题库存档迁移失败，继续使用 localStorage：', e)
  }

  const app = createApp(App)
  app.use(createPinia())
  app.use(router)
  app.mount('#app')

  // IDB 可用性探测只为诊断提示，原先放在挂载前会白等一次 IDB 开关 + 三次读写。
  // 它不影响任何读写路径（写入失败会自动回退 localStorage），因此挪到挂载之后，
  // 让首屏渲染不再等它。
  void idbAvailable().then((ok) => {
    if (!ok) console.warn('[quizor] IndexedDB 不可用，题库存档将退回 localStorage：大题库可能无法保存')
  })
}

void bootstrap()
