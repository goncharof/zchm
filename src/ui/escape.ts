import { onBeforeUnmount, onMounted } from 'vue'

/** Esc закрывает окно, пока компонент на экране */
export function onEscape(close: () => void) {
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close() }
  onMounted(() => document.addEventListener('keydown', onKey))
  onBeforeUnmount(() => document.removeEventListener('keydown', onKey))
}
