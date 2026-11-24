<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { idx } from '@/data'
import { classArt, pct } from '@/ui/format'
import { useGameStore } from '@/stores/game'
import LogPanel from '@/components/LogPanel.vue'
import OnlinePanel from '@/components/OnlinePanel.vue'
import HowToPlay from '@/components/HowToPlay.vue'
import { roomOpen, savesOpen } from '@/ui/dialogs'
import type { RecentRoom } from '@/net/client'

const store = useGameStore()
const base = import.meta.env.BASE_URL
// абсолютный адрес: url() в CSS-переменной считается от файла стилей (assets/), а не от страницы
const bannerUrl = new URL(`${base}img/brand/banner.jpg`, document.baseURI).href
const router = useRouter()
const route = useRoute()
/** карточка «Игра по сети»: новичку и гостю по ссылке «…?room=КОД» — сразу; при начатой партии — по кнопке,
 *  чтобы главная оставалась экраном «Продолжить» */
const wantOnline = ref(typeof route.query.room === 'string')
const onlineShown = computed(() => !store.online && (wantOnline.value || !store.started))
async function showOnline() {
  wantOnline.value = true
  await nextTick()
  document.getElementById('online')?.scrollIntoView?.({ behavior: 'smooth', block: 'start' })
}
const allDead = computed(() => store.heroes.length > 0 && store.heroes.every((h) => h.status.dead))
const where = computed(() => store.combat ? 'в бою' : store.location ? store.location.name : store.worldNode?.name ?? '—')

function continueGame() {
  if (store.combat) router.push('/combat')
  else if (store.location) router.push(`/location/${store.location.id}`)
  else if (store.heroes.length) router.push('/map')
  else router.push('/party')
}
// последняя комната, где игрок был: вернуться за стол одной кнопкой (одиночная партия при этом не трогается)
const lastRoom = computed(() => (store.online ? null : store.recent[0] ?? null))
async function resume(r: RecentRoom) {
  if (await store.resumeRoom(r)) router.push('/table')
}
async function quick() {
  if (store.started && !confirm(store.online ? 'Партия комнаты будет заменена. Начать заново?' : 'Текущая партия будет удалена. Начать заново?')) return
  // в сетевой игре это команда хозяина комнаты, выходить из комнаты нельзя
  if (!store.online) store.resetGame()
  await store.quickStart()
  router.push('/map')
}
async function newGame() {
  if (store.started && !confirm(store.online ? 'Партия комнаты будет заменена. Начать заново?' : 'Текущая партия будет удалена. Начать заново?')) return
  if (!store.online) store.resetGame()
  await store.newGame()
  router.push('/party')
}
</script>

<template>
  <section class="hero-cover" :style="{ '--banner': `url(${bannerUrl})` }">
    <img class="cover" :src="`${base}img/brand/cover.jpg`" alt="Обложка коробки «Заклятье Чёрного мага», 1997" width="860" height="1315" />
    <div>
      <img class="logo" :src="`${base}img/brand/logo.png`" alt="Заклятье Чёрного мага" width="1100" height="191" />
      <div class="series">серия «Долина Тмамрак» · первая российская настольная ролевая игра, 1997</div>
      <p class="book-text">Группа искателей приключений отправляется в далёкий путь. Их задача — добраться до цитадели Чёрного мага, расправиться с ним и не дать силам Хаоса хлынуть в мир через Ворота Инкардагот.</p>
      <p v-if="!store.started" class="muted small">Движок ведёт механику: героев, кубики, бой, магию, лавку и опыт. Книга Жизни читается по локациям, а ведущим может быть ИИ, кто-то из игроков или никто.</p>
      <div v-if="store.game?.victory" class="card tight" style="border-color:var(--ok)"><b>Победа!</b> {{ store.game.victory.heroName }} сразил Чёрного мага на {{ store.game.victory.day }}-й день. Ворота Инкардагот остались закрыты.</div>
      <div v-if="allDead" class="card tight" style="border-color:var(--danger)"><b>Партия погибла.</b> Жрец мог бы оживить павших, но жрецов не осталось. Начните новую партию или загрузите сохранение.</div>
      <div class="cta">
        <button v-if="store.started" class="primary cta-main" @click="continueGame"><span>Продолжить</span><small>{{ store.online ? `комната ${store.room?.code} · ` : '' }}день {{ store.game?.day }} · {{ where }}</small></button>
        <button v-if="lastRoom" class="cta-main" :class="{ primary: !store.started }" :disabled="store.connecting" @click="resume(lastRoom)"><span>Вернуться за стол</span><small>комната {{ lastRoom.code }}{{ lastRoom.day ? ` · день ${lastRoom.day}` : '' }}{{ lastRoom.heroes ? ` · ${lastRoom.heroes}` : '' }}</small></button>
        <template v-if="!store.online || store.room?.me.isHost">
          <button :class="{ primary: !store.started && !lastRoom }" @click="newGame">Новая партия</button>
          <button @click="quick" title="Воин, маг, жрец и вор со снаряжением на 40 монет">Быстрый старт</button>
        </template>
        <button v-if="store.online" title="Код и ссылка, игроки, режим ведущего, «Отложить игру»" @click="roomOpen = true">Комната {{ store.room?.code }}</button>
        <button v-else @click="showOnline">Игра по сети</button>
        <button v-if="!store.started" class="ghost" title="Запасные копии в этом браузере и файл сохранения" @click="savesOpen = true">Загрузить сохранение</button>
      </div>
    </div>
  </section>

  <div class="cols c11">
    <div>
      <div v-if="onlineShown" id="online"><OnlinePanel /></div>
      <div class="card" v-if="store.heroes.length">
        <h2 class="title-ornament">Партия</h2>
        <router-link v-for="h in store.heroes" :key="h.uid" to="/party" class="hero-row" :class="{ 'hero-down': h.status.dead }">
          <img :src="classArt(h.classId)" alt="" class="portrait small-portrait" />
          <div class="hero-row-name">{{ h.name }}<span>{{ idx.cls(h.classId).name }} {{ h.level }} ур.</span><span v-if="h.status.dead" class="badge danger">мёртв</span></div>
          <div class="hero-row-side">{{ h.money }} м <span class="muted">· {{ h.xp }} оп.</span></div>
          <div class="vitals">
            <div class="vital" title="Жизни"><span><i class="ic-life">♥</i> {{ h.lives }}/{{ h.maxLives }}</span><div class="bar" :class="{ danger: h.lives * 3 <= h.maxLives }"><i :style="{ width: pct(Math.max(0, h.lives), h.maxLives) }" /></div></div>
            <div v-if="h.maxMana" class="vital" title="Мана"><span><i class="ic-mana">✦</i> {{ h.mana }}/{{ h.maxMana }}</span><div class="bar mana"><i :style="{ width: pct(h.mana, h.maxMana) }" /></div></div>
          </div>
        </router-link>
      </div>
    </div>
    <div>
      <HowToPlay v-if="!store.started" />
      <div class="card" v-if="store.game?.log.length">
        <h2 class="title-ornament">Журнал</h2>
        <LogPanel :entries="store.game.log" :limit="25" />
      </div>
    </div>
  </div>
</template>
