/** @type {import('tailwindcss').Config} */
// Corporate Clean（企业简洁风）设计系统 —— 依据 STYLEKIT_STYLE_REFER.txt 的 Token 字典
export default {
  content: ['./index.html', './src/**/*.{vue,ts,tsx,js}'],
  theme: {
    extend: {
      colors: {
        // 主色：蓝色系（blue-600 / blue-700 传达专业感）
        primary: {
          50: '#eff6ff',
          100: '#dbeafe',
          500: '#3b82f6',
          600: '#2563eb',
          700: '#1d4ed8'
        }
      },
      borderRadius: {
        // 主要圆角：rounded-lg / rounded-xl
        lg: '0.5rem',
        xl: '0.75rem'
      },
      boxShadow: {
        // 卡片/按钮静止 shadow-sm；悬停 shadow-md
        sm: '0 1px 2px 0 rgb(0 0 0 / 0.05)',
        md: '0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1)'
      },
      transitionDuration: {
        // 动效永远不超过 200ms
        DEFAULT: '150ms',
        150: '150ms',
        200: '200ms'
      },
      fontFamily: {
        sans: [
          'system-ui',
          '-apple-system',
          'Segoe UI',
          'PingFang SC',
          'Hiragino Sans GB',
          'Microsoft YaHei',
          'sans-serif'
        ]
      }
    }
  },
  plugins: []
}
