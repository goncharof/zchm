<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import { idx } from '@/data'
import { shortestRoute } from '@/engine/world'
import { useGameStore } from '@/stores/game'
import { plural } from '@/ui/format'

const store = useGameStore()
const router = useRouter()
const mapSrc = `${import.meta.env.BASE_URL}img/map/world.jpg`
const selectedId = ref<string | null>(null)
const selected = computed(() => store.world?.nodes.find((n) => n.id === selectedId.value) ?? null)
const route = computed(() => (store.world && store.game?.worldNodeId && selectedId.value ? shortestRoute(store.world, store.game.worldNodeId, selectedId.value) : null))
const mounted = computed(() => store.heroes.length > 0 && store.heroes.every((h) => h.inventory.some((e) => e.kind === 'item' && e.ref === 'kon')))
const days = computed(() => (route.value ? (mounted.value ? Math.ceil(route.value.days / 2) : route.value.days) : 0))
const current = computed(() => store.worldNode)

function go() {
  if (!selectedId.value) return
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
      <div v-else class="map-wrap">
        <img :src="mapSrc" alt="Карта мира" />
        <button v-for="n in store.world.nodes" :key="n.id" class="map-node"
          :class="{ junction: !n.locationId, current: n.id === current?.id, selected: n.id === selectedId, 'anchor-left': !!n.locationId && n.x < 0.14, 'anchor-right': !!n.locationId && n.x > 0.86 }"
          :style="{ left: n.x * 100 + '%', top: n.y * 100 + '%' }" :title="n.name" @click="selectedId = n.id">
          <template v-if="n.locationId">{{ n.name }}</template>
        </button>
      </div>
    </div>
    <div>
      <div class="card">
        <h2>День {{ store.game?.day }}</h2>
        <p>Партия: <b>{{ current?.name ?? '—' }}</b></p>
        <button v-if="current?.locationId" class="primary" @click="enter(current.locationId)">Войти: {{ idx.locationById.get(current.locationId)?.name }}</button>
      </div>
      <div class="card" v-if="selected && selected.id !== current?.id">
        <h3>{{ selected.name }}</h3>
        <p v-if="route">Путь: {{ route.nodes.length - 1 }} {{ plural(route.nodes.length - 1, 'участок', 'участка', 'участков') }} дороги, <b>{{ days }} {{ plural(days, 'день', 'дня', 'дней') }}</b><span v-if="mounted"> (верхом)</span>.</p>
        <p v-else class="muted">Дороги туда нет.</p>
        <p class="small muted">Перемещаться можно только по дорогам, 1 клетка в день (верхом — 2). За каждый день пути возможна случайная встреча.</p>
        <button class="primary" :disabled="!route" @click="go">Отправиться</button>
      </div>
      <div class="card" v-if="store.game?.pendingRoad.length">
        <h3>Встречи в пути</h3>
        <p class="small muted">Прочитайте параграфы главы «Дорога»:</p>
        <div class="row">
          <button v-for="(n, i) in store.game.pendingRoad" :key="i" @click="router.push({ path: '/location/doroga', query: { p: n } })">Дорога {{ n }}</button>
        </div>
      </div>
      <div class="card tight">
        <h3>Локации</h3>
        <div class="row">
          <button v-for="l in idx.data.locations" :key="l.id" class="small" @click="router.push(`/location/${l.id}`)">{{ l.name }}</button>
        </div>
        <p class="small muted" style="margin-top:.4rem">Открыть описание можно из любого места; войти по правилам — с карты.</p>
      </div>
    </div>
  </div>
</template>
