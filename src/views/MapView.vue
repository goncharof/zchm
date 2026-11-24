<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { idx } from '@/data'
import { knownNodes, shortestRoute } from '@/engine/world'
import { useGameStore } from '@/stores/game'
import { plural } from '@/ui/format'
import HintTip from '@/components/HintTip.vue'

const store = useGameStore()
const router = useRouter()
const mapSrc = `${import.meta.env.BASE_URL}img/map/world.jpg`
const selectedId = ref<string | null>(null)
const selected = computed(() => store.world?.nodes.find((n) => n.id === selectedId.value) ?? null)
const route = computed(() => (store.world && store.game?.worldNodeId && selectedId.value ? shortestRoute(store.world, store.game.worldNodeId, selectedId.value) : null))
// верхом — если конь есть у каждого живого (как в движке: погибших везут)
const mounted = computed(() => {
  const living = store.heroes.filter((h) => !h.status.dead)
  return living.length > 0 && living.every((h) => h.inventory.some((e) => e.kind === 'item' && e.ref === 'kon'))
})
const flying = computed(() => !!store.game?.flight)
/** глава Книги Жизни этого места, если её название не совпадает с надписью на карте («Город Жрецов» — «Замок жрецов») */
const chapter = computed(() => {
  const name = selected.value?.locationId ? idx.locationById.get(selected.value.locationId)?.name : undefined
  return name && name.toLowerCase().replace(/ё/g, 'е') !== selected.value!.name.toLowerCase().replace(/ё/g, 'е') ? name : ''
})
const days = computed(() => (route.value ? (flying.value ? Math.ceil(route.value.days / 3) : mounted.value ? Math.ceil(route.value.days / 2) : route.value.days) : 0))
const how = computed(() => (flying.value ? 'на драконе' : mounted.value ? 'верхом' : ''))
const current = computed(() => store.worldNode)
// ХАУСРУЛ: карта открывается постепенно. Игроки видят места, где были, и куда от них ведут дороги; остальное — в тумане.
// Живой ведущий («Режим ведущего», хозяин комнаты с ведущим-человеком) видит карту целиком.
const fog = computed(() => !store.gmTools)
const knowledge = computed(() => (store.world && store.game ? knownNodes(store.world, store.game) : null))
const shownNodes = computed(() => (store.world?.nodes ?? []).filter((n) => !fog.value || !knowledge.value || knowledge.value.known.has(n.id)))
/** просветы в тумане: большой — где партия была, малый — куда ведёт дорога; по пройденным и известным дорогам — полоса.
 *  Координаты — в процентах ширины и высоты карты; ry учитывает, что карта не квадратная */
const clearings = computed(() => {
  const w = store.world
  const k = knowledge.value
  if (!w || !k) return { spots: [], roads: [] }
  const aspect = w.width / w.height
  const spots = w.nodes.filter((n) => k.known.has(n.id)).map((n) => { const r = k.seen.has(n.id) ? 13 : 7; return { id: n.id, x: n.x * 100, y: n.y * 100, rx: r, ry: r * aspect } })
  const byId = new Map(w.nodes.map((n) => [n.id, n]))
  const roads = w.edges.filter((e) => k.known.has(e.from) && k.known.has(e.to) && (k.seen.has(e.from) || k.seen.has(e.to)))
    .map((e) => { const a = byId.get(e.from)!; const b = byId.get(e.to)!; return [a.x * 100, a.y * 100, b.x * 100, b.y * 100] })
  return { spots, roads }
})
// нельзя уйти дальше, не разыграв встречи в пути (игроки проходят всё сами)
const roadFirst = computed(() => fog.value && (store.game?.pendingRoad.length ?? 0) > 0)

const routeSegments = computed(() => {
  if (!route.value || !store.world || route.value.nodes.length < 2) return []
  const byId = new Map(store.world.nodes.map((n) => [n.id, n]))
  const out: number[][] = []
  for (let i = 1; i < route.value.nodes.length; i++) {
    const a = byId.get(route.value.nodes[i - 1])!
    const b = byId.get(route.value.nodes[i])!
    out.push([a.x * 100, a.y * 100, b.x * 100, b.y * 100])
  }
  return out
})
// телефон: карта шире экрана — прокрутить к текущему узлу
const scroller = ref<HTMLElement | null>(null)
function centerOnParty() {
  const el = scroller.value
  const node = current.value
  if (!el || !node || el.scrollWidth <= el.clientWidth) return
  el.scrollLeft = Math.max(0, node.x * el.scrollWidth - el.clientWidth / 2)
}
onMounted(() => void nextTick(centerOnParty))
watch(() => [store.world, current.value?.id], () => void nextTick(centerOnParty))
function isVisited(locationId?: string) {
  return !!locationId && (store.game?.visited[locationId]?.length ?? 0) > 0
}
function go() {
  if (!selectedId.value || roadFirst.value) return
  store.travelTo(selectedId.value)
  selectedId.value = null
}
function enter(locationId: string) {
  store.enterLocation(locationId)
  router.push(`/location/${locationId}`)
}
</script>

