<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { idx } from '@/data'
import type { EncounterSpec } from '@/engine/combat'
import { SERVICES } from '@/engine/world'
import { useGameStore } from '@/stores/game'
import { casterName } from '@/ui/format'
import MonsterPicker from '@/components/MonsterPicker.vue'

const props = defineProps<{ id: string }>()
const store = useGameStore()
const route = useRoute()
const router = useRouter()
const loc = computed(() => idx.locationById.get(props.id))
const planSrc = computed(() => (loc.value?.plan ? `${import.meta.env.BASE_URL}${loc.value.plan}` : null))
const current = ref<number | null>(null)
const paragraph = computed(() => loc.value?.paragraphs.find((p) => p.n === current.value) ?? null)
const revealed = ref(false)
const heroUid = ref(store.heroes[0]?.uid ?? '')
const counts = ref<Record<string, number>>({})
const picker = ref(false)
const lastLuck = ref('')
const visited = computed(() => store.game?.visited[props.id] ?? [])
const services = computed(() => SERVICES[props.id] ?? [])
const gm = computed(() => store.game?.gmMode ?? false)
const activeHeroes = computed(() => store.heroes.filter((h) => !h.status.dead))
const fightable = computed(() => (paragraph.value?.hints?.monsters ?? []).filter((m) => !idx.monsterById.get(m)?.special))
const npcs = computed(() => (paragraph.value?.hints?.monsters ?? []).filter((m) => idx.monsterById.get(m)?.special))

function open(n: number) {
  current.value = n
  revealed.value = false
  lastLuck.value = ''
  counts.value = {}
  for (const m of paragraph.value?.hints?.monsters ?? []) if (!idx.monsterById.get(m)?.special) counts.value[m] = 1
}
onMounted(() => {
  if (store.game && store.game.locationId !== props.id && props.id !== 'doroga' && store.worldNode?.locationId === props.id) store.enterLocation(props.id)
  const p = Number(route.query.p)
  if (p) open(p)
})
watch(() => route.query.p, (p) => { if (p) open(Number(p)) })

function need(): string | null {
  if (!heroUid.value) { store.say('Выберите героя'); return null }
  return heroUid.value
}
function luck(target: number) {
  const h = need(); if (!h) return
  const r = store.luckCheck(h, target)
  lastLuck.value = `к18 = ${r.roll}${r.luck ? ` + ${r.luck}` : ''} против ${target}: ${r.ok ? 'удача!' : 'неудача'}`
}
function fight(ids?: string[]) {
  const specs: EncounterSpec[] = (ids ?? fightable.value).map((monsterId) => ({ monsterId, count: counts.value[monsterId] ?? 1 })).filter((s) => s.count > 0)
  if (!specs.length) return
  startFight(specs)
}
function startFight(specs: EncounterSpec[]) {
  picker.value = false
  if (current.value) store.markVisited(props.id, current.value)
  store.startEncounter(specs, `/location/${props.id}${current.value ? `?p=${current.value}` : ''}`)
  router.push('/combat')
}
function coins(n: number) { const h = need(); if (h) store.adjustMoney(h, n) }
function bottle(n: number) { const h = need(); if (h) store.giveItem(h, 'bottle', String(n), 1, false) }
function artifact() { const h = need(); if (h) store.findArtifact(h) }
function scroll(s: { caster?: 'mage' | 'priest'; level?: number }) { const h = need(); if (h) store.giveScroll(h, s.caster, s.level) }
function trap() { const h = need(); if (h) store.trapFound(h) }
function lives(n: number) { const h = need(); if (h) store.adjustLives(h, n) }
const isFinal = computed(() => props.id === 'zamok-chernogo-maga' && current.value === 13)
function finalAttack() {
  const h = need(); if (!h) return
  const won = store.finalDuelAttack(h)
  lastLuck.value = won ? 'Попадание! Чёрный маг повержен.' : 'Промах — маг отвечает огненным шаром (см. журнал).'
  if (won && current.value) store.markVisited(props.id, current.value)
}
function done() { if (current.value) store.markVisited(props.id, current.value); if (props.id === 'doroga' && current.value) store.dismissRoad(current.value) }
function leave() { store.leaveLocation(); router.push('/map') }
</script>

