import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import { router } from './router'
// шрифты лежат в сборке (игра работает без сети): Inter — интерфейс, Monomakh — заголовки, Old Standard TT — Книга
import '@fontsource/inter/cyrillic-400.css'
import '@fontsource/inter/latin-400.css'
import '@fontsource/inter/cyrillic-500.css'
import '@fontsource/inter/latin-500.css'
import '@fontsource/inter/cyrillic-600.css'
import '@fontsource/inter/latin-600.css'
import '@fontsource/inter/cyrillic-700.css'
import '@fontsource/inter/latin-700.css'
import '@fontsource/monomakh/cyrillic-400.css'
import '@fontsource/monomakh/latin-400.css'
import '@fontsource/old-standard-tt/cyrillic-400.css'
import '@fontsource/old-standard-tt/latin-400.css'
import '@fontsource/old-standard-tt/cyrillic-400-italic.css'
import '@fontsource/old-standard-tt/cyrillic-700.css'
import './style.css'

createApp(App).use(createPinia()).use(router).mount('#app')

// офлайн-режим и установка на телефон (только в сборке)
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {})
}
