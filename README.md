# Quizor · 做题家

纯静态题库刷题 Web 应用：无后端、无登录。题库以 JSON 静态文件承载，用户数据（答题记录、错题、收藏、设置）全部保存在浏览器 `localStorage`，构建产物可直接发布 GitHub Pages。

## 技术栈

- Vue 3（Composition API + `<script setup>`）+ TypeScript + Vite
- Pinia（状态管理）+ Vue Router（`createWebHashHistory`，避免 GitHub Pages 刷新 404）
- Element Plus（unplugin 按需引入）+ ECharts（仅记录页动态导入、按需注册）
- Lucide 图标（`@lucide/vue`，逐图标具名导入，Tree-shaking 只打进用到的图标）
- Fluent Editor（富文本题干/解析，支持图文并排与 LaTeX 公式）+ KaTeX
- pinyin-pro（题库名称自动转拼音 ID；**动态 import**，字典约 300KB，只在新建/导入题库时下载）
- 构建期插件：`vite-plugins/bankIndex.ts`（生成题库索引）、`vite-plugins/katexFonts.ts`（KaTeX 字体只留 woff2）

### 图标约定

全部图标来自 `@lucide/vue`，按需具名导入（`import { Plus, Search } from '@lucide/vue'`），不使用自动导入：

- 作为 `el-button` / `el-input` 的 `:icon` 时直接传组件（`<el-button :icon="Plus" />`）。
- 需要与文字同一基线的行内图标，外包一层 `<el-icon :size="14">`；`.lucide` 在 `src/styles/index.css` 中被收敛为 `1em`，因此宽度跟随 `el-icon` 的 `font-size`。
- 需要精确像素尺寸时，给图标组件显式传 `:size`（会覆盖 CSS 的 `width`/`height`）。
- lucide 没有「实心」变体：实心态用 `fill` 表达，例如收藏按钮 `<Star :fill="isFaved ? 'currentColor' : 'none'" />`。

## 本地启动

需要 **Node.js 22.6 或以上**（构建脚本用 `node --experimental-strip-types` 直接运行 `.ts`，该选项自 Node 22.6 引入；Node 20 会报 `bad option: --experimental-strip-types` 并以 exit 9 退出）。

```bash
npm install
npm run dev
```

浏览器打开终端提示的地址（默认 <http://localhost:5173>）。

## 构建与类型检查

```bash
npm run build       # 生成题库索引 → vue-tsc 类型检查 → vite 构建，产物在 dist/
npm run build:index # 只重新生成题库索引（public/data/banks/*_index.json）
npm run preview     # 本地预览构建产物
```

`npm run dev` 会先生成一次索引再启动开发服务器，因此直接开发也不需要手动准备。

## 首屏数据分层（性能约定）

题库全文（880 题约 5MB，含题干/解析富文本与内嵌图片）**不再随首屏加载**。原因是 GitHub Pages 不对静态 JSON 做 gzip：实测全文 5,060KB 原样传输，在 10Mbps 下要 4 秒以上，这是首屏慢的主因。

改用两层结构：

| 层 | 文件 | 体积 | 何时加载 |
| --- | --- | --- | --- |
| 索引 | `data/banks/*_index.json`（构建期生成） | 303KB | 应用启动（首页列表、章节计数、统计都用它） |
| 全文 | `data/banks/*.json` | 5,060KB | 进入做题设置 / 答题页，或用户展开章节、聚焦搜索框 |

实测：首屏数据传输 **5,060KB → 303KB（-94%）**，按 10Mbps 估算从 4.1s 降到 0.25s；首屏总传输（含 JS/CSS）950KB。索引由 `vite-plugins/bankIndex.ts` 在构建期从题库 JSON 同源生成，`*_index.json` 已加入 `.gitignore`（产物不入库，避免与题库更新脱节）。

两条新增约定，改动相关代码时需要遵守：

- **索引字段必须保持 `id / type / chapter / difficulty / stem / source / tags`**，`HomeView` 的列表同时兼容索引摘要与全文题目（只取这些字段）。
- **需要题干/选项/答案的功能必须显式 `await bankStore.ensureFullBank()`**（`QuizSetupView` 组卷、`QuizView` 回填题干都已如此），否则会拿到只有摘要的索引数据。
- `vite-plugins/` 与 `scripts/` 里的文件也会被 `node --experimental-strip-types` 直接运行（Node 22.6+），从这类文件 import 项目源码时**必须写全 `.ts` 后缀**：Vite 会做后缀补全，Node 不会——只在 Vite 里跑通（`vite build`）不代表这套脚本能跑，务必单独执行一次 `npm run build:index` 验证。

## 部署到 GitHub Pages

`vite.config.ts` 中 `base: './'`（相对路径），配合 hash 路由，可直接部署到项目页子路径。

**方式一：GitHub Actions（推荐，已内置 `.github/workflows/static.yml`）**

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
3. 重新构建部署即可（`npm run build` 会自动为题库生成首屏索引）。

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
- **断点续答**：作答变更防抖 300ms 落盘 + `beforeunload` 强制落盘，刷新/关闭后可无损恢复。会话只落盘题号与分值（`StoredQuizSession`），题干/选项/解析在进入答题页时按 id 从题库回填，因此"练习全部"这类大会话也写得进 localStorage；代价是续答时题目内容以题库当前版本为准，题目若已从题库删除则该题从会话中移除。

## 目录结构

```
quizor/
├── .github/workflows/deploy.yml   # GitHub Pages 自动部署
├── public/
│   ├── data/
│   │   ├── BankManifest.json      # 题库清单（含组卷规则）
│   │   └── banks/                 # 各题库 JSON + 构建期生成的 *_index.json
│   └── favicon.svg
├── scripts/build-bank-index.mjs   # 生成题库索引（供 dev 与构建前调用）
├── vite-plugins/                  # 构建期插件：题库索引、KaTeX 字体瘦身
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
- 首屏只加载题库索引；题库全文（约 5MB）在进入做题/组卷或展开章节时才下载，因此首页会先看到章节计数与题目摘要，展开后才是完整题干。
- 会话不随题量增长：只存题号/分值，题干按 id 从题库回填，题库多大都不会撑爆 localStorage（历史版本留下的整题快照会在下次恢复时自动瘦身）。
- 多标签页同时答题时，最后落盘的会话覆盖前者（同一会话内防抖 + beforeunload 保证不丢）。
