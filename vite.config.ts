import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import AutoImport from 'unplugin-auto-import/vite'
import Components from 'unplugin-vue-components/vite'
import { ElementPlusResolver } from 'unplugin-vue-components/resolvers'

// base 使用相对路径 './'，使构建产物可直接部署到 GitHub Pages 的任意子路径（项目页）
export default defineConfig({
  base: './',
  plugins: [
    vue(),
    // Element Plus 按需引入：组件与 ElMessage/ElMessageBox 等 API 的样式由 resolver 自动注入
    AutoImport({
      resolvers: [ElementPlusResolver()],
      dts: false
    }),
    Components({
      resolvers: [ElementPlusResolver()],
      dts: false
    })
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url))
    }
  },
  server: {
    host: true,
    port: 5173
  },
  build: {
    chunkSizeWarningLimit: 2000
  }
})
