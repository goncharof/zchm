<script setup lang="ts">
import { paragraphText } from '@/game/book'
import { allNodes, paragraphTree } from '@/game/tree'
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { LogOut, Map as MapIcon, Store, Swords } from 'lucide-vue-next'
import { idx } from '@/data'
import type { EncounterSpec } from '@/engine/combat'
import { SERVICES } from '@/engine/world'
import { useGameStore } from '@/stores/game'
import MonsterPicker from '@/components/MonsterPicker.vue'
import ParagraphActions from '@/components/ParagraphActions.vue'
import BookStages from '@/components/BookStages.vue'
import { reminders } from '@/game/referee'
import { REL_GO, describeExits, isYard, lookAround, roomOf } from '@/engine/plans'
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
const heroUid = ref(store.heroes.find((h) => !h.status.dead)?.uid ?? '')
const picker = ref(false)
const visited = computed(() => store.game?.visited[props.id] ?? [])
const services = computed(() => SERVICES[props.id] ?? [])
const gm = computed(() => store.game?.gmMode ?? false)
const activeHeroes = computed(() => store.heroes.filter((h) => !h.status.dead))
/** этапы параграфа (src/game/tree.ts): у параграфа без выбора — один этап */
const nodes = computed(() => (paragraph.value ? allNodes(paragraphTree(paragraph.value)) : []))
const staged = computed(() => nodes.value.length > 1)
const isFinal = computed(() => props.id === 'zamok-chernogo-maga' && current.value === 13)
const lastFinal = ref('')
/** текст Книги Жизни скрыт: его читает ИИ-ведущий или живой ведущий */
const hideText = computed(() => store.aiGm || (store.online && !store.isGm))
/** ручные инструменты ведущего («Отметить пройденным», «Весь текст», правка жизней и монет): игрокам недоступны —
 *  книгу проходят сами, без обходов */
const tools = computed(() => store.gmTools)
/** читать можно там, где партия: в своей локации; глава «Дорога» — только выпавшие встречи в пути */
const here = computed(() => tools.value || props.id === 'doroga' || store.game?.locationId === props.id)
// встреча в пути, которую партия сейчас разыгрывает: из списка ожидающих она уходит, как только открыта,
// а после боя к ней возвращаются — номер помнит вкладка
const ROAD_KEY = 'zchm.road.open'
function roadOpen(): number | null { try { return Number(sessionStorage.getItem(ROAD_KEY)) || null } catch { return null } }
function canOpen(n: number): boolean {
  if (tools.value) return true
  if (!here.value) return false
  return props.id !== 'doroga' || !!store.game?.pendingRoad.includes(n) || roadOpen() === n
}
/** план локации как граф помещений. ХАУСРУЛ: игроки идут из помещения в соседнее и видят только выходы оттуда, где
 *  стоят; ведущий с инструментами и локация без разметки плана — по номерам, как раньше */
