<script setup lang="ts">
import { computed } from 'vue'
import { useGameStore } from '@/stores/game'
import { idx } from '@/data'

const store = useGameStore()
const heroes = computed(() => store.heroes)
const inCombat = computed(() => !!store.combat)
const locationLink = computed(() => (store.location ? `/location/${store.location.id}` : null))
</script>

<template>
  <header class="app-header">
    <div class="inner">
      <router-link class="brand" to="/">Заклятье Чёрного мага</router-link>
      <nav class="main">
        <router-link to="/party">Партия</router-link>
        <router-link to="/map">Карта</router-link>
        <router-link v-if="locationLink" :to="locationLink">{{ store.location?.name }}</router-link>
        <router-link v-if="inCombat" to="/combat" class="hot">⚔ Бой</router-link>
        <router-link to="/shop">Лавка</router-link>
        <router-link to="/bestiary">Бестиарий</router-link>
        <router-link to="/spells">Заклинания</router-link>
        <router-link to="/lore">Предыстория</router-link>
        <router-link to="/about">Об игре</router-link>
      </nav>
      <div class="party-strip" v-if="heroes.length">
        <span class="chip muted" v-if="store.game">День {{ store.game.day }}</span>
        <span v-for="h in heroes" :key="h.uid" class="chip" :class="{ down: h.status.dead || h.status.unconscious }" :title="idx.cls(h.classId).name">
          {{ h.name }} · ♥{{ h.lives }}/{{ h.maxLives }}<template v-if="h.maxMana"> · ✦{{ h.mana }}/{{ h.maxMana }}</template> · {{ h.money }}м
        </span>
      </div>
    </div>
  </header>
  <main class="page">
    <router-view />
  </main>
  <div v-if="store.notice" class="notice">{{ store.notice }}</div>
</template>
