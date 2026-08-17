# Quizor · 做题家

纯静态题库刷题 Web 应用：无后端、无登录。题库以 JSON 静态文件承载，用户数据（答题记录、错题、收藏、设置）全部保存在浏览器 `localStorage`，构建产物可直接发布 GitHub Pages。

## 技术栈

- Vue 3（Composition API + `<script setup>`）+ TypeScript + Vite
- Pinia（状态管理）+ Vue Router（`createWebHashHistory`，避免 GitHub Pages 刷新 404）
- Element Plus（unplugin 按需引入）+ ECharts（仅记录页动态导入、按需注册）
- Fluent Editor（富文本题干/解析，支持图文并排与 LaTeX 公式）+ KaTeX
- pinyin-pro（题库名称自动转拼音 ID）

## 本地启动

```bash
npm install
npm run dev
```

浏览器打开终端提示的地址（默认 <http://localhost:5173>）。

## 构建与类型检查

```bash
npm run build      # vue-tsc 类型检查 + vite 构建，产物在 dist/
npm run preview    # 本地预览构建产物
```

## 部署到 GitHub Pages

`vite.config.ts` 中 `base: './'`（相对路径），配合 hash 路由，可直接部署到项目页子路径。

**方式一：GitHub Actions（推荐，已内置 `.github/workflows/deploy.yml`）**

1. 将本仓库推送到 GitHub；
2. 仓库 Settings → Pages → Source 选择 **GitHub Actions**；
3. 推送到 `main` 分支即可自动构建并发布。

**方式二：手动发布 dist**

```bash
npm run build
# 将 dist/ 目录推送到 gh-pages 分支（或任意静态托管）
npx gh-pages -d dist
```

## 新增题库（不改代码）

1. 将题库 JSON 放入 `public/data/banks/`（结构见下）；
2. 在 `public/data/BankManifest.json` 的 `Banks` 数组中登记 `id / name / bankFile / questionCount / rule`；
3. 重新构建部署即可。

也可以在应用内「首页 → 新增题库」创建，或「设置 → 导入题库 JSON」。浏览器内的编辑/新增保存在 localStorage 覆盖层，不影响静态文件本身。

## 数据结构

`public/data/BankManifest.json`：

```jsonc
{
  "Banks": [
    {
      "id": "kaoyan_guanzong",
      "name": "199_管理类综合能力",
      "bankFile": "Bank_Kaoyan_Guanzong.json",
      "questionCount": 57,
      "rule": {
        "durationMinutes": 120,
        "totalScore": 200,
        "passScore": 100,
        "composition": [
          { "chapter": "问题求解", "type": "single", "count": 15, "scoreEach": 3, "optionCount": 5 }
        ]
      }
    }
  ]
}
```

`public/data/banks/Bank_*.json`：

```jsonc
{
  "Questions": [
    {
      "id": "kaoyan_guanzong_000055",
      "type": "single",            // single 单选 / multiple 多选 / judge 判断 / text 简答
      "chapter": "逻辑推理",
      "difficulty": 2,             // 1-5
      "stem": "题干（纯文本或富文本 HTML，可含 LaTeX 公式节点）",
      "options": [{ "key": "A", "text": "……" }],
      "answer": ["E"],
      "analysis": "解析（纯文本或富文本 HTML）",
      "source": "2010年真题",
      "tags": ["逻辑推理"]
    }
  ],
  "Papers": [
    {
      "id": "paper_1785472444134",
      "name": "2010年199管理类综合能力考试",
      "source": "2010年真题",
      "difficulty": 4,
      "questionIds": ["有序引用题目id"]
    }
  ]
}
```

## 功能总览

- **首页**：题库切换/新增、统计卡片（答题量/正确率/错题数/收藏数）、断点续答「继续上次答题」、练习/考试入口、试卷与题目浏览（章节折叠）。
- **题库管理**：基本信息（名称自动转拼音 ID、时长、总分、及格线）、组卷规则、试卷管理窗口、题目管理窗口（Fluent Editor 富文本 + LaTeX 公式）。
- **练习模式**：范围（全部/按章节/仅错题/仅收藏）、题量（10/20/50/全部）、题型筛选；乱序抽题、即时反馈、答错自动入错题本。
- **考试模式**：模拟模式按组卷规则随机组卷（含倒计时，按"截止时间-当前时间"重算）、真题模式按试卷原始顺序出题；答题卡网格、标记、超时自动交卷、统一判分。
- **结算页**：分数/总分、正确率、错题数、逐题回顾、答题卡跳转；简答题自评。
- **错题本**：同题更新收录、筛选/排序、连续答对达到阈值自动移出（阈值可在设置修改）。
- **收藏夹**、**记录页**（含 ECharts 统计图）、**设置页**（深色模式、字号、滑动切题、导入导出）。
- **断点续答**：作答变更防抖 300ms 落盘 + `beforeunload` 强制落盘，刷新/关闭后可无损恢复。

## 目录结构

```
quizor/
├── .github/workflows/deploy.yml   # GitHub Pages 自动部署
├── public/
│   ├── data/
│   │   ├── BankManifest.json      # 题库清单（含组卷规则）
│   │   └── banks/                 # 各题库 JSON
│   └── favicon.svg
├── src/
│   ├── components/                # 导航/富文本/编辑器/选项/答题卡/题目详情/两个管理窗口
│   ├── router/                    # hash 路由
│   ├── services/                  # localStorage 封装、题库加载（覆盖层）、会话/判分、拼音
│   ├── stores/                    # Pinia：设置 / 题库 / 用户数据（错题·收藏·记录）
│   ├── styles/                    # 全局样式、主题变量、移动端适配
│   ├── types/                     # 全部 TypeScript 类型
│   ├── utils/                     # id / 格式化工具
│   ├── views/                     # 首页/题库管理/做题设置/做题/结算/错题/收藏/记录/设置
│   ├── App.vue / main.ts / env.d.ts
├── index.html / vite.config.ts / tsconfig*.json / package.json
```

## 说明与限制

- 浏览器内的题库编辑存储于 localStorage（容量约 5MB）；大量图片建议优先维护静态 JSON 文件，或定期「导出题库 JSON」归档。
- 多标签页同时答题时，最后落盘的会话覆盖前者（同一会话内防抖 + beforeunload 保证不丢）。
