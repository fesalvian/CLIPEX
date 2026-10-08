import type { LlmProvider } from '@shared/types'

export interface JsonSchema {
  name: string
  schema: Record<string, unknown>
}

export interface LlmClient {
  readonly provider: LlmProvider
  readonly model: string
  chatJson<T>(system: string, user: string, schema: JsonSchema): Promise<T>
}

export class LlmError extends Error {}

const TIMEOUT_MS = 180_000

async function postJson(url: string, body: unknown, headers: Record<string, string>): Promise<unknown> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: ctrl.signal
    })
    const text = await res.text()
    if (!res.ok) throw new LlmError(`HTTP ${res.status}: ${text.slice(0, 400)}`)
    return JSON.parse(text)
  } catch (e) {
    if (e instanceof LlmError) throw e
    if ((e as Error).name === 'AbortError') throw new LlmError('A IA demorou demais pra responder.')
    throw new LlmError(`Falha ao falar com a IA: ${(e as Error).message}`)
  } finally {
    clearTimeout(timer)
  }
}

function parseContent<T>(content: unknown): T {
  if (typeof content !== 'string') throw new LlmError('Resposta vazia da IA.')
  const trimmed = content.trim().replace(/^```(?:json)?\s*|\s*```$/g, '')
  try {
    return JSON.parse(trimmed) as T
  } catch {
    // modelos locais às vezes põem texto antes do JSON
    const m = /\{[\s\S]*\}/.exec(trimmed)
    if (m) return JSON.parse(m[0]) as T
    throw new LlmError('A IA não devolveu JSON válido.')
  }
}

export class OpenAiClient implements LlmClient {
  readonly provider = 'openai' as const
  constructor(
    private apiKey: string,
    readonly model: string
  ) {}

  async chatJson<T>(system: string, user: string, schema: JsonSchema): Promise<T> {
    if (!this.apiKey) throw new LlmError('Falta a chave da OpenAI (OPENAI_API_KEY).')
    const body: Record<string, unknown> = {
      model: this.model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user }
      ],
      response_format: { type: 'json_schema', json_schema: { name: schema.name, strict: true, schema: schema.schema } }
    }
    if (/^(gpt-5|o\d)/.test(this.model)) body.reasoning_effort = 'low'
    const res = (await postJson('https://api.openai.com/v1/chat/completions', body, {
      authorization: `Bearer ${this.apiKey}`
    })) as { choices?: { message?: { content?: string; refusal?: string } }[] }
    const msg = res.choices?.[0]?.message
    if (msg?.refusal) throw new LlmError(`A IA recusou: ${msg.refusal}`)
    return parseContent<T>(msg?.content)
  }

  static async listModels(apiKey: string): Promise<string[]> {
    if (!apiKey) return []
    const res = await fetch('https://api.openai.com/v1/models', { headers: { authorization: `Bearer ${apiKey}` } })
    if (!res.ok) throw new LlmError(`HTTP ${res.status} ao listar modelos da OpenAI`)
    const json = (await res.json()) as { data?: { id: string }[] }
    return (json.data ?? [])
      .map((m) => m.id)
      .filter((id) => /^(gpt-|o\d|chatgpt)/.test(id) && !/(audio|realtime|transcribe|tts|image|search|embedding)/.test(id))
      .sort()
  }
}

export class OllamaClient implements LlmClient {
  readonly provider = 'local' as const
  constructor(
    private baseUrl: string,
    readonly model: string
  ) {}

  async chatJson<T>(system: string, user: string, schema: JsonSchema): Promise<T> {
    if (!this.model) throw new LlmError('Escolha um modelo do Ollama nas configurações.')
    const res = (await postJson(`${this.baseUrl.replace(/\/$/, '')}/api/chat`, {
      model: this.model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user }
      ],
      stream: false,
      think: false,
      format: schema.schema,
      options: { temperature: 0.5, num_ctx: 8192 }
    }, {})) as { message?: { content?: string } }
    return parseContent<T>(res.message?.content)
  }

  static async listModels(baseUrl: string): Promise<string[]> {
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/api/tags`)
    if (!res.ok) throw new LlmError(`HTTP ${res.status} ao listar modelos do Ollama`)
    const json = (await res.json()) as { models?: { name: string }[] }
    return (json.models ?? []).map((m) => m.name)
  }
}
