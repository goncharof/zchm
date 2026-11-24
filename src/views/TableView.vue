<script setup lang="ts">
import LogPanel from '@/components/LogPanel.vue'
import GmPanel from '@/components/GmPanel.vue'
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import { useGameStore } from '@/stores/game'
import GmChat from '@/components/GmChat.vue'
import OnlinePanel from '@/components/OnlinePanel.vue'
import { roomOpen } from '@/ui/dialogs'

const store = useGameStore()
const router = useRouter()
const base = import.meta.env.BASE_URL
/** живой ведущий — хозяин комнаты: у него пульт и план локации целиком */
const liveGm = computed(() => store.room?.gm === 'human' && !!store.room.me.isHost)
// план целиком — только ведущему: игроки открывают его по мере пути на экране локации
const plan = computed(() => (liveGm.value && store.location?.plan ? base + store.location.plan : null))
/** у игрока есть свой герой */
const hasHero = computed(() => !!store.room?.me.heroUids.length)
/** боковая колонка: пульт ведущего и журнал; пока в ней пусто, чат занимает всю ширину */
const side = computed(() => liveGm.value || !!store.game?.log.length)
</script>

<template>
  <OnlinePanel v-if="!store.online" />
  <div v-else :class="{ 'cols c21': side }">
    <div>
      <div class="row between" style="margin-bottom:.4rem">
        <h1>За столом</h1>
        <div class="row">
          <router-link v-if="store.combat" class="btn" to="/combat" style="color:var(--danger)">⚔ К бою</router-link>
          <button title="Код и ссылка, игроки, режим ведущего, «Отложить игру»" @click="roomOpen = true">Комната {{ store.room?.code }}</button>
        </div>
      </div>
      <div v-if="!hasHero && !liveGm" class="card tight onboarding">
        <template v-if="store.heroes.length">
          <b>Вы пока без героя.</b> Возьмите свободного героя в разделе «Партия» или создайте своего — тогда сможете ходить в бою и говорить за него.
          <router-link class="btn small" to="/party">Взять героя</router-link>
        </template>
        <template v-else>
          <b>Партия ещё не собрана.</b> {{ store.room?.me.isHost ? 'Нажмите «Быстрый старт» на главной или создайте героев в разделе «Партия».' : 'Подождите, пока хозяин соберёт партию, или создайте своего героя в разделе «Партия».' }}
          <router-link class="btn small" :to="store.room?.me.isHost ? '/' : '/party'">{{ store.room?.me.isHost ? 'На главную' : 'Партия' }}</router-link>
        </template>
      </div>
      <GmChat class="table-chat" height="62vh" />
    </div>
    <div v-if="side">
      <GmPanel v-if="liveGm" />
      <div v-if="store.game?.log.length" class="card tight">
        <h3>Журнал игры</h3>
        <LogPanel :entries="store.game.log" :limit="liveGm ? 8 : 14" />
      </div>
      <div v-if="plan" class="card tight"><a :href="plan" target="_blank" rel="noopener"><img class="plan-img" :src="plan" :alt="store.location?.name" style="max-height:48vh" /></a></div>
    </div>
  </div>
  <button v-if="!store.online" class="small" style="margin-top:.5rem" @click="router.push('/')">На главную</button>
</template>
