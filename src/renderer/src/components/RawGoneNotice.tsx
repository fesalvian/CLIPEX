import type { Project } from '@shared/types'
import { Icon } from './Icon'

/** Aviso de que o arquivo bruto da live não está mais no PC. */
export function RawGoneNotice({ project }: { project: Project }) {
  if (!project.rawDeletedAt) return null
  return (
    <div className="callout warn" role="status">
      <Icon name="alert" />
      <span>
        O arquivo bruto desta live não está mais no PC. Os cortes que já foram renderizados continuam sendo postados e
        baixados com a última versão gerada, mas mudanças no vídeo (legenda, gancho, recorte, logo) não entram mais.
      </span>
    </div>
  )
}
