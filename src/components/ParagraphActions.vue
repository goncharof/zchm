<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { idx } from '@/data'
import type { Caster, ParagraphHints } from '@/types'
import type { EncounterSpec } from '@/engine/combat'
import { useGameStore } from '@/stores/game'
import { casterName } from '@/ui/format'
import { Swords } from 'lucide-vue-next'

/** Кнопки действий по подсказкам из текста: удача, бой, монеты, бутылки, артефакт, свитки */
/** place — где в книге («локация:§», для исходов броска — с номером списка): по нему награда берётся один раз
 *  на всю партию, даже если параграф открыли заново или переключили полный текст */
const props = defineProps<{ hints?: ParagraphHints; heroUid: string; place?: string }>()
const emit = defineEmits<{ fight: [specs: EncounterSpec[]] }>()
const store = useGameStore()
const counts = ref<Record<string, number>>({})
const lastLuck = ref('')
const battles = ref(3)
const taken = ref<Set<string>>(new Set())

const fightable = computed(() => (props.hints?.monsters ?? []).filter((m) => !idx.monsterById.get(m)?.special))
const npcs = computed(() => (props.hints?.monsters ?? []).filter((m) => idx.monsterById.get(m)?.special))
watch(() => props.hints, () => {
  counts.value = {}
  for (const m of fightable.value) counts.value[m] = props.hints?.monsterCounts?.[m] ?? 1
  lastLuck.value = ''
  taken.value = new Set()
}, { immediate: true })

function need(): string | null {
  if (!props.heroUid) { store.say('Выберите героя'); return null }
  return props.heroUid
}
function once(key: string, fn: (h: string) => void) {
  const h = need(); if (!h) return
  fn(h)
  taken.value = new Set([...taken.value, key])
}
/** награда из текста: ключ по виду и значению («c:20#1» — первые 20 монет), отмечается в состоянии партии */
const rewardKey = (kind: string, value: string | number, list: (string | number)[] = [], i = 0) =>
  `${kind}:${value}#${list.slice(0, i + 1).filter((x) => x === value).length}`
const claimed = computed(() => new Set(store.game?.claimed ?? []))
const isTaken = (key: string) => taken.value.has(key) || (!!props.place && claimed.value.has(`${props.place}:${key}`))
/** взять награду: отметка «взято» ставится сразу (два игрока не возьмут её дважды), а если выдать не удалось — снимается */
async function reward(key: string, give: (h: string) => Promise<boolean>) {
  const h = need(); if (!h) return
  const full = props.place ? `${props.place}:${key}` : ''
  if (full && !(await store.claim(full))) return
  if (!(await give(h))) { if (full) await store.unclaim(full); return }
  taken.value = new Set([...taken.value, key])
}
async function luck(target: number) {
  const h = need(); if (!h) return
  // место в книге: итог проверки отмечается и открывает её исходы (src/game/tree.ts)
  const r = await store.luckCheck(h, target, props.place)
  if (!r) return
  lastLuck.value = `${store.hero(h).name}: к18 = ${r.roll}${r.luck ? ` + ${r.luck}` : ''} против ${target} — ${r.ok ? 'удача!' : 'неудача'}`
}
function fight(ids: string[]) {
  const specs = ids.map((monsterId) => ({ monsterId, count: counts.value[monsterId] ?? 1 })).filter((s) => s.count > 0)
  if (specs.length) emit('fight', specs)
}
const itemName = (it: { kind: 'weapon' | 'armor' | 'item'; id: string }) => (it.kind === 'weapon' ? idx.weaponById : it.kind === 'armor' ? idx.armorById : idx.itemById).get(it.id)?.name ?? it.id
const has = computed(() => !!props.hints && Object.values(props.hints).some((v) => (Array.isArray(v) ? v.length : !!v)))
</script>

