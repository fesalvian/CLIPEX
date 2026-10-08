import type { LlmProvider } from '@shared/types'
import { env } from '../env'
import { getSettings, updateSettings } from '../settings'
import { type LlmClient, OllamaClient, OpenAiClient } from './client'

export async function llmClient(provider?: LlmProvider): Promise<LlmClient> {
  const s = getSettings()
  const p = provider ?? s.llmProvider
  if (p === 'openai') return new OpenAiClient(env('OPENAI_API_KEY'), s.openaiModel)
  let model = s.ollamaModel
  if (!model) {
    // Sem modelo escolhido: usa o primeiro instalado no Ollama.
    const models = await OllamaClient.listModels(s.ollamaUrl).catch(() => [])
    model = models[0] ?? ''
    if (model) updateSettings({ ollamaModel: model })
  }
  return new OllamaClient(s.ollamaUrl, model)
}

export async function listModels(provider: LlmProvider): Promise<string[]> {
  const s = getSettings()
  return provider === 'openai' ? OpenAiClient.listModels(env('OPENAI_API_KEY')) : OllamaClient.listModels(s.ollamaUrl)
}
