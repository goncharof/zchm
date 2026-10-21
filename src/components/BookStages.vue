<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { BookNode, Paragraph } from '@/types'
import type { EncounterSpec } from '@/engine/combat'
import { diceKey, hasResult, nodeText, openNodes, paragraphTree } from '@/game/tree'
import { useGameStore } from '@/stores/game'
import ParagraphActions from './ParagraphActions.vue'

/** Параграф по этапам (одиночная игра и живой ведущий): открытые этапы с их действиями и невыбранные варианты.
 *  Исходы боя, проверки удачи и броска по списку открываются сами — по отметкам прохождения в state.claimed */
const props = defineProps<{ loc: string; locName: string; paragraph: Paragraph; heroUid: string }>()
const emit = defineEmits<{ fight: [specs: EncounterSpec[], place: string] }>()
const store = useGameStore()

const P = computed(() => `${props.loc}:${props.paragraph.n}`)
const tree = computed(() => paragraphTree(props.paragraph))
const claimed = computed(() => store.game?.claimed ?? [])
const open = computed(() => openNodes(tree.value, P.value, claimed.value))
const openIds = computed(() => new Set(open.value.map((n) => n.id)))
/** последний бросок списка «для каждого» (его исходы не открываются этапами, а показываются здесь) */
const repeatRoll = ref<Record<string, number>>({})
watch(P, () => { repeatRoll.value = {} })

const place = (n: BookNode) => `${P.value}:${n.id}`
function head(n: BookNode): string {
  if (n.on === 'enter') return ''
  if (typeof n.on === 'object') return `Выпало ${n.on.roll.join(', ')}`
  return n.label ?? ''
}
/** механика этапа: выигранный бой и пройденная проверка не предлагаются снова */
function hints(n: BookNode) {
  let h = n.hints
  if (h && hasResult(P.value, n.id, claimed.value, 'won')) h = { ...h, monsters: [] }
  if (h && hasResult(P.value, n.id, claimed.value, 'ok')) h = { ...h, luck: [] }
  return h
}
function choices(n: BookNode): BookNode[] {
  const kids = (n.then ?? []).filter((c) => c.on === 'choice')
  if (n.exclusive && kids.some((c) => openIds.value.has(c.id))) return []
  return kids.filter((c) => !openIds.value.has(c.id))
}
async function choose(c: BookNode) {
  await store.bookMark(place(c), 'open')
  void store.note(`${props.locName}, § ${props.paragraph.n}: ${c.label ?? 'выбор'}.`)
}
const rolled = (n: BookNode) => {
  const k = claimed.value.find((x) => x.startsWith(`${P.value}:${diceKey(n)}:roll=`))
  return k ? Number(k.slice(k.indexOf('=') + 1)) : null
}
const repeatHit = (n: BookNode) => {
  const r = repeatRoll.value[n.id]
  return r === undefined ? undefined : (n.then ?? []).find((c) => typeof c.on === 'object' && c.on.roll.includes(r))
}
async function roll(n: BookNode) {
  const d = n.dice
  if (!d || (!d.repeat && rolled(n) !== null)) return
  const r = await store.rollDie(d.sides, `${props.locName}, § ${props.paragraph.n}`)
  if (r === undefined) return
  // бросок по списку — один раз (иначе перебрасывали бы до награды); список «для каждого» — сколько угодно
  if (d.repeat) { repeatRoll.value = { ...repeatRoll.value, [n.id]: r }; return }
  await store.claim(`${P.value}:${diceKey(n)}:roll=${r}`)
}
const teaser = (n: BookNode) => n.teaser && !hasResult(P.value, n.id, claimed.value, 'won')
</script>

<template>
  <div v-for="n in open" :key="n.id" :class="{ stage: n.on !== 'enter' }">
    <div v-if="head(n)" class="stage-head">{{ head(n) }}</div>
    <p v-if="nodeText(n)" class="paragraph-text">{{ nodeText(n) }}</p>
    <p v-if="teaser(n)" class="small muted" style="font-style:italic">{{ n.teaser }}</p>
    <ParagraphActions :hints="hints(n)" :hero-uid="heroUid" :place="place(n)" @fight="(s) => emit('fight', s, place(n))" />
    <div v-if="n.dice" class="row" style="margin-top:.45rem">
      <button class="small primary" :disabled="!n.dice.repeat && rolled(n) !== null" @click="roll(n)">
        {{ !n.dice.repeat && rolled(n) !== null ? `Брошено: ${rolled(n)}` : `🎲 Бросить к${n.dice.sides}${n.dice.repeat ? ' (на каждый)' : ''}` }}
      </button>
      <span v-if="n.dice.repeat && repeatRoll[n.id] !== undefined" class="small">Выпало <b>{{ repeatRoll[n.id] }}</b>{{ repeatHit(n) ? '' : ': ничего не происходит' }}</span>
    </div>
    <div v-if="n.dice?.repeat && repeatHit(n)" class="stage">
      <p class="paragraph-text">{{ nodeText(repeatHit(n)!) }}</p>
      <ParagraphActions :hints="repeatHit(n)!.hints" :hero-uid="heroUid" :place="place(repeatHit(n)!)" @fight="(s) => emit('fight', s, place(repeatHit(n)!))" />
    </div>
    <div v-if="choices(n).length" class="stage-choices">
      <button v-for="c in choices(n)" :key="c.id" class="branch-head" @click="choose(c)">▸ {{ c.label }}</button>
    </div>
  </div>
</template>

<style scoped>
.stage { margin: .6rem 0; border-left: 3px solid var(--blood-2); padding-left: .7rem; }
.stage-head { font-weight: 600; color: var(--ink); margin-bottom: .2rem; }
.stage-choices { display: flex; flex-direction: column; gap: .35rem; margin-top: .6rem; }
</style>