const plan = computed(() => idx.planById.get(props.id) ?? null)
const walk = computed(() => !!plan.value && !tools.value && props.id !== 'doroga')
/** помещение, где стоит партия (null — у входа в локацию) */
const room = computed(() => (store.game?.locationId === props.id ? store.game.room ?? null : null))
const exits = computed(() => (walk.value && plan.value ? lookAround(plan.value, room.value, store.game?.heading, visited.value) : []))
const around = computed(() => describeExits(exits.value))
/** «Площадь, § 41.» — где партия стоит */
const hereTitle = computed(() => {
  const r = plan.value ? roomOf(plan.value, room.value) : undefined
  if (!r) return 'Вы у входа.'
  const kind = `${r.kind[0].toUpperCase()}${r.kind.slice(1)}`
  // у двора и перекрёстка параграфа нет — называем только место
  return isYard(r.n) ? `${kind}.` : `${kind}, § ${r.n}.`
})
/** подпись помещения, куда можно вернуться: номер параграфа, у места без параграфа — его название */
const backLabel = (n: number) => (isYard(n) ? roomOf(plan.value!, n)?.kind ?? 'двор' : String(n))
/** сколько параграфов локации партия прошла (дворы без параграфа не считаются) */
const visitedCount = computed(() => visited.value.filter((n) => n > 0).length)
/** куда можно вернуться: помещения, где партия уже была */
const back = computed(() => [...visited.value].filter((n) => n !== room.value).sort((a, b) => a - b))
/** просветы в тумане над планом: помещения, где партия была; координаты — проценты ширины и высоты картинки */
const PLAN_ASPECT = 1087 / 1654
const spots = computed(() => {
  if (!walk.value || !plan.value) return []
  const big = /площад|двор|улиц|полян|озер|мор|берег|поле/
  return visited.value.map((n) => roomOf(plan.value!, n)).filter((r) => !!r).map((r) => { const rx = big.test(r!.kind) ? 12 : 8; return { n: r!.n, x: r!.x * 100, y: r!.y * 100, rx, ry: rx * PLAN_ASPECT } })
})
const hereSpot = computed(() => (walk.value && plan.value ? roomOf(plan.value, room.value) ?? null : null))
/** ведущему: связи помещений поверх плана — чтобы разметку (tools/plans) можно было проверить глазами */
const showLinks = ref(false)
const planLinks = computed(() => {
  if (!plan.value) return []
  const out: { key: string; x1: number; y1: number; x2: number; y2: number; door: boolean }[] = []
  for (const r of plan.value.rooms) for (const e of r.exits) {
    const b = roomOf(plan.value, e.to)
    // связь в обе стороны рисуется один раз; односторонняя — от своего помещения
    if (!b || (r.n > e.to && b.exits.some((x) => x.to === r.n))) continue
    out.push({ key: `${r.n}-${e.to}-${e.via}`, x1: r.x * 100, y1: r.y * 100, x2: b.x * 100, y2: b.y * 100, door: e.via !== 'проход' })
  }
  return out
})
/** перейти в помещение по плану: с ведущим — сказать ему, куда идём; без него — команда партии */
async function go(n: number) {
  // сценарный ведущий: переход, а за столом из нескольких игроков — предложение команде (отсчёт в чате)
  if (hideText.value && store.room?.gm === 'script') { void store.moveRoom(n); return }
  // ИИ-ведущему и живому ведущему говорим словами, куда идём
  if (hideText.value) { void store.sendChat(n > 0 ? `Идём в помещение ${n}.` : 'Идём туда.', store.aiGm); return }
  if (await store.cmdOk('moveTo', n)) revealText()
}
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
  // по плану открытый параграф — это помещение, где стоит партия: «открыть» значит перейти туда
  if (walk.value && !hideText.value) { if (n !== room.value) void go(n); return }
  if (!canOpen(n)) return
  current.value = n
  revealed.value = false
  fullText.value = false
  lastFinal.value = ''
  // игроки помещения сами не отмечают: вошли — значит, были; встреча в пути считается состоявшейся
  if (!tools.value && !hideText.value) {
    if (!visited.value.includes(n)) void store.markVisited(props.id, n)
    if (props.id === 'doroga' && store.game?.pendingRoad.includes(n)) {
      try { sessionStorage.setItem(ROAD_KEY, String(n)) } catch { /* без хранилища к встрече не вернуться после боя */ }
      void store.dismissRoad(n)
    }
  }
}
onMounted(async () => {
  if (store.game && store.game.locationId !== props.id && props.id !== 'doroga' && store.worldNode?.locationId === props.id) await store.enterLocation(props.id)
  const p = Number(route.query.p)
  if (p) open(p)
})
// по плану текст показывает то помещение, где партия стоит (в сетевой игре её ведёт любой из игроков)
watch([walk, room, hideText], () => {
  if (!walk.value || hideText.value) return
  if (current.value === room.value) return
  current.value = room.value
  revealed.value = false
  fullText.value = false
  lastFinal.value = ''
}, { immediate: true })
watch(() => route.query.p, (p) => { if (p) open(Number(p)) })

