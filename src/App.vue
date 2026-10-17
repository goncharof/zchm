<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import {
  BookOpen, Castle, Dice5, Home, Info, Map as MapIcon, Menu, MessageCircle, MessagesSquare, ScrollText, Skull, Sparkles, Store, Swords, Users, X,
} from 'lucide-vue-next'
import DiceTray from '@/components/DiceTray.vue'
import GmChat from '@/components/GmChat.vue'
import { useGameStore } from '@/stores/game'
import { idx } from '@/data'
import { savedSession } from '@/net/client'
import { speak, speechPrefs, spokenIds } from '@/ui/speech'
import { classArt, pct } from '@/ui/format'

const store = useGameStore()
const route = useRoute()
const heroes = computed(() => store.heroes)
const inCombat = computed(() => !!store.combat)
const dice = ref(false)
const more = ref(false)
const refMenu = ref(false)
const chatOpen = ref(false)
const base = import.meta.env.BASE_URL

// возврат за стол после обновления страницы: пока не вошли — экран ожидания, а не чужое одиночное сохранение
const rejoining = ref(!!savedSession())
onMounted(async () => {
  await store.rejoin()
  rejoining.value = false
})

const locationLink = computed(() => (store.location ? `/location/${store.location.id}` : null))
const onTable = computed(() => route.path === '/table')
watch(() => route.fullPath, () => { more.value = false; refMenu.value = false })

// чат: непрочитанные — пришедшие после последнего просмотра (не свои и не служебные)
const seenCount = ref(0)
const myName = computed(() => store.room?.me.name ?? '')
const unread = computed(() => store.chat.slice(seenCount.value).filter((m) => m.from !== 'system' && !(m.from === 'player' && m.author.startsWith(myName.value))).length)
watch([() => store.chat.length, chatOpen, onTable], () => { if (chatOpen.value || onTable.value) seenCount.value = store.chat.length }, { immediate: true })
watch(() => store.chat, (list, old) => { if (list !== old) seenCount.value = chatOpen.value || onTable.value ? list.length : Math.min(seenCount.value, list.length) })
watch(() => store.online, (on) => { if (!on) chatOpen.value = false })

// озвучка новых реплик ведущего на любом экране; история чата (вход в комнату) не читается
let seenList: unknown = null
watch(() => [store.chat, store.chat.length] as const, ([list]) => {
  const history = list !== seenList
  seenList = list
  for (const m of list) {
    if (spokenIds.has(m.id)) continue
    spokenIds.add(m.id)
    if (!history && m.from === 'gm' && speechPrefs.value.on) speak(m.text)
  }
}, { immediate: true })

const reference = [
  { to: '/bestiary', label: 'Бестиарий', icon: Skull },
  { to: '/spells', label: 'Заклинания', icon: Sparkles },
  { to: '/rules', label: 'Правила', icon: ScrollText },
  { to: '/lore', label: 'Предыстория', icon: BookOpen },
  { to: '/about', label: 'Об игре', icon: Info },
]
const refActive = computed(() => reference.some((r) => route.path.startsWith(r.to)))
const onlineCount = computed(() => store.room?.players.filter((p) => p.online).length ?? 0)
</script>

