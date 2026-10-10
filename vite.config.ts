import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import AutoImport from 'unplugin-auto-import/vite'
import Components from 'unplugin-vue-components/vite'
import { ElementPlusResolver } from 'unplugin-vue-components/resolvers'
import { bankIndexPlugin } from './vite-plugins/bankIndex'
import { katexFontFormatPlugin } from './vite-plugins/katexFonts'

// base 使用相对路径 './'，使构建产物可直接部署到 GitHub Pages 的任意子路径（项目页）
export default defineConfig({
  base: './',
  plugins: [
    vue(),
    // 构建期生成题库索引（首屏只拉索引，全文按需加载），见 vite-plugins/bankIndex.ts
    bankIndexPlugin(),
    // KaTeX 字体只保留 woff2，避免产物里多出 1MB 冗余字体
    katexFontFormatPlugin(),
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
