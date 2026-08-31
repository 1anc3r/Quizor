/**
 * 路由：必须使用 createWebHashHistory，避免 GitHub Pages 刷新 404。
 * 做题设置页、做题页、题目管理页等共用 View，通过会话 mode 或路由参数渲染差异。
 */
import { createRouter, createWebHashHistory } from 'vue-router'

// 必须使用 hash 模式：GitHub Pages 为纯静态托管，history 模式刷新会 404
const router = createRouter({
  history: createWebHashHistory(import.meta.env.BASE_URL),
  routes: [
    { path: '/', name: 'home', component: () => import('@/views/HomeView.vue'), meta: { title: '首页' } },
    { path: '/records', name: 'records', component: () => import('@/views/RecordsView.vue'), meta: { title: '记录' } },
    { path: '/settings', name: 'settings', component: () => import('@/views/SettingsView.vue'), meta: { title: '设置' } },
    { path: '/bank/manage/:id?', name: 'bankManage', component: () => import('@/views/BankManageView.vue'), meta: { title: '题库管理' } },
    { path: '/setup/:mode', name: 'quizSetup', component: () => import('@/views/QuizSetupView.vue'), meta: { title: '做题设置' } },
    { path: '/quiz/:sessionId', name: 'quiz', component: () => import('@/views/QuizView.vue'), meta: { title: '做题' } },
    { path: '/result/:bankId/:recordId', name: 'result', component: () => import('@/views/ResultView.vue'), meta: { title: '结算' } },
    { path: '/wrong', name: 'wrong', component: () => import('@/views/WrongBookView.vue'), meta: { title: '错题本' } },
    { path: '/favorite', name: 'favorite', component: () => import('@/views/FavoriteView.vue'), meta: { title: '收藏夹' } },
    { path: '/:pathMatch(.*)*', redirect: '/' }
  ]
})

router.afterEach((to) => {
  document.title = to.meta.title ? `Quizor · ${String(to.meta.title)}` : 'Quizor · 做题家'
})

export default router