<template>
  <div v-if="has" class="row" style="margin-top:.45rem">
    <template v-for="t in hints?.luck ?? []" :key="'l' + t"><button class="small" @click="luck(t)">Бросок удачи {{ t }}</button></template>
    <template v-for="m in fightable" :key="m">
      <span class="row" style="gap:.2rem"><input type="number" min="0" max="30" v-model.number="counts[m]" style="width:3.4rem" class="small" :aria-label="`Сколько: ${idx.monsterById.get(m)?.name}`" :title="'Сколько противников'" /><span class="small muted" aria-hidden="true">×</span><button class="small danger" @click="fight([m])"><Swords :size="15" />Бой: {{ idx.monsterById.get(m)?.name }}</button></span>
    </template>
    <button v-if="fightable.length > 1" class="small danger" @click="fight(fightable)"><Swords :size="15" />Бой со всеми вместе</button>
    <details v-if="fightable.length" class="small" style="display:inline-block">
      <summary class="muted" style="cursor:pointer">＋ спутник</summary>
      <span class="row" style="gap:.25rem;margin-top:.25rem">
        <label class="small">боёв <input type="number" min="1" max="20" v-model.number="battles" style="width:3.2rem" class="small" /></label>
        <button v-for="m in fightable" :key="'cmp' + m" class="small" @click="store.addCompanion(m, battles)">{{ idx.monsterById.get(m)?.name }}</button>
      </span>
    </details>
    <button v-if="hints?.tavern" class="small" @click="store.restAll(1)">Отдохнуть сутки (2 монеты)</button>
    <router-link v-if="hints?.shop" class="btn small" to="/shop">В лавку</router-link>
    <template v-for="(c, i) in hints?.prices ?? []" :key="'p' + i"><button class="small" :disabled="taken.has('p' + i) || !heroUid || store.hero(heroUid).money < c" :title="heroUid && store.hero(heroUid).money < c ? 'Не хватает монет' : ''" @click="once('p' + i, (h) => store.adjustMoney(h, -c))">Заплатить {{ c }} монет</button></template>
    <template v-for="(c, i) in hints?.coins ?? []" :key="'c' + i"><button class="small" :disabled="isTaken(rewardKey('c', c, hints?.coins, i))" @click="reward(rewardKey('c', c, hints?.coins, i), (h) => store.cmdOk('adjustMoney', h, c))">+{{ c }} монет</button></template>
    <template v-for="(b, i) in hints?.bottles ?? []" :key="'b' + i"><button class="small" :disabled="isTaken(rewardKey('b', b, hints?.bottles, i))" @click="reward(rewardKey('b', b, hints?.bottles, i), (h) => store.cmdOk('giveItem', h, 'bottle', String(b), 1, false))">Взять бутылку ({{ b }})</button></template>
    <button v-if="hints?.artifact" class="small" :disabled="isTaken('art')" @click="reward('art', (h) => store.cmdOk('findArtifact', h))">Найти артефакт (к18)</button>
    <template v-for="(s, i) in hints?.scrolls ?? []" :key="'s' + i"><button class="small" :disabled="isTaken(rewardKey('s', `${s.caster ?? ''}${s.level ?? ''}`, (hints?.scrolls ?? []).map((x) => `${x.caster ?? ''}${x.level ?? ''}`), i))" @click="reward(rewardKey('s', `${s.caster ?? ''}${s.level ?? ''}`, (hints?.scrolls ?? []).map((x) => `${x.caster ?? ''}${x.level ?? ''}`), i), (h) => store.cmdOk('giveScroll', h, s.caster as Caster | undefined, s.level))">Свиток{{ s.caster ? ` ${casterName(s.caster)}а` : '' }}{{ s.level ? ` ${s.level} ур.` : '' }}</button></template>
    <template v-for="(it, i) in hints?.items ?? []" :key="'it' + i"><button class="small" :disabled="isTaken(`i:${it.kind}:${it.id}#${i}`)" @click="reward(`i:${it.kind}:${it.id}#${i}`, (h) => store.cmdOk('giveItem', h, it.kind, it.id, it.qty ?? 1))">Взять: {{ itemName(it) }}{{ (it.qty ?? 1) > 1 ? ` ×${it.qty}` : '' }}</button></template>
    <span v-for="m in npcs" :key="'npc' + m" class="badge" :title="idx.monsterById.get(m)?.description">{{ idx.monsterById.get(m)?.name }}</span>
  </div>
  <p v-if="lastLuck" class="small" style="color:var(--note);margin:.3rem 0 0">{{ lastLuck }}</p>
</template>
