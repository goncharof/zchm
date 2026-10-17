/**
 * Цепочка моделей ИИ-ведущего из переменных окружения.
 * Провайдер включается, если задан его ключ (для своей модели — адрес). Порядок перебора — GM_CHAIN.
 * Бесплатные тарифы и названия моделей часто меняются: модель каждого провайдера можно переопределить.
 *
 *   GEMINI_API_KEY      [GEMINI_MODEL=gemini-3.5-flash]                  — Google AI Studio, бесплатный уровень (3.8-flash там же, но медленный)
 *   GROQ_API_KEY        [GROQ_MODEL=openai/gpt-oss-120b]                 — Groq, бесплатный уровень: 8000 токенов в минуту
 *   CEREBRAS_API_KEY    [CEREBRAS_MODEL=gpt-oss-120b]                    — Cerebras, бесплатный уровень (не проверено)
 *   OPENROUTER_API_KEY  [OPENROUTER_MODEL=nvidia/nemotron-3-super-120b-a12b:free] — OpenRouter, модели :free с поддержкой tools
 *   Модели по умолчанию проверены 2026-10-17; список бесплатных моделей OpenRouter: https://openrouter.ai/api/v1/models
 *   LLM_BASE_URL + LLM_MODEL [LLM_API_KEY, LLM_LABEL] — любая OpenAI-совместимая модель (например, Ollama: http://localhost:11434/v1)
 *   ANTHROPIC_API_KEY   [GM_MODEL=claude-opus-5-5, GM_EFFORT=medium]     — Claude API, платный
 *   GM_CHAIN=gemini,groq,cerebras,openrouter,custom,claude               — порядок; если не ответил никто — сценарный ведущий
 */
import { AnthropicProvider } from './ai'
import { OpenAiCompatProvider } from './openai'
import type { LlmProvider } from './types'

type Env = Record<string, string | undefined>

export const DEFAULT_CHAIN = ['gemini', 'groq', 'cerebras', 'openrouter', 'custom', 'claude']

export function buildProvidersFromEnv(env: Env = process.env): LlmProvider[] {
  const make: Record<string, () => LlmProvider | null> = {
    gemini: () => (env.GEMINI_API_KEY || env.GOOGLE_API_KEY)
      ? new OpenAiCompatProvider({ id: 'gemini', label: 'Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', apiKey: env.GEMINI_API_KEY || env.GOOGLE_API_KEY, model: env.GEMINI_MODEL || 'gemini-3.5-flash', usage: true, extraBody: { reasoning_effort: env.GEMINI_REASONING || 'low' } })
      : null,
    groq: () => {
      if (!env.GROQ_API_KEY) return null
      // бесплатный Groq: 8000 токенов в минуту на модель — короткое окно истории и ответ, рассуждения gpt-oss покороче
      const model = env.GROQ_MODEL || 'openai/gpt-oss-120b'
      return new OpenAiCompatProvider({ id: 'groq', label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', apiKey: env.GROQ_API_KEY, model, historyLimit: 12, maxTokens: 800, usage: true, ...(model.includes('gpt-oss') ? { extraBody: { reasoning_effort: env.GROQ_REASONING || 'low' } } : {}) })
    },
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
    return p ? [p] : []
  })
}