/** напоминания-рефери: герой при смерти, яд, не выбрано заклинание (src/game/referee.ts) */
const notes = computed(() => (store.game ? reminders(store.game) : []))
/** бой начат сам — по книге монстры нападают: экран боя не открывается, чтобы сцену можно было дочитать */
function startAmbush(specs: EncounterSpec[], place: string) {
  if (current.value) store.markVisited(props.id, current.value)
  void store.startEncounter(specs, `/location/${props.id}${current.value ? `?p=${current.value}` : ''}`, place)
}
/** place — этап книги, где начат бой: его итог откроет исходы этапа */
function startFight(specs: EncounterSpec[], place?: string) {
  picker.value = false
  if (current.value) store.markVisited(props.id, current.value)
  store.startEncounter(specs, `/location/${props.id}${current.value ? `?p=${current.value}` : ''}`, place)
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
      <h1>{{ loc.name }} <span class="badge">Книга Жизни, стр. {{ loc.pages[0] }}–{{ loc.pages[1] }}</span> <span v-if="visitedCount" class="badge accent">пройдено {{ visitedCount }} из {{ loc.paragraphs.length }}</span></h1>
      <div class="row loc-tools">
        <router-link v-if="services.includes('shop') || services.includes('tavern')" class="btn" to="/shop" aria-label="Лавка и трактир"><Store :size="16" aria-hidden="true" /><span>Лавка<span class="hide-phone"> / трактир</span></span></router-link>
        <button v-if="tools" aria-label="Произвольный бой" title="Бой с любыми монстрами из Бестиария" @click="picker = true"><Swords :size="16" aria-hidden="true" /><span class="hide-phone">Произвольный бой</span><span class="phone-only">Бой</span></button>
        <button v-if="store.game?.locationId === id" aria-label="Покинуть локацию" @click="leave"><LogOut :size="16" aria-hidden="true" /><span>Покинуть<span class="hide-phone"> локацию</span></span></button>
        <router-link v-else class="btn" to="/map"><MapIcon :size="16" aria-hidden="true" />Карта</router-link>
      </div>
    </div>
    <div v-if="store.game?.combat && !store.game.combat.finished" class="card tight row between">
      <span><b>⚔ Идёт бой</b> — противники ждут на экране боя.</span>
      <router-link class="btn small danger" to="/combat">На экран боя</router-link>
    </div>
    <div v-if="notes.length" class="card tight small"><b>Напоминание:</b> {{ notes.join(' ') }}</div>
    <div v-if="id === 'doroga' && store.game?.pendingRoad.length" class="card tight row">
      <b>Встречи в пути:</b>
      <button v-for="(n, i) in store.game.pendingRoad" :key="i" class="small" @click="open(n)">§ {{ n }}</button>
    </div>
    <div v-if="!here" class="card">
      <p>Партия не в этой локации. Войти можно с карты, когда партия до неё дойдёт.</p>
      <router-link class="btn" to="/map"><MapIcon :size="16" aria-hidden="true" />К карте</router-link>
    </div>
    <div v-else class="loc-layout" :class="{ 'chat-first': hideText }">
      <div class="loc-nums">
        <div v-if="id === 'doroga' && !tools && !hideText" class="card tight">
          <p class="small muted" style="margin:0">{{ store.game?.pendingRoad.length ? 'В пути случились встречи — откройте их по порядку.' : paragraph ? 'Встреча в пути. Когда она разыграна, возвращайтесь к карте.' : 'Встреч в пути нет.' }}</p>
        </div>
        <div v-else-if="walk" class="card tight">
          <p style="margin:0 0 .5rem"><b>{{ hereTitle }}</b> {{ around }}</p>
          <div class="row exits">
            <button v-for="e in exits" :key="e.to" class="small" :class="{ ghost: e.known }" @click="go(e.to)">{{ REL_GO[e.rel] }}: {{ e.what }}<span v-if="e.known && !isYard(e.to)"> · § {{ e.to }}</span></button>
          </div>
          <template v-if="back.length">
            <p class="small muted" style="margin:.6rem 0 .3rem">Вернуться туда, где партия уже была:</p>
            <div class="numgrid back"><button v-for="n in back" :key="n" class="visited" @click="go(n)">{{ backLabel(n) }}</button></div>
          </template>
          <p class="small muted" style="margin:.5rem 0 0">Идти можно в соседнее помещение или вернуться в пройденное. План открывается по мере пути.</p>
        </div>
        <div v-else class="card tight">
          <div class="numgrid">
            <button v-for="p in loc.paragraphs" :key="p.n" :class="{ visited: visited.includes(p.n), active: p.n === current }" :title="hideText ? 'идти сюда' : tools && (p.segments || p.tree) ? 'есть выбор' : ''" @click="pick(p.n)">{{ p.n }}<sup v-if="tools && (p.segments || p.tree) && !hideText" style="color:var(--accent)">•</sup></button>
          </div>
          <p class="small muted" style="margin:.4rem 0 0">{{ hideText ? 'Нажмите номер, чтобы пойти в это помещение. Пройденные приглушены.' : !tools ? 'Номера соответствуют плану локации. Приглушены помещения, где партия уже была.' : id === 'doroga' ? 'Ведущий выбирает любое приключение из главы «Дорога».' : 'Номера соответствуют плану локации. Пройденные приглушены, точкой отмечены параграфы с выбором.' }}</p>
        </div>
      </div>
      <div v-if="planSrc" class="loc-plan">
        <div v-if="walk" class="card tight">
          <div class="plan-wrap">
            <img class="plan-img" :src="planSrc" :alt="`План: ${loc.name}`" />
            <svg class="map-svg map-fog" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
              <defs>
                <radialGradient id="plan-hole"><stop offset="0" stop-color="#000" /><stop offset=".6" stop-color="#000" /><stop offset="1" stop-color="#000" stop-opacity="0" /></radialGradient>
                <mask id="plan-mask">
                  <rect width="100" height="100" fill="#fff" />
                  <ellipse v-for="s in spots" :key="s.n" :cx="s.x" :cy="s.y" :rx="s.rx" :ry="s.ry" fill="url(#plan-hole)" />
                </mask>
              </defs>
              <rect class="fog-fill" width="100" height="100" mask="url(#plan-mask)" />
              <ellipse v-if="hereSpot" class="plan-here" :cx="hereSpot.x * 100" :cy="hereSpot.y * 100" rx="2.6" :ry="2.6 * PLAN_ASPECT" />
            </svg>
          </div>
        </div>
        <div v-else class="card tight">
          <div class="plan-wrap">
            <a :href="planSrc" target="_blank" rel="noopener" title="Открыть план целиком"><img class="plan-img" :src="planSrc" :alt="`План: ${loc.name}`" /></a>
            <svg v-if="showLinks && plan" class="map-svg" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
              <line v-for="l in planLinks" :key="l.key" :x1="l.x1" :y1="l.y1" :x2="l.x2" :y2="l.y2" class="plan-link" :class="{ door: l.door }" />
              <ellipse v-for="r in plan.rooms" :key="r.n" :cx="r.x * 100" :cy="r.y * 100" rx=".55" :ry=".55 * PLAN_ASPECT" class="plan-dot" />
            </svg>
          </div>
          <label v-if="plan && tools" class="row small" style="gap:.4rem;margin-top:.4rem"><input v-model="showLinks" type="checkbox" /> показать связи помещений (красные — двери и лестницы, зелёные — открытые проходы)</label>
        </div>
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
        <div v-else-if="!paragraph" class="card muted">{{ !walk ? 'Выберите номер параграфа.' : isYard(room) ? `${hereTitle} Здесь тихо — выберите, куда идти дальше.` : 'Партия у входа в локацию. Выберите, куда идти.' }}</div>
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
          <template v-else-if="!fullText">
            <BookStages :loc="loc.id" :loc-name="loc.name" :paragraph="paragraph" :hero-uid="heroUid" @fight="startFight" @ambush="startAmbush" @goto="(n) => { if (!walk) done(); open(n) }" />
            <p v-if="staged" class="small muted" style="margin-top:.5rem">Варианты со стрелкой — выбор партии. Исходы боя, проверки удачи и броска откроются сами.</p>
          </template>
          <template v-else>
            <p class="paragraph-text">{{ paragraphText(paragraph) }}</p>
            <!-- полный текст: действия — по этапам с теми же отметками, что и при показе по этапам; исходы бросков — только броском -->
            <template v-for="n in nodes" :key="'fa' + n.id"><ParagraphActions v-if="n.hints && typeof n.on !== 'object'" :hints="n.hints" :hero-uid="heroUid" :place="`${loc.id}:${paragraph.n}:${n.id}`" @fight="(s) => startFight(s, `${loc!.id}:${paragraph!.n}:${n.id}`)" /></template>
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

          <!-- ручные инструменты ведущего: игроки проходят параграф по этапам, без «пропустить» и правки героев -->
          <div v-if="tools" class="row" style="margin-top:.8rem">
            <button class="small" @click="done">Отметить пройденным</button>
            <button class="small" @click="next">Дальше →</button>
            <button v-if="staged && (!gm || revealed)" class="small" @click="fullText = !fullText">{{ fullText ? 'По этапам' : 'Весь текст' }}</button>
          </div>
          <details v-if="tools" style="margin-top:.6rem"><summary class="small muted">Другие действия</summary>
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
