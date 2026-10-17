<script setup lang="ts">
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import { idx } from '@/data'
import { useGameStore } from '@/stores/game'
import { classArt, pct } from '@/ui/format'
import GmChat from '@/components/GmChat.vue'
import OnlinePanel from '@/components/OnlinePanel.vue'

const store = useGameStore()
const router = useRouter()
const base = import.meta.env.BASE_URL
const plan = computed(() => (store.location?.plan ? base + store.location.plan : null))
</script>

<template>
  <OnlinePanel v-if="!store.online" />
  <div v-else class="cols c21">
    <div>
      <div class="row between" style="margin-bottom:.4rem">
        <h1>За столом <span class="badge accent">комната {{ store.room?.code }}</span></h1>
        <div class="row">
          <router-link v-if="store.combat" class="btn" to="/combat" style="color:var(--danger)">⚔ К бою</router-link>
          <router-link class="btn hide-sm" to="/map">Карта</router-link>
          <router-link v-if="store.location" class="btn hide-sm" :to="`/location/${store.location.id}`">{{ store.location.name }}</router-link>
        </div>
      </div>
      <GmChat class="table-chat" height="62vh" />
    </div>
    <div>
      <div class="card tight">
        <h3>Партия <span class="small muted">· день {{ store.game?.day }} · {{ store.location?.name ?? store.worldNode?.name ?? '' }}</span></h3>
        <div v-for="h in store.heroes" :key="h.uid" class="row" style="gap:.5rem;margin:.35rem 0;flex-wrap:nowrap" :class="{ 'hero-down': h.status.dead }">
          <img :src="classArt(h.classId)" alt="" class="portrait small-portrait" />
          <div style="flex:1;min-width:0">
            <div class="small"><b>{{ h.name }}</b> <span class="muted">{{ idx.cls(h.classId).name }} {{ h.level }} · {{ store.ownerOf(h.uid) ?? 'ничей' }}</span></div>
            <div class="bar" style="height:5px"><i :style="{ width: pct(h.lives, h.maxLives) }" /></div>
          </div>
          <span class="small muted">{{ h.lives }}/{{ h.maxLives }}</span>
        </div>
        <div class="row" style="margin-top:.4rem"><router-link class="btn small" to="/party">Листы героев</router-link><router-link class="btn small" to="/shop">Лавка</router-link></div>
      </div>
      <div v-if="plan" class="card tight"><a :href="plan" target="_blank" rel="noopener"><img class="plan-img" :src="plan" :alt="store.location?.name" style="max-height:48vh" /></a></div>
      <OnlinePanel />
      <p v-if="store.aiGm" class="small muted">Пишите, что делают ваши герои. Ведущий читает Книгу Жизни, бросает за проверки удачи и начинает бои; сражаетесь вы на экране боя. Путешествие и вход в локации — с карты.</p>
    </div>
  </div>
  <button v-if="!store.online" class="small" style="margin-top:.5rem" @click="router.push('/')">На главную</button>
</template>
