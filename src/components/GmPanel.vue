<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { BookOpen, Dices, Swords } from 'lucide-vue-next'
import { idx } from '@/data'
import { useGameStore } from '@/stores/game'
import { classArt, pct } from '@/ui/format'
import MonsterPicker from './MonsterPicker.vue'

/** Пульт живого ведущего: быстрые правки героев, проверка удачи, бой, текст текущего параграфа */
const store = useGameStore()
const picker = ref(false)
const luckHero = ref('')
const luckTarget = ref(10)
const alive = computed(() => store.heroes.filter((h) => !h.status.dead))
watch(alive, (list) => { if (!list.some((h) => h.uid === luckHero.value)) luckHero.value = list[0]?.uid ?? '' }, { immediate: true })
const where = computed(() => store.location ? `/location/${store.location.id}` : null)
const step = (heroUid: string, kind: 'lives' | 'money' | 'xp', d: number) => {
  if (kind === 'lives') void store.adjustLives(heroUid, d)
  else if (kind === 'money') void store.adjustMoney(heroUid, d)
  else void store.giveXp(heroUid, d)
}
</script>

<template>
  <div class="card tight gm-panel">
    <div class="row between">
      <h3 style="margin:0">Пульт ведущего</h3>
      <router-link v-if="where" class="btn small" :to="where"><BookOpen :size="15" />Текст Книги</router-link>
    </div>
    <p class="small muted" style="margin:.3rem 0 .6rem">Игроки не видят текст параграфов — рассказывайте в чате «как ведущий» и применяйте последствия здесь.</p>
    <div v-for="h in store.heroes" :key="h.uid" class="gm-hero" :class="{ 'hero-down': h.status.dead }">
      <img :src="classArt(h.classId)" alt="" class="portrait small-portrait" />
      <div class="gm-hero-main">
        <div class="small"><b>{{ h.name }}</b> <span class="muted">{{ idx.cls(h.classId).name }} {{ h.level }} · {{ store.ownerOf(h.uid) ?? 'ничей' }}</span></div>
        <div class="bar" :class="{ danger: h.lives <= h.maxLives / 3 }"><i :style="{ width: pct(Math.max(0, h.lives), h.maxLives) }" /></div>
        <div class="gm-steps">
          <span class="lbl">♥ {{ h.lives }}/{{ h.maxLives }}</span>
          <button class="small" aria-label="Жизни −1" @click="step(h.uid, 'lives', -1)">−1</button>
          <button class="small" aria-label="Жизни +1" @click="step(h.uid, 'lives', 1)">+1</button>
          <span class="lbl">{{ h.money }} м</span>
          <button class="small" aria-label="Монеты −10" @click="step(h.uid, 'money', -10)">−10</button>
          <button class="small" aria-label="Монеты +10" @click="step(h.uid, 'money', 10)">+10</button>
          <button class="small" title="Опыт +50" @click="step(h.uid, 'xp', 50)">+50 оп.</button>
        </div>
      </div>
    </div>
    <div class="row" style="margin-top:.6rem">
      <label class="row small" style="gap:.3rem">Удача
        <select v-model="luckHero" class="small"><option v-for="h in alive" :key="h.uid" :value="h.uid">{{ h.name }}</option></select>
        <input v-model.number="luckTarget" type="number" min="2" max="20" style="width:4rem" aria-label="Порог удачи" />
      </label>
      <button class="small" :disabled="!luckHero" @click="store.luckCheck(luckHero, luckTarget)"><Dices :size="15" />Проверить</button>
      <button v-if="!store.combat || store.combat.finished" class="small" @click="picker = true"><Swords :size="15" />Начать бой</button>
      <router-link v-else class="btn small" to="/combat"><Swords :size="15" />К бою</router-link>
    </div>
    <MonsterPicker v-if="picker" @close="picker = false" @start="(s) => { picker = false; store.startEncounter(s) }" />
  </div>
</template>
