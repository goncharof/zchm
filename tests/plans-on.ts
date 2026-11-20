// Включить размеченные планы локаций в тестовом файле (см. tests/setup.ts): beforeAll(enablePlans)
import { gameData, idx } from '@/data'

export function enablePlans(): void {
  for (const p of gameData.plans ?? []) idx.planById.set(p.id, p)
}
