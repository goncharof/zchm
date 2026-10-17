/**
 * Цепочка моделей ИИ-ведущего из переменных окружения.
 * Провайдер включается, если задан его ключ (для своей модели — адрес). Порядок перебора — GM_CHAIN.
 * Бесплатные тарифы и названия моделей часто меняются: модель каждого провайдера можно переопределить.
 *
 *   GEMINI_API_KEY      [GEMINI_MODEL=gemini-2.5-flash]                  — Google AI Studio, бесплатный уровень
 *   GROQ_API_KEY        [GROQ_MODEL=llama-3.3-70b-versatile]             — Groq, бесплатный уровень
 *   CEREBRAS_API_KEY    [CEREBRAS_MODEL=llama-3.3-70b]                   — Cerebras, бесплатный уровень
 *   OPENROUTER_API_KEY  [OPENROUTER_MODEL=meta-llama/llama-3.3-70b-instruct:free] — OpenRouter, модели :free
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
      ? new OpenAiCompatProvider({ id: 'gemini', label: 'Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', apiKey: env.GEMINI_API_KEY || env.GOOGLE_API_KEY, model: env.GEMINI_MODEL || 'gemini-2.5-flash' })
      : null,
    groq: () => env.GROQ_API_KEY
      ? new OpenAiCompatProvider({ id: 'groq', label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', apiKey: env.GROQ_API_KEY, model: env.GROQ_MODEL || 'llama-3.3-70b-versatile', historyLimit: 24 })
      : null,
    cerebras: () => env.CEREBRAS_API_KEY
      ? new OpenAiCompatProvider({ id: 'cerebras', label: 'Cerebras', baseUrl: 'https://api.cerebras.ai/v1', apiKey: env.CEREBRAS_API_KEY, model: env.CEREBRAS_MODEL || 'llama-3.3-70b', historyLimit: 30 })
      : null,
    openrouter: () => env.OPENROUTER_API_KEY
      ? new OpenAiCompatProvider({ id: 'openrouter', label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', apiKey: env.OPENROUTER_API_KEY, model: env.OPENROUTER_MODEL || 'meta-llama/llama-3.3-70b-instruct:free', historyLimit: 30 })
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
