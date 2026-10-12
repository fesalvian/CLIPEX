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

export interface NetworkClient {
  readonly network: Network
  connected(): Promise<{ connected: boolean; account: string | null }>
  connect(): Promise<void>
  publish(input: PublishInput, onProgress?: (p: number) => void): Promise<PublishResult>
  /** views por id remoto; redes sem API de métricas devolvem mapa vazio */
  metrics(remoteIds: string[]): Promise<Map<string, RemoteStats>>
}
