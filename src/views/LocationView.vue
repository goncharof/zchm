<script setup lang="ts">
import { paragraphText } from '@/game/book'
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { idx } from '@/data'
import type { EncounterSpec } from '@/engine/combat'
import { SERVICES } from '@/engine/world'
import { useGameStore } from '@/stores/game'
import MonsterPicker from '@/components/MonsterPicker.vue'
import ParagraphActions from '@/components/ParagraphActions.vue'
import RollBlock from '@/components/RollBlock.vue'
import GmChat from '@/components/GmChat.vue'

const props = defineProps<{ id: string }>()
const store = useGameStore()
const route = useRoute()
const router = useRouter()
const loc = computed(() => idx.locationById.get(props.id))
const planSrc = computed(() => (loc.value?.plan ? `${import.meta.env.BASE_URL}${loc.value.plan}` : null))
const current = ref<number | null>(null)
const paragraph = computed(() => loc.value?.paragraphs.find((p) => p.n === current.value) ?? null)
const revealed = ref(false)
const fullText = ref(false)
const opened = ref<Set<number>>(new Set())
const heroUid = ref(store.heroes.find((h) => !h.status.dead)?.uid ?? '')
const picker = ref(false)
const visited = computed(() => store.game?.visited[props.id] ?? [])
const services = computed(() => SERVICES[props.id] ?? [])
const gm = computed(() => store.game?.gmMode ?? false)
const activeHeroes = computed(() => store.heroes.filter((h) => !h.status.dead))
const segments = computed(() => paragraph.value?.segments ?? null)
const isFinal = computed(() => props.id === 'zamok-chernogo-maga' && current.value === 13)
const lastFinal = ref('')
/** текст Книги Жизни скрыт: его читает ИИ-ведущий или живой ведущий */
const hideText = computed(() => store.aiGm || (store.online && !store.isGm))
const textCol = ref<HTMLElement | null>(null)
/** на телефоне текст параграфа ниже номеров — прокрутить к нему после выбора */
function revealText() {
  if (window.innerWidth > 900) return
  void nextTick(() => textCol.value?.scrollIntoView?.({ behavior: 'smooth', block: 'start' }))
}
function pick(n: number) {
  if (!hideText.value) { open(n); revealText(); return }
  current.value = n
  void store.sendChat(`Идём в помещение ${n}.`, store.aiGm)
}

function open(n: number) {
  current.value = n
  revealed.value = false
  fullText.value = false
  opened.value = new Set()
  lastFinal.value = ''
}
onMounted(() => {
  if (store.game && store.game.locationId !== props.id && props.id !== 'doroga' && store.worldNode?.locationId === props.id) store.enterLocation(props.id)
  const p = Number(route.query.p)
  if (p) open(p)
})
watch(() => route.query.p, (p) => { if (p) open(Number(p)) })

function toggleBranch(i: number, label?: string) {
  const s = new Set(opened.value)
  if (s.has(i)) s.delete(i)
  else {
    s.add(i)
    if (label && current.value) void store.note(`${loc.value?.name}, § ${current.value}: ${label}.`)
  }
  opened.value = s
}
function startFight(specs: EncounterSpec[]) {
  picker.value = false
  if (current.value) store.markVisited(props.id, current.value)
  store.startEncounter(specs, `/location/${props.id}${current.value ? `?p=${current.value}` : ''}`)
  router.push('/combat')
}
function done() {
  if (!current.value) return
  store.markVisited(props.id, current.value)
  if (props.id === 'doroga') store.dismissRoad(current.value)
}
function next() {
  if (!loc.value || current.value === null) return
  const i = loc.value.paragraphs.findIndex((p) => p.n === current.value)
  const nxt = loc.value.paragraphs[i + 1]
  done()
  if (nxt) open(nxt.n)
}
function leave() { store.leaveLocation(); router.push('/map') }
async function finalAttack() {
  if (!heroUid.value) return
  // зал с фонтаном считается пройденным, как только в нём начали схватку (иначе движок не пускает в дуэль)
  if (current.value) await store.markVisited(props.id, current.value)
  const won = await store.finalDuelAttack(heroUid.value)
  lastFinal.value = won ? 'Попадание! Чёрный маг повержен.' : 'Промах — маг отвечает огненным шаром (см. журнал).'
  if (won && current.value) store.markVisited(props.id, current.value)
}
async function fountain() {
  if (current.value) await store.markVisited(props.id, current.value)
  await store.drinkFountain()
}
function trap() { if (heroUid.value) store.trapFound(heroUid.value) }
function lives(n: number) { if (heroUid.value) store.adjustLives(heroUid.value, n) }
function coins(n: number) { if (heroUid.value) store.adjustMoney(heroUid.value, n) }
function artifact() { if (heroUid.value) store.findArtifact(heroUid.value) }
function scroll() { if (heroUid.value) store.giveScroll(heroUid.value) }
</script>

