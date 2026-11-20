<script setup lang="ts">
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import { idx } from '@/data'
import { classArt, pct } from '@/ui/format'
import { useGameStore } from '@/stores/game'
import LogPanel from '@/components/LogPanel.vue'
import OnlinePanel from '@/components/OnlinePanel.vue'
import SavesPanel from '@/components/SavesPanel.vue'
import type { RecentRoom } from '@/net/client'

const store = useGameStore()
const base = import.meta.env.BASE_URL
// абсолютный адрес: url() в CSS-переменной считается от файла стилей (assets/), а не от страницы
const bannerUrl = new URL(`${base}img/brand/banner.jpg`, document.baseURI).href
const scrollToOnline = () => document.getElementById('online')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
const router = useRouter()
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
      <p class="muted small">Движок ведёт механику: героев, кубики, бой, магию, лавку и опыт. Книга Жизни читается по локациям, а ведущим может быть ИИ, кто-то из игроков или никто.</p>
      <div v-if="store.game?.victory" class="card tight" style="border-color:var(--ok)"><b>Победа!</b> {{ store.game.victory.heroName }} сразил Чёрного мага на {{ store.game.victory.day }}-й день. Ворота Инкардагот остались закрыты.</div>
      <div v-if="allDead" class="card tight" style="border-color:var(--danger)"><b>Партия погибла.</b> Жрец мог бы оживить павших, но жрецов не осталось. Начните новую партию или загрузите сохранение.</div>
      <div class="cta">
        <button v-if="store.started" class="primary cta-main" @click="continueGame"><span>Продолжить</span><small>{{ store.online ? `комната ${store.room?.code} · ` : '' }}день {{ store.game?.day }} · {{ where }}</small></button>
        <button v-if="lastRoom" class="cta-main" :class="{ primary: !store.started }" :disabled="store.connecting" @click="resume(lastRoom)"><span>Вернуться за стол</span><small>комната {{ lastRoom.code }}{{ lastRoom.day ? ` · день ${lastRoom.day}` : '' }}{{ lastRoom.heroes ? ` · ${lastRoom.heroes}` : '' }}</small></button>
        <template v-if="!store.online || store.room?.me.isHost">
          <button :class="{ primary: !store.started && !lastRoom }" @click="newGame">Новая партия</button>
          <button @click="quick" title="Воин, маг, жрец и вор со снаряжением на 40 монет">Быстрый старт</button>
        </template>
        <button v-if="!store.online" @click="scrollToOnline">Игра по сети</button>
      </div>
    </div>
  </section>

  <div class="cols c11">
    <div>
      <div id="online"><OnlinePanel /></div>
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
        <div class="row" style="margin-top:.6rem"><router-link class="btn" to="/party">Листы персонажей</router-link><router-link class="btn" to="/map">Карта</router-link></div>
      </div>
      <div class="card">
        <h2 class="title-ornament">Сохранения</h2>
        <SavesPanel :room-actions="false" />
      </div>
    </div>
    <div>
      <div class="card">
        <h2 class="title-ornament">Как играть</h2>
        <ol class="small" style="padding-left:1.2rem;margin:0">
          <li>Соберите партию: до пяти героев, по одному каждого класса (воин, варвар, вор, маг, жрец). На 40 монет купите снаряжение в лавке.</li>
          <li>На карте мира выберите, куда идти. Переходы занимают дни; в пути возможны встречи из главы «Дорога».</li>
          <li>В локации выбирайте номера параграфов на плане, читайте текст и действуйте: проверки удачи, бои, находки.</li>
          <li>Бой пошаговый: первый раунд — дистанция, затем инициатива и ближний бой. Опыт начисляется за каждую отнятую жизнь.</li>
          <li>Отдыхайте в трактирах, копите опыт и артефакты, и лишь потом идите к Замку Чёрного мага.</li>
        </ol>
        <p class="small muted" style="margin:.6rem 0 0">Режим ведущего (в разделе «Партия») прячет текст параграфов, чтобы их читал живой ведущий.</p>
      </div>
      <div class="card" v-if="store.game?.log.length">
        <h2 class="title-ornament">Журнал</h2>
        <LogPanel :entries="store.game.log" :limit="25" />
      </div>
    </div>
  </div>
</template>
