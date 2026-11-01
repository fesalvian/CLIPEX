import type { Network } from '@shared/types'

export interface RemoteStats {
  views: number
  likes: number
  comments: number
}

export interface PublishInput {
  videoPath: string
  title: string | null
  text: string
  hashtags: string[]
  /** agendamento nativo (só YouTube); null = publicar agora */
  publishAt: string | null
  /** categoria do vídeo no YouTube (20 = jogos, 24 = entretenimento) */
  categoryId?: string
}

export interface PublishResult {
  remoteId: string
  url: string | null
  /** TikTok: vai pro inbox como rascunho */
  draft: boolean
  /** agendado na própria plataforma (YouTube publishAt) */
  scheduledRemotely: boolean
  /** aviso pro usuário (ex.: subiu privado) */
  note?: string
}

/** A cota diária da API do YouTube acabou: o post espera em vez de falhar. */
export class QuotaError extends Error {}

/** Cliente de uma rede. Cada perfil tem a própria conta (tokens separados). */
export interface NetworkClient {
  readonly network: Network
  connected(profileId: string): Promise<{ connected: boolean; account: string | null }>
  connect(profileId: string): Promise<void>
  publish(profileId: string, input: PublishInput, onProgress?: (p: number) => void): Promise<PublishResult>
  /** views por id remoto; redes sem API de métricas devolvem mapa vazio */
  metrics(profileId: string, remoteIds: string[]): Promise<Map<string, RemoteStats>>
}
