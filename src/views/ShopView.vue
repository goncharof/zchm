<script setup lang="ts">
import { computed, ref } from 'vue'
import { gameData, idx } from '@/data'
import { canUseWeapon } from '@/engine/character'
import { SERVICES } from '@/engine/world'
import { REST_COST_PER_DAY } from '@/engine/rules'
import { useGameStore } from '@/stores/game'
import { HAND_NAMES, attacksStr } from '@/ui/format'
import HeroSheet from '@/components/HeroSheet.vue'

const store = useGameStore()
const tab = ref<'weapons' | 'armor' | 'items' | 'sell' | 'tavern'>('weapons')
const buyerUid = ref(store.heroes[0]?.uid ?? '')
const buyer = computed(() => store.heroes.find((h) => h.uid === buyerUid.value) ?? store.heroes[0])
const services = computed(() => (store.location ? SERVICES[store.location.id] ?? [] : []))
const allowed = computed(() => !!store.game && (store.game.day === 1 || services.value.includes('shop') || store.game.gmMode))
const tavern = computed(() => !!store.game && (services.value.includes('tavern') || store.game.gmMode))
const restDays = ref(1)
const weapons = computed(() => gameData.weapons.filter((w) => w.price > 0))

function buy(kind: 'weapon' | 'armor' | 'item', ref_: string) {
  if (!buyer.value) return
  try { store.buyItem(buyer.value.uid, kind, ref_) } catch (e) { store.say((e as Error).message) }
}
function usable(wId: string) {
  return buyer.value ? canUseWeapon(idx.cls(buyer.value.classId), idx.weapon(wId)) : true
}
</script>

<template>
  <div class="card">
    <div class="row between">
      <h1>Лавка и трактир</h1>
      <div class="row"><label>Покупатель</label><select v-model="buyerUid"><option v-for="h in store.heroes" :key="h.uid" :value="h.uid">{{ h.name }} ({{ h.money }} монет)</option></select></div>
    </div>
    <p v-if="!store.heroes.length" class="muted">Сначала соберите партию.</p>
    <p v-else-if="!allowed" class="muted">Лавки здесь нет. ХАУСРУЛ: торговля доступна в городах и крепостях (Золотой город, Крепость рыцарей, Замок жрецов, Крепость последней надежды, Брошенный город, Северный форт), а также перед началом пути. Ведущий может включить режим ведущего и разрешить торговлю.</p>
    <div class="tabs" style="margin-top:.5rem">
      <button :class="{ active: tab === 'weapons' }" @click="tab = 'weapons'">Оружие</button>
      <button :class="{ active: tab === 'armor' }" @click="tab = 'armor'">Доспехи</button>
      <button :class="{ active: tab === 'items' }" @click="tab = 'items'">Вещи</button>
      <button :class="{ active: tab === 'sell' }" @click="tab = 'sell'">Продать</button>
      <button :class="{ active: tab === 'tavern' }" @click="tab = 'tavern'">Трактир</button>
    </div>

    <table v-if="tab === 'weapons' && allowed" class="list stack">
      <thead><tr><th>Оружие</th><th>Атаки (к6)</th><th>Рука</th><th>Цена</th><th></th></tr></thead>
      <tbody>
        <tr v-for="w in weapons" :key="w.id" :class="{ muted: !usable(w.id) }">
          <td data-label="Оружие">{{ w.name }} <span v-if="w.ranged" class="badge">метательное</span><span v-if="w.throwable" class="badge">можно метать</span><span v-if="w.accuracyBonus" class="badge">меткость +{{ w.accuracyBonus }}</span></td>
          <td data-label="Атаки (к6)">{{ attacksStr(w.attacks) }}</td><td data-label="Рука" class="small">{{ w.hand ? HAND_NAMES[w.hand] : '' }}</td><td data-label="Цена">{{ w.price }}</td>
          <td><button class="small" :disabled="!buyer || buyer.money < w.price" :title="usable(w.id) ? '' : 'Класс не может этим пользоваться, но купить можно'" @click="buy('weapon', w.id)">Купить</button></td>
        </tr>
      </tbody>
    </table>
    <table v-if="tab === 'armor' && allowed" class="list stack">
      <thead><tr><th>Доспех</th><th>Защита</th><th>Цена</th><th></th></tr></thead>
      <tbody>
        <tr v-for="a in gameData.armor.filter(x => x.price > 0)" :key="a.id">
          <td data-label="Доспех">{{ a.name }}</td><td data-label="Защита">{{ a.defense ?? (a.defenseBonus ? `+${a.defenseBonus}` : a.strengthBonus ? `сила +${a.strengthBonus}` : '') }}</td><td data-label="Цена">{{ a.price }}</td>
          <td><button class="small" :disabled="!buyer || buyer.money < a.price" @click="buy('armor', a.id)">Купить</button></td>
        </tr>
      </tbody>
    </table>
    <table v-if="tab === 'items' && allowed" class="list stack">
      <thead><tr><th>Вещь</th><th>Описание</th><th>Цена</th><th></th></tr></thead>
      <tbody>
        <tr v-for="i in gameData.items" :key="i.id">
          <td data-label="Вещь">{{ i.name }}</td><td data-label="Описание" class="small muted">{{ i.description }}</td><td data-label="Цена">{{ i.price }}</td>
          <td><button class="small" :disabled="!buyer || buyer.money < i.price" @click="buy('item', i.id)">Купить</button></td>
        </tr>
      </tbody>
    </table>
    <div v-if="tab === 'tavern'">
      <p v-if="!tavern" class="muted">Трактира здесь нет.</p>
      <template v-else>
        <p>Сутки отдыха: {{ REST_COST_PER_DAY }} монеты с каждого, +5 жизней и +5 маны (не выше максимума).</p>
        <div class="row"><label>Суток</label><input type="number" min="1" max="30" v-model.number="restDays" /><button class="primary" @click="store.restAll(restDays)">Отдохнуть</button></div>
      </template>
    </div>
  </div>
  <template v-if="tab === 'sell' && allowed">
    <p class="small muted">ХАУСРУЛ: продажа за половину цены.</p>
    <HeroSheet v-for="h in store.heroes" :key="h.uid" :hero="h" shop />
  </template>
</template>
