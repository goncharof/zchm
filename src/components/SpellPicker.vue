<script setup lang="ts">
import { computed } from 'vue'
import { gameData, idx } from '@/data'
import type { Hero } from '@/engine/model'
import { useGameStore } from '@/stores/game'

const props = defineProps<{ hero: Hero }>()
const emit = defineEmits<{ close: [] }>()
const store = useGameStore()
const caster = computed(() => idx.cls(props.hero.classId).caster)
const options = computed(() => gameData.spells.filter((s) => s.caster === caster.value && s.level <= props.hero.level && !props.hero.spellbook.includes(s.id)))
function pick(id: string) {
  try { store.learnSpell(props.hero.uid, id) } catch (e) { store.say((e as Error).message) }
  if (props.hero.pendingSpellPicks <= 0) emit('close')
}
</script>

<template>
  <div class="modal-back" @click.self="emit('close')">
    <div class="modal">
      <div class="row between">
        <h3>{{ hero.name }}: новое заклинание (осталось выборов: {{ hero.pendingSpellPicks }})</h3>
        <button class="small" @click="emit('close')">Позже</button>
      </div>
      <p class="muted small">ХАУСРУЛ: при переходе на уровень кастер записывает в книгу одно заклинание уровня не выше своего.</p>
      <table class="list">
        <thead><tr><th>Ур.</th><th>Заклинание</th><th>Мана</th><th>Описание</th><th></th></tr></thead>
        <tbody>
          <tr v-for="s in options" :key="s.id">
            <td>{{ s.level }}</td><td><b>{{ s.name }}</b></td><td>{{ s.cost ?? s.costFormula }}</td>
            <td class="small muted">{{ s.description }}</td>
            <td><button class="small primary" @click="pick(s.id)">Выучить</button></td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
