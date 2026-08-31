/**
 * 路由：必须使用 createWebHashHistory，避免 GitHub Pages 刷新 404。
 * 做题设置页、做题页、题目管理页等共用 View，通过会话 mode 或路由参数渲染差异。
 */
import { createRouter, createWebHashHistory } from 'vue-router'
import HomeView from '@/views/HomeView.vue'
import RecordsView from '@/views/RecordsView.vue'
import SettingsView from '@/views/SettingsView.vue'
import BankManageView from '@/views/BankManageView.vue'
import QuizSetupView from '@/views/QuizSetupView.vue'
import QuizView from '@/views/QuizView.vue'
import ResultView from '@/views/ResultView.vue'
import WrongBookView from '@/views/WrongBookView.vue'
import FavoriteView from '@/views/FavoriteView.vue'

// 必须使用 hash 模式：GitHub Pages 为纯静态托管，history 模式刷新会 404
const router = createRouter({
  history: createWebHashHistory(import.meta.env.BASE_URL),
  routes: [
    { path: '/', name: 'home', component: () => HomeView, meta: { title: '首页' } },
    { path: '/records', name: 'records', component: () => RecordsView, meta: { title: '记录' } },
    { path: '/settings', name: 'settings', component: () => SettingsView, meta: { title: '设置' } },
    { path: '/bank/manage/:id?', name: 'bankManage', component: () => BankManageView, meta: { title: '题库管理' } },
    { path: '/setup/:mode', name: 'quizSetup', component: () => QuizSetupView, meta: { title: '做题设置' } },
    { path: '/quiz/:sessionId', name: 'quiz', component: () => QuizView, meta: { title: '做题' } },
    { path: '/result/:bankId/:recordId', name: 'result', component: () => ResultView, meta: { title: '结算' } },
    { path: '/wrong', name: 'wrong', component: () => WrongBookView, meta: { title: '错题本' } },
    { path: '/favorite', name: 'favorite', component: () => FavoriteView, meta: { title: '收藏夹' } },
    { path: '/:pathMatch(.*)*', redirect: '/' }
  ]
})

router.afterEach((to) => {
  document.title = to.meta.title ? `Quizor · ${String(to.meta.title)}` : 'Quizor · 做题家'
})

export default router
