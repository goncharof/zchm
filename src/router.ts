import { createRouter, createWebHashHistory } from 'vue-router'

export const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', component: () => import('./views/HomeView.vue') },
    { path: '/party', component: () => import('./views/PartyView.vue') },
    { path: '/shop', component: () => import('./views/ShopView.vue') },
    { path: '/map', component: () => import('./views/MapView.vue') },
    { path: '/location/:id', component: () => import('./views/LocationView.vue'), props: true },
    { path: '/combat', component: () => import('./views/CombatView.vue') },
    { path: '/bestiary', component: () => import('./views/BestiaryView.vue') },
    { path: '/spells', component: () => import('./views/SpellsView.vue') },
    { path: '/lore', component: () => import('./views/LoreView.vue') },
    { path: '/about', component: () => import('./views/AboutView.vue') },
  ],
  scrollBehavior: () => ({ top: 0 }),
})
