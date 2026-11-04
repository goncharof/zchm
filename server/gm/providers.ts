/**
 * Цепочка моделей ИИ-ведущего из переменных окружения.
 * Провайдер включается, если задан его ключ (для своей модели — адрес). Порядок перебора — GM_CHAIN.
 * Бесплатные тарифы и названия моделей часто меняются: модель каждого провайдера можно переопределить.
 *
 *   GEMINI_API_KEY      [GEMINI_MODEL=gemini-3.5-flash]                  — Google AI Studio, бесплатный уровень; можно списком через
 *                       запятую (у каждой модели своя квота). flash-lite не держит правила, 3.8-flash медленная
 *   GROQ_API_KEY        [GROQ_MODEL=openai/gpt-oss-120b]                 — Groq, бесплатный уровень: 8000 токенов в минуту
 *   CEREBRAS_API_KEY    [CEREBRAS_MODEL=gpt-oss-120b]                    — Cerebras: бесплатного уровня нет (с 2026 — $5 на 30 дней
 *                       после привязки карты, 5 запросов в минуту), не проверено
 *   MISTRAL_API_KEY     [MISTRAL_MODEL=mistral-small-latest]            — Mistral, бесплатный тариф Experiment (телефон, согласие на
 *                       обучение; по сторонним данным ~1 запрос/с и 1 млрд токенов в месяц) — не проверено (2026-11-03)
 *   OPENROUTER_API_KEY  [OPENROUTER_MODEL=nvidia/nemotron-3-super-120b-a12b:free] — OpenRouter, модели :free с поддержкой tools
 *   Модели по умолчанию проверены 2026-10-17; список бесплатных моделей OpenRouter: https://openrouter.ai/api/v1/models
 *   LLM_BASE_URL + LLM_MODEL [LLM_API_KEY, LLM_LABEL] — любая OpenAI-совместимая модель (например, Ollama: http://localhost:11434/v1)
 *   ANTHROPIC_API_KEY   [GM_MODEL=claude-opus-5-5, GM_EFFORT=medium]     — Claude API, платный
 *   GM_CHAIN=gemini,mistral,cerebras,openrouter,groq,custom,claude       — порядок; если не ответил никто — сценарный ведущий
 */
import { AnthropicProvider } from './ai'
import { OpenAiCompatProvider } from './openai'
import type { LlmProvider } from './types'

type Env = Record<string, string | undefined>

// порядок по живому прогону: Gemini лучше всех, но 20 запросов в день на модель; OpenRouter (Nemotron) держит правила;
// Groq упирается в лимит токенов в минуту (~ход в минуту) — ближе к концу
export const DEFAULT_CHAIN = ['gemini', 'mistral', 'cerebras', 'openrouter', 'groq', 'custom', 'claude']

export function buildProvidersFromEnv(env: Env = process.env): LlmProvider[] {
  // у каждой модели Gemini своя бесплатная квота (у gemini-3.5-flash — 5 запросов в минуту): GEMINI_MODEL можно
  // задать списком через запятую — модели встанут в цепочку по порядку, каждая со своей историей
  const geminiModels = (env.GEMINI_MODEL || 'gemini-3.5-flash').split(',').map((s) => s.trim()).filter(Boolean)
  const make: Record<string, () => LlmProvider | LlmProvider[] | null> = {
    gemini: () => (env.GEMINI_API_KEY || env.GOOGLE_API_KEY)
      ? geminiModels.map((model, i) => new OpenAiCompatProvider({ id: i ? `gemini-${model}` : 'gemini', label: i ? `Gemini ${model.replace(/^gemini-/, '')}` : 'Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', apiKey: env.GEMINI_API_KEY || env.GOOGLE_API_KEY, model, usage: true, maxRetryWaitMs: 60_000, extraBody: { reasoning_effort: env.GEMINI_REASONING || 'low' } }))
      : null,
    groq: () => {
      if (!env.GROQ_API_KEY) return null
      // бесплатный Groq: 8000 токенов в минуту на модель — короткое окно истории и ответ, рассуждения gpt-oss покороче
      const model = env.GROQ_MODEL || 'openai/gpt-oss-120b'
      return new OpenAiCompatProvider({ id: 'groq', label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', apiKey: env.GROQ_API_KEY, model, historyLimit: 12, maxTokens: 800, usage: true, ...(model.includes('gpt-oss') ? { extraBody: { reasoning_effort: env.GROQ_REASONING || 'low' } } : {}) })
    },
    mistral: () => env.MISTRAL_API_KEY
      ? new OpenAiCompatProvider({ id: 'mistral', label: 'Mistral', baseUrl: 'https://api.mistral.ai/v1', apiKey: env.MISTRAL_API_KEY, model: env.MISTRAL_MODEL || 'mistral-small-latest', historyLimit: 30, usage: true })
      : null,
    cerebras: () => env.CEREBRAS_API_KEY
      ? new OpenAiCompatProvider({ id: 'cerebras', label: 'Cerebras', baseUrl: 'https://api.cerebras.ai/v1', apiKey: env.CEREBRAS_API_KEY, model: env.CEREBRAS_MODEL || 'gpt-oss-120b', historyLimit: 30, usage: true })
      : null,
    openrouter: () => env.OPENROUTER_API_KEY
      ? new OpenAiCompatProvider({ id: 'openrouter', label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', apiKey: env.OPENROUTER_API_KEY, model: env.OPENROUTER_MODEL || 'nvidia/nemotron-3-super-120b-a12b:free', historyLimit: 30, usage: true })
      : null,
    custom: () => env.LLM_BASE_URL && env.LLM_MODEL
      ? new OpenAiCompatProvider({ id: 'custom', label: env.LLM_LABEL || 'своя модель', baseUrl: env.LLM_BASE_URL, apiKey: env.LLM_API_KEY, model: env.LLM_MODEL, timeoutMs: 180_000 })
      : null,
    claude: () => (env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN) ? new AnthropicProvider() : null,
  }
  const order = (env.GM_CHAIN ? env.GM_CHAIN.split(',') : DEFAULT_CHAIN).map((s) => s.trim().toLowerCase()).filter(Boolean)
  return order.flatMap((id) => {
    const p = make[id]?.()
    return p ? (Array.isArray(p) ? p : [p]) : []
  })
}