<template>
  <div v-if="!loc" class="card">Локация не найдена.</div>
  <template v-else>
    <div class="row between" style="margin-bottom:.6rem">
      <h1>{{ loc.name }} <span class="badge">Книга Жизни, стр. {{ loc.pages[0] }}–{{ loc.pages[1] }}</span></h1>
      <div class="row">
        <router-link v-if="services.includes('shop') || services.includes('tavern')" class="btn" to="/shop">Лавка / трактир</router-link>
        <button @click="picker = true">Произвольный бой</button>
        <button v-if="store.game?.locationId === id" @click="leave">Покинуть локацию</button>
        <router-link v-else class="btn" to="/map">Карта</router-link>
      </div>
    </div>
    <div v-if="id === 'doroga' && store.game?.pendingRoad.length" class="card tight row">
      <b>Встречи в пути:</b>
      <button v-for="(n, i) in store.game.pendingRoad" :key="i" class="small" @click="open(n)">{{ n }}</button>
    </div>
    <div class="cols c11">
      <div>
        <div class="card tight">
          <div class="numgrid">
            <button v-for="p in loc.paragraphs" :key="p.n" :class="{ visited: visited.includes(p.n), active: p.n === current }" @click="open(p.n)">{{ p.n }}</button>
          </div>
          <p class="small muted" style="margin:.4rem 0 0">{{ id === 'doroga' ? 'Ведущий выбирает любое приключение из главы «Дорога».' : 'Номера соответствуют плану локации. Пройденные параграфы приглушены.' }}</p>
        </div>
        <div v-if="planSrc" class="card tight"><a :href="planSrc" target="_blank" rel="noopener" title="Открыть план целиком"><img class="plan-img" :src="planSrc" :alt="`План: ${loc.name}`" /></a></div>
      </div>
      <div>
        <div v-if="!paragraph" class="card muted">Выберите номер параграфа.</div>
        <div v-else class="card">
          <div class="row between"><h2>§ {{ paragraph.n }}</h2><button class="small" @click="done">Отметить пройденным</button></div>
          <div v-if="gm && !revealed" class="row"><span class="muted">Режим ведущего: текст скрыт.</span><button class="small" @click="revealed = true">Показать текст</button></div>
          <p v-else class="paragraph-text">{{ paragraph.text }}</p>

          <div class="row" style="margin:.6rem 0 .3rem"><label>Действует</label><select v-model="heroUid"><option v-for="h in activeHeroes" :key="h.uid" :value="h.uid">{{ h.name }}</option></select></div>
          <div class="row" v-if="paragraph.hints">
            <template v-for="t in paragraph.hints.luck ?? []" :key="'l' + t"><button @click="luck(t)">Бросок удачи {{ t }}</button></template>
            <template v-for="m in fightable" :key="m">
              <span class="row" style="gap:.2rem"><input type="number" min="0" max="20" v-model.number="counts[m]" style="width:3.6rem" /><button class="danger" @click="fight([m])">⚔ {{ idx.monsterById.get(m)?.name }}</button></span>
            </template>
            <button v-if="fightable.length > 1" class="danger" @click="fight()">⚔ Бой со всеми</button>
            <span v-for="m in npcs" :key="'npc' + m" class="badge" :title="idx.monsterById.get(m)?.description">{{ idx.monsterById.get(m)?.name }} — персонаж, не противник</span>
            <template v-for="c in paragraph.hints.coins ?? []" :key="'c' + c"><button @click="coins(c)">+{{ c }} монет</button></template>
            <template v-for="b in paragraph.hints.bottles ?? []" :key="'b' + b"><button @click="bottle(b)">Взять бутылку ({{ b }})</button></template>
            <button v-if="paragraph.hints.artifact" @click="artifact">Найти артефакт (к18)</button>
            <template v-for="(s, i) in paragraph.hints.scrolls ?? []" :key="'s' + i"><button @click="scroll(s)">Свиток{{ s.caster ? ` ${casterName(s.caster)}а` : '' }}{{ s.level ? ` ${s.level} ур.` : '' }}</button></template>
          </div>
          <p v-if="lastLuck" class="small" style="color:#d7c56a;margin-top:.4rem">{{ lastLuck }}</p>
          <div v-if="isFinal" class="card tight" style="border-color:var(--accent);margin-top:.6rem">
            <h3>Схватка с Чёрным магом</h3>
            <p class="small muted">Попасть в мага — бросок удачи 15. При промахе маг бросает огненный шар: удача 11, иначе −1к18 жизней. Попадание — победа.</p>
            <div v-if="store.game?.victory"><b>Победа!</b> {{ store.game.victory.heroName }} сразил Чёрного мага на {{ store.game.victory.day }}-й день.</div>
            <div v-else class="row">
              <button class="primary" @click="finalAttack">⚔ Атаковать Чёрного мага (удача 15)</button>
            </div>
            <div class="row" style="margin-top:.4rem"><button class="small" @click="store.drinkFountain()">Выпить из фонтана (все жизни и мана)</button></div>
          </div>
          <details style="margin-top:.6rem"><summary class="small muted">Другие действия</summary>
            <div class="row" style="margin-top:.4rem">
              <button class="small" @click="trap">Ловушка/тайник найден (+400 вору)</button>
              <button class="small" @click="coins(-10)">−10 монет</button>
              <button class="small" @click="artifact">Артефакт</button>
              <button class="small" @click="scroll({})">Случайный свиток</button>
              <button class="small" @click="lives(-1)">−1 жизнь</button>
              <button class="small" @click="lives(-3)">−3 жизни</button>
              <button class="small" @click="lives(3)">+3 жизни</button>
            </div>
          </details>
        </div>
      </div>
    </div>
    <MonsterPicker v-if="picker" @close="picker = false" @start="startFight" />
  </template>
</template>
