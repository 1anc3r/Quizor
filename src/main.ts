import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import router from './router'

// Element Plus 组件样式由 unplugin 按需注入；这里额外引入深色模式 CSS 变量
import 'element-plus/theme-chalk/dark/css-vars.css'
// KaTeX 公式渲染样式（Fluent Editor 的 formula 模块依赖 window.katex，在编辑器组件内注入）
import 'katex/dist/katex.min.css'
import './styles/index.css'

const app = createApp(App)
app.use(createPinia())
app.use(router)
app.mount('#app')
