<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import DiceTray from '@/components/DiceTray.vue'
import { useGameStore } from '@/stores/game'
import { idx } from '@/data'

const store = useGameStore()
const heroes = computed(() => store.heroes)
const inCombat = computed(() => !!store.combat)
const dice = ref(false)
const route = useRoute()
onMounted(() => { void store.rejoin() })
void route
const locationLink = computed(() => (store.location ? `/location/${store.location.id}` : null))
</script>

<template>
  <header class="app-header">
    <div class="inner">
      <router-link class="brand" to="/">Заклятье Чёрного мага</router-link>
      <nav class="main">
        <router-link v-if="store.online" to="/table" class="hot-online">Стол{{ store.room?.gm === 'ai' && store.room?.gmBusy ? ' ✎' : '' }}</router-link>
        <router-link to="/party">Партия</router-link>
        <router-link to="/map">Карта</router-link>
        <router-link v-if="locationLink" :to="locationLink">{{ store.location?.name }}</router-link>
        <router-link v-if="inCombat" to="/combat" class="hot">⚔ Бой</router-link>
        <router-link to="/shop">Лавка</router-link>
        <router-link to="/bestiary">Бестиарий</router-link>
        <router-link to="/spells">Заклинания</router-link>
        <router-link to="/rules">Правила</router-link>
        <router-link to="/lore">Предыстория</router-link>
        <router-link to="/about">Об игре</router-link>
        <a href="#" title="Кубики" @click.prevent="dice = true">🎲</a>
      </nav>
      <div class="party-strip" v-if="heroes.length || store.online">
        <span class="chip" v-if="store.online" style="border-color:var(--accent);color:var(--accent)">комната {{ store.room?.code }} · {{ store.room?.players.filter(p => p.online).length }} в сети</span>
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
  <DiceTray v-if="dice" @close="dice = false" />
</template>
