import { createWebHashHistory, createRouter } from 'vue-router';

import { useUserStore } from '@/store/index';

const Login = () => import('@/views/login/index.vue');
const Browser = () => import('@/views/browser/index.vue');
const Setting = () => import('@/views/setting/index.vue');
const BrowserKernel = () => import('@/views/browserKernel/index.vue');
const Group = () => import('@/views/group/index.vue');
const Email = () => import('@/views/email/index.vue');
const Billing = () => import('@/views/billing/index.vue');

const routes = [
  { path: '/login', name: 'login', component: Login, meta: { title: '登录' } },
  { path: '/', name: 'browser', component: Browser, meta: { requireAuth: true, title: '浏览器' } },
  {
    path: '/setting',
    name: 'setting',
    component: Setting,
    meta: { requireAuth: true, title: '设置' },
  },
  {
    path: '/browser-kernel',
    name: 'browser-kernel',
    component: BrowserKernel,
    meta: { requireAuth: true, title: '内核管理' },
  },
  {
    path: '/group',
    name: 'group',
    component: Group,
    meta: { requireAuth: true, title: '分组管理' },
  },
  {
    path: '/email',
    name: 'email',
    component: Email,
    meta: { requireAuth: true, title: '账号管理' },
  },
  {
    path: '/billing',
    name: 'billing',
    component: Billing,
    meta: { requireAuth: true, title: '余额与账单' },
  },
  { path: '/:pathMatch(.*)*', redirect: '/' },
];

const router = createRouter({
  history: createWebHashHistory(),
  routes,
});

router.beforeEach(to => {
  const userStore = useUserStore();
  if (to.meta.requireAuth && !userStore.isLoggedIn) {
    return { name: 'login', query: { redirect: to.fullPath } };
  }
  if (to.name === 'login' && userStore.isLoggedIn) {
    return { name: 'browser' };
  }
  return true;
});

router.afterEach(to => {
  document.title = to.meta.title ? `${to.meta.title} · 指纹浏览器` : '指纹浏览器';
});

export default router;
