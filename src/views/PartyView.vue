<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import { gameData, idx } from '@/data'
import { useGameStore } from '@/stores/game'
import HeroSheet from '@/components/HeroSheet.vue'

const store = useGameStore()
const router = useRouter()
const name = ref('')
const classId = ref('warrior')
const cls = computed(() => gameData.classes.find((c) => c.id === classId.value)!)
const canChooseStart = computed(() => !!store.game && store.game.day === 1 && Object.keys(store.game.visited).length === 0 && !store.game.locationId)
const startNodes = computed(() => store.world?.nodes.filter((n) => n.locationId && n.locationId !== 'zamok-chernogo-maga') ?? [])

function add() {
  if (store.heroes.length >= 6) { store.say('Не больше шести героев'); return }
  store.addHero(name.value, classId.value)
  name.value = ''
}
</script>

<template>
  <div class="card">
    <div class="row between">
      <h1>Партия</h1>
      <div class="row">
        <label class="row" style="gap:.3rem" v-if="store.game && !store.online"><input type="checkbox" :checked="store.game.gmMode" @change="store.toggleGm()" /> режим ведущего</label>
        <button v-if="store.heroes.length" class="primary" @click="router.push('/shop')">Лавка (снаряжение)</button>
        <button v-if="store.heroes.length" @click="router.push('/map')">На карту</button>
      </div>
    </div>
    <div class="row" style="align-items:flex-end;margin-top:.5rem">
      <div><label>Имя героя</label><br /><input v-model="name" placeholder="Например, Конан" @keyup.enter="add" /></div>
      <div><label>Класс</label><br />
        <select v-model="classId"><option v-for="c in gameData.classes" :key="c.id" :value="c.id">{{ c.name }}</option></select>
      </div>
      <button class="primary" @click="add">Добавить в партию</button>
      <div v-if="canChooseStart && startNodes.length && store.game">
        <label>Стартовая точка</label><br />
        <select :value="store.game.worldNodeId" @change="store.setStart(($event.target as HTMLSelectElement).value)"><option v-for="n in startNodes" :key="n.id" :value="n.id">{{ n.name }}</option></select>
      </div>
    </div>
    <p class="small muted" style="margin-top:.6rem"><b>{{ cls.name }}.</b> {{ cls.description }} <i>Оружие: {{ cls.weaponRule }}. Метательное: {{ cls.rangedRule }}.</i>
      Жизни на старте {{ cls.levels[0].lives }}<template v-if="cls.levels[0].mana">, мана {{ cls.levels[0].mana }}</template>; 1-й уровень с {{ cls.levels[1].xp }} очков опыта.</p>
  </div>
  <div v-if="store.game?.companions.length" class="card">
    <h2>Спутники</h2>
    <table class="list stack">
      <tbody>
        <tr v-for="c in store.game.companions" :key="c.uid">
          <td data-label="Спутник"><b>{{ c.name }}</b> <span class="small muted">ур. {{ idx.monster(c.monsterId).level }} · защита {{ idx.monster(c.monsterId).defense }}</span></td>
          <td data-label="Жизни">{{ c.lives }}/{{ c.maxLives }}</td>
          <td data-label="Осталось боёв">{{ c.battlesLeft }}</td>
          <td style="text-align:right"><button class="small" @click="store.dismissCompanion(c.uid)">Отпустить</button></td>
        </tr>
      </tbody>
    </table>
    <p class="small muted">Спутники сражаются на стороне партии оговорённое число боёв, их отыгрывает движок (стр. 16 Инструкции).</p>
  </div>
  <p v-if="store.online && store.heroes.some(h => !store.ownerOf(h.uid))" class="card tight small">Нажмите «Взять героя» у того, кем будете играть, или создайте своего. Пока у героя нет игрока, им может управлять любой.</p>
  <p v-if="!store.heroes.length" class="muted">Добавьте героев. У каждого 40 монет, характеристики на старте равны нулю.</p>
  <HeroSheet v-for="h in store.heroes" :key="h.uid" :hero="h" />
</template>