<template>
  <header class="topbar">
    <div class="topbar-inner">
      <router-link class="brand" to="/" title="Заклятье Чёрного мага — на главную">
        <img :src="`${base}img/brand/logo-sm.png`" alt="Заклятье Чёрного мага" width="520" height="90" />
      </router-link>
      <nav class="nav-desktop" aria-label="Разделы">
        <router-link v-if="store.online" to="/table" class="nav-link hot-online"><MessagesSquare :size="17" /><span>Стол</span><span v-if="store.room?.gm === 'ai' && store.room?.gmBusy"> ✎</span></router-link>
        <router-link to="/party" class="nav-link"><Users :size="17" /><span>Партия</span></router-link>
        <router-link to="/map" class="nav-link"><MapIcon :size="17" /><span>Карта</span></router-link>
        <router-link v-if="locationLink" :to="locationLink" class="nav-link"><Castle :size="17" /><span class="lbl">{{ store.location?.name }}</span></router-link>
        <router-link v-if="inCombat" to="/combat" class="nav-link hot"><Swords :size="17" /><span>Бой</span></router-link>
        <router-link to="/shop" class="nav-link"><Store :size="17" /><span class="lbl-opt">Лавка</span></router-link>
        <div class="nav-more">
          <button class="nav-link" :class="{ active: refActive }" :aria-expanded="refMenu" @click="refMenu = !refMenu"><BookOpen :size="17" /><span>Справочник</span></button>
          <div v-if="refMenu" class="menu" @click="refMenu = false">
            <router-link v-for="r in reference" :key="r.to" :to="r.to" class="nav-link"><component :is="r.icon" :size="17" />{{ r.label }}</router-link>
          </div>
        </div>
      </nav>
      <div class="topbar-actions">
        <router-link v-if="store.online" to="/table" class="room-chip" :class="{ off: store.netStatus === 'reconnecting' }" :title="`Комната ${store.room?.code}: ${onlineCount} в сети`">
          <span class="dot" />{{ store.room?.code }}<span class="muted">· {{ onlineCount }}</span>
        </router-link>
        <button class="icon ghost icon-btn" title="Кубики" aria-label="Кубики" @click="dice = true"><Dice5 :size="20" /></button>
        <button v-if="store.online && !onTable" class="icon ghost icon-btn" title="Чат" aria-label="Чат" @click="chatOpen = !chatOpen">
          <MessageCircle :size="20" /><span v-if="unread" class="count">{{ unread > 99 ? '99+' : unread }}</span>
        </button>
      </div>
    </div>
    <div v-if="heroes.length" class="party-bar">
      <div class="party-bar-inner">
        <div v-if="store.game" class="day-pill">день<b>{{ store.game.day }}</b></div>
        <router-link v-for="h in heroes" :key="h.uid" to="/party" class="hero-pill" :class="{ down: h.status.dead || h.status.unconscious }" :title="`${h.name}: ${idx.cls(h.classId).name} ${h.level} ур.${store.online ? ` · ${store.ownerOf(h.uid) ?? 'ничей'}` : ''}`">
          <img :src="classArt(h.classId)" alt="" />
          <div class="nm">{{ h.name }}<span>{{ h.money }}м</span></div>
          <div class="bars">
            <div class="bar" :class="{ danger: h.lives <= h.maxLives / 3 }"><i :style="{ width: pct(Math.max(0, h.lives), h.maxLives) }" /></div>
            <div v-if="h.maxMana" class="bar mana"><i :style="{ width: pct(h.mana, h.maxMana) }" /></div>
          </div>
        </router-link>
      </div>
    </div>
  </header>
  <div v-if="store.online && store.netStatus === 'reconnecting'" class="net-banner">Связь с сервером потеряна — возвращаемся за стол…</div>

  <main class="page">
    <router-view />
  </main>

  <!-- нижняя панель на телефоне -->
  <nav class="tabbar" aria-label="Разделы">
    <router-link v-if="store.online" to="/table"><MessagesSquare :size="22" /><span>Стол</span><span v-if="unread && !onTable" class="count">{{ unread }}</span></router-link>
    <router-link v-else to="/" exact-active-class="router-link-active"><Home :size="22" /><span>Главная</span></router-link>
    <router-link to="/party"><Users :size="22" /><span>Партия</span></router-link>
    <router-link to="/map"><MapIcon :size="22" /><span>Карта</span></router-link>
    <router-link v-if="inCombat" to="/combat" class="hot"><Swords :size="22" /><span>Бой</span></router-link>
    <router-link v-else-if="locationLink" :to="locationLink"><Castle :size="22" /><span>Локация</span></router-link>
    <router-link v-else to="/shop"><Store :size="22" /><span>Лавка</span></router-link>
    <button :class="{ 'router-link-active': more }" @click="more = !more"><Menu :size="22" /><span>Ещё</span></button>
  </nav>
  <template v-if="more">
    <div class="sheet-back" @click="more = false" />
    <div class="sheet" role="dialog" aria-label="Все разделы">
      <div class="sheet-grid">
        <router-link to="/"><Home :size="22" />Главная</router-link>
        <router-link to="/shop"><Store :size="22" />Лавка</router-link>
        <router-link v-if="locationLink && inCombat" :to="locationLink"><Castle :size="22" />{{ store.location?.name }}</router-link>
        <router-link v-for="r in reference" :key="r.to" :to="r.to"><component :is="r.icon" :size="22" />{{ r.label }}</router-link>
        <button @click="more = false; dice = true"><Dice5 :size="22" />Кубики</button>
      </div>
    </div>
  </template>

  <!-- чат с любого экрана -->
  <button v-if="store.online && !onTable && !chatOpen" class="chat-fab icon-btn" title="Чат" aria-label="Открыть чат" @click="chatOpen = true">
    <MessageCircle :size="24" /><span v-if="unread" class="count">{{ unread > 99 ? '99+' : unread }}</span>
  </button>
  <section v-if="chatOpen && store.online" class="chat-panel" aria-label="Чат">
    <header>
      <h3>Чат стола</h3>
      <button class="icon ghost" aria-label="Закрыть чат" @click="chatOpen = false"><X :size="20" /></button>
    </header>
    <GmChat height="auto" />
  </section>

  <div v-if="store.notice" class="notice" role="status">{{ store.notice }}</div>
  <DiceTray v-if="dice" @close="dice = false" />
  <div v-if="rejoining && store.connecting && !store.room" class="overlay">
    <img :src="`${base}img/brand/logo.png`" alt="" />
    <div class="spinner" />
    <div>Возвращаемся за стол…</div>
  </div>
</template>