<template>
  <p v-if="!store.heroes.length" class="muted">Сначала соберите партию.</p>
  <div v-else class="cols c21">
    <div>
      <div v-if="!store.world" class="card">Карта мира не загружена (нет src/data/world.json).</div>
      <div v-else ref="scroller" class="map-scroll">
      <div class="map-wrap">
        <img :src="mapSrc" alt="Карта мира" />
        <svg v-if="fog && knowledge" class="map-svg map-fog" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
          <defs>
            <radialGradient id="fog-hole"><stop offset="0" stop-color="#000" /><stop offset=".55" stop-color="#000" /><stop offset="1" stop-color="#000" stop-opacity="0" /></radialGradient>
            <mask id="fog-mask">
              <rect width="100" height="100" fill="#fff" />
              <line v-for="(r, i) in clearings.roads" :key="'r' + i" :x1="r[0]" :y1="r[1]" :x2="r[2]" :y2="r[3]" stroke="#000" stroke-width="5" stroke-linecap="round" />
              <ellipse v-for="s in clearings.spots" :key="s.id" :cx="s.x" :cy="s.y" :rx="s.rx" :ry="s.ry" fill="url(#fog-hole)" />
            </mask>
          </defs>
          <rect class="fog-fill" width="100" height="100" mask="url(#fog-mask)" />
        </svg>
        <svg class="map-svg" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
          <line v-for="(s, i) in routeSegments" :key="i" :x1="s[0]" :y1="s[1]" :x2="s[2]" :y2="s[3]" class="route-line" />
        </svg>
        <button v-for="n in shownNodes" :key="n.id" class="map-node"
          :class="{ junction: !n.locationId, current: n.id === current?.id, selected: n.id === selectedId, visited: isVisited(n.locationId), 'anchor-left': !!n.locationId && n.x < 0.14, 'anchor-right': !!n.locationId && n.x > 0.86 }"
          :style="{ left: n.x * 100 + '%', top: n.y * 100 + '%' }" :title="n.name" @click="selectedId = n.id">
          <template v-if="n.locationId">{{ n.name }}<span v-if="isVisited(n.locationId)" class="visited-mark"> ✓</span></template>
        </button>
      </div>
      </div>
      <p class="small muted map-hint">Карту можно листать вбок. Нажмите город, чтобы проложить путь.</p>
    </div>
    <div>
      <div class="card">
        <h2>День {{ store.game?.day }} <HintTip align="right" label="Как путешествовать">Перемещаться можно только по дорогам, 1 клетка в день (верхом — 2, на призрачном драконе — 3). За каждый день пути возможна случайная встреча.<template v-if="fog"> Карта открывается по мере пути: видны места, где партия была, и куда от них ведут дороги.</template></HintTip></h2>
        <p>Партия: <b>{{ current?.name ?? '—' }}</b></p>
        <p v-if="roadFirst" class="small" style="color:var(--note)">Сначала разыграйте встречи в пути.</p>
        <button v-else-if="current?.locationId" class="primary" @click="enter(current.locationId)">Войти: {{ idx.locationById.get(current.locationId)?.name }}</button>
      </div>
      <div class="card map-route-card" v-if="selected && selected.id !== current?.id">
        <h3>{{ selected.name }}<span v-if="chapter" class="small muted" style="font-family:var(--font);margin-left:.4rem">глава «{{ chapter }}»</span></h3>
        <p v-if="route">Путь: {{ route.nodes.length - 1 }} {{ plural(route.nodes.length - 1, 'участок', 'участка', 'участков') }} дороги, <b>{{ days }} {{ plural(days, 'день', 'дня', 'дней') }}</b><span v-if="how"> ({{ how }})</span>.</p>
        <p v-else class="muted">Дороги туда нет.</p>
        <button class="primary" :disabled="!route || roadFirst" @click="go">Отправиться</button>
      </div>
      <div class="card" v-if="store.game?.pendingRoad.length">
        <h3>Встречи в пути</h3>
        <p class="small muted">Прочитайте параграфы главы «Дорога»:</p>
        <div class="row">
          <button v-for="(n, i) in store.game.pendingRoad" :key="i" @click="router.push({ path: '/location/doroga', query: { p: n } })">Дорога {{ n }}</button>
        </div>
      </div>
      <!-- телефон: выбранный путь — плашкой над нижней панелью -->
      <div v-if="selected && selected.id !== current?.id" class="map-action">
        <div class="grow"><b>{{ selected.name }}</b><span v-if="chapter" class="small muted"> · «{{ chapter }}»</span><div class="small muted">{{ route ? `${days} ${plural(days, 'день', 'дня', 'дней')} пути${how ? `, ${how}` : ''}` : 'дороги туда нет' }}</div></div>
        <button class="ghost icon" aria-label="Отменить выбор" @click="selectedId = null">✕</button>
        <button class="primary" :disabled="!route || roadFirst" @click="go">Отправиться</button>
      </div>
      <!-- описание любой локации из любого места — инструмент ведущего: игроки читают только там, куда дошли -->
      <div v-if="store.gmTools" class="card tight">
        <h3>Локации</h3>
        <div class="row">
          <button v-for="l in idx.data.locations" :key="l.id" class="small" @click="router.push(`/location/${l.id}`)">{{ l.name }}</button>
        </div>
        <p class="small muted" style="margin-top:.4rem">Открыть описание можно из любого места; войти по правилам — с карты.</p>
      </div>
    </div>
  </div>
</template>
