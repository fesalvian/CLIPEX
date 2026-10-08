import { useStore } from '../store'
import { Icon } from './Icon'

export function Toasts() {
  const toasts = useStore((s) => s.toasts)
  const dismiss = useStore((s) => s.dismiss)
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}>
          <Icon
            name={t.kind === 'error' ? 'alert' : t.kind === 'success' ? 'check' : 'info'}
            color={t.kind === 'error' ? '#FF8A8A' : '#C4B5FD'}
          />
          <span>{t.text}</span>
          <button className="btn xs ghost" aria-label="Fechar aviso" onClick={() => dismiss(t.id)}>
            <Icon name="x" size={14} />
          </button>
        </div>
      ))}
    </div>
  )
}