<template>
  <div v-if="!loc" class="card">Локация не найдена.</div>
  <template v-else>
    <div class="row between" style="margin-bottom:.6rem">
      <h1>{{ loc.name }} <span class="badge">Книга Жизни, стр. {{ loc.pages[0] }}–{{ loc.pages[1] }}</span> <span v-if="visited.length" class="badge accent">пройдено {{ visited.length }} из {{ loc.paragraphs.length }}</span></h1>
      <div class="row">
        <router-link v-if="services.includes('shop') || services.includes('tavern')" class="btn" to="/shop">Лавка / трактир</router-link>
        <button v-if="store.isGm && !store.aiGm" @click="picker = true">Произвольный бой</button>
        <button v-if="store.game?.locationId === id" @click="leave">Покинуть локацию</button>
        <router-link v-else class="btn" to="/map">Карта</router-link>
      </div>
    </div>
    <div v-if="id === 'doroga' && store.game?.pendingRoad.length" class="card tight row">
      <b>Встречи в пути:</b>
      <button v-for="(n, i) in store.game.pendingRoad" :key="i" class="small" @click="open(n)">§ {{ n }}</button>
    </div>
    <div class="loc-layout" :class="{ 'chat-first': hideText }">
      <div class="loc-nums">
        <div class="card tight">
          <div class="numgrid">
            <button v-for="p in loc.paragraphs" :key="p.n" :class="{ visited: visited.includes(p.n), active: p.n === current }" :title="hideText ? 'идти сюда' : p.segments ? 'есть выбор' : ''" @click="pick(p.n)">{{ p.n }}<sup v-if="p.segments && !hideText" style="color:var(--accent)">•</sup></button>
          </div>
          <p class="small muted" style="margin:.4rem 0 0">{{ hideText ? 'Нажмите номер, чтобы пойти в это помещение. Пройденные приглушены.' : id === 'doroga' ? 'Ведущий выбирает любое приключение из главы «Дорога».' : 'Номера соответствуют плану локации. Пройденные приглушены, точкой отмечены параграфы с выбором.' }}</p>
        </div>
      </div>
      <div v-if="planSrc" class="loc-plan">
        <div class="card tight"><a :href="planSrc" target="_blank" rel="noopener" title="Открыть план целиком"><img class="plan-img" :src="planSrc" :alt="`План: ${loc.name}`" /></a></div>
      </div>
      <div ref="textCol" class="loc-text">
        <div v-if="hideText" class="card">
          <template v-if="store.aiGm">
            <h3>Ведущий</h3>
            <p class="small muted">Нажмите номер помещения на плане или напишите, что делают герои.</p>
            <GmChat height="58vh" />
          </template>
          <template v-else>
            <h3>Текст читает ведущий</h3>
            <p class="small muted">Номера на плане — куда вы идёте; ведущий описывает, что вы видите, и разыгрывает события.</p>
            <GmChat height="40vh" />
          </template>
        </div>
        <div v-else-if="!paragraph" class="card muted">Выберите номер параграфа.</div>
        <div v-else class="card">
          <div class="row between">
            <h2>§ {{ paragraph.n }}</h2>
            <div class="row">
              <label class="row small" style="gap:.3rem">Действует
                <select v-model="heroUid" class="small"><option v-for="h in activeHeroes" :key="h.uid" :value="h.uid">{{ h.name }}</option></select>
              </label>
            </div>
          </div>

          <div v-if="gm && !revealed" class="row"><span class="muted">Режим ведущего: текст скрыт от игроков.</span><button class="small" @click="revealed = true">Показать текст</button></div>
          <template v-else-if="segments && !fullText">
            <template v-for="(seg, i) in segments" :key="i">
              <div v-if="seg.kind === 'scene'">
                <template v-for="(b, j) in seg.blocks" :key="j">
                  <p v-if="'text' in b" class="paragraph-text">{{ b.text }}</p>
                  <RollBlock v-else :options="b.roll" :repeat="b.repeat" :context="`${loc.name}, § ${paragraph.n}`" :hero-uid="heroUid" :place="`${loc.id}:${paragraph.n}:${i}:${j}`" @fight="startFight" />
                </template>
                <ParagraphActions :hints="seg.hints" :hero-uid="heroUid" :place="`${loc.id}:${paragraph.n}:${i}`" @fight="startFight" />
              </div>
              <p v-else-if="!seg.blocks.length" class="paragraph-text muted" style="font-style:italic">{{ seg.label }}.</p>
              <div v-else class="branch" :class="{ open: opened.has(i) }">
                <button class="branch-head" @click="toggleBranch(i, seg.label)">{{ opened.has(i) ? '▾' : '▸' }} {{ seg.label }}</button>
                <div v-if="opened.has(i)" class="branch-body">
                  <template v-for="(b, j) in seg.blocks" :key="j">
                    <p v-if="'text' in b" class="paragraph-text">{{ b.text }}</p>
                    <RollBlock v-else :options="b.roll" :repeat="b.repeat" :context="`${loc.name}, § ${paragraph.n}`" :hero-uid="heroUid" :place="`${loc.id}:${paragraph.n}:${i}:${j}`" @fight="startFight" />
                  </template>
                  <ParagraphActions :hints="seg.hints" :hero-uid="heroUid" :place="`${loc.id}:${paragraph.n}:${i}`" @fight="startFight" />
                </div>
              </div>
            </template>
            <p class="small muted" style="margin-top:.5rem">Выберите, что делает партия: исход ветки откроется по нажатию.</p>
          </template>
          <template v-else>
            <p class="paragraph-text">{{ paragraphText(paragraph) }}</p>
            <!-- полный текст: действия — по частям параграфа с теми же отметками, что и в разбивке; исходы бросков — только броском -->
            <template v-if="segments">
              <template v-for="(seg, i) in segments" :key="'fa' + i"><ParagraphActions v-if="seg.hints" :hints="seg.hints" :hero-uid="heroUid" :place="`${loc.id}:${paragraph.n}:${i}`" @fight="startFight" /></template>
            </template>
            <ParagraphActions v-else :hints="paragraph.hints" :hero-uid="heroUid" :place="`${loc.id}:${paragraph.n}:p`" @fight="startFight" />
          </template>

          <div v-if="isFinal" class="card tight" style="border-color:var(--accent);margin-top:.6rem">
            <h3>Схватка с Чёрным магом</h3>
            <p class="small muted">Попасть в мага — бросок удачи 15. При промахе маг бросает огненный шар: удача 11, иначе −1к18 жизней. Попадание — победа.</p>
            <div v-if="store.game?.victory"><b>Победа!</b> {{ store.game.victory.heroName }} сразил Чёрного мага на {{ store.game.victory.day }}-й день.</div>
            <button v-else class="primary" @click="finalAttack">⚔ Атаковать Чёрного мага (удача 15)</button>
            <p v-if="lastFinal" class="small" style="color:var(--note);margin:.3rem 0 0">{{ lastFinal }}</p>
            <div class="row" style="margin-top:.4rem"><button class="small" @click="fountain">Выпить из фонтана (все жизни и мана)</button></div>
          </div>
          <div v-else-if="id === 'krepost-korolya-nazgulov' && current === 22" class="row" style="margin-top:.6rem">
            <button class="small" @click="fountain">Выпить из фонтана (+5 жизней каждому)</button>
          </div>

          <div class="row" style="margin-top:.8rem">
            <button class="small" @click="done">Отметить пройденным</button>
            <button class="small" @click="next">Дальше →</button>
            <button v-if="segments && (!gm || revealed)" class="small" @click="fullText = !fullText">{{ fullText ? 'По веткам' : 'Весь текст' }}</button>
          </div>
          <details style="margin-top:.6rem"><summary class="small muted">Другие действия</summary>
            <div class="row" style="margin-top:.4rem">
              <button class="small" @click="trap">Ловушка/тайник найден (+400)</button>
              <button class="small" @click="coins(-10)">−10 монет</button>
              <button class="small" @click="coins(10)">+10 монет</button>
              <button class="small" @click="artifact">Артефакт</button>
              <button class="small" @click="scroll">Случайный свиток</button>
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
