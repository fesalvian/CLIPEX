import type { ReactNode } from 'react'
import { useStore } from '../store'
import { Icon } from './Icon'

export type StepKey = 'analise' | 'clipar' | 'revisar'

interface Props {
  title: string
  subtitle?: string
  step?: StepKey
  /** etapa da análise ainda rodando */
  analyzing?: boolean
  projectId?: string
  actions?: ReactNode
}

const STEPS: { key: StepKey; label: string }[] = [
  { key: 'analise', label: 'Análise' },
  { key: 'clipar', label: 'Clipar' },
  { key: 'revisar', label: 'Revisar e postar' }
]

export function AppHeader({ title, subtitle, step, analyzing, projectId, actions }: Props) {
  const go = useStore((s) => s.go)
  const openProject = useStore((s) => s.openProject)
  const idx = STEPS.findIndex((s) => s.key === step)

  return (
    <header className="app-header">
      <div className="brand">
        <button className="brand-logo" aria-label="Voltar pro início" onClick={() => go({ name: 'home' })}>
          <Icon name="logo" size={18} color="#FFFFFF" strokeWidth={2.4} />
        </button>
        <div className="brand-text">
          <span className="brand-title">{title}</span>
          {subtitle && <span className="brand-sub">{subtitle}</span>}
        </div>
      </div>

      {step && (
        <nav aria-label="Etapas" className="steps">
          {STEPS.map((s, i) => {
            const done = i < idx && !(s.key === 'analise' && analyzing)
            const current = i === idx
            const canGo = projectId && !current && s.key !== 'analise'
            const content = (
              <>
                {done && <Icon name="check" size={14} color="#A78BFA" strokeWidth={2.6} />}
                {s.key === 'analise' && analyzing && <span className="spinner" />}
                {s.label}
              </>
            )
            return (
              <span key={s.key} style={{ display: 'contents' }}>
                {i > 0 && <span className="step-sep" />}
                {canGo ? (
                  <button className="step" onClick={() => void openProject(projectId, s.key as 'clipar' | 'revisar')}>
                    {content}
                  </button>
                ) : (
                  <span className={`step${current ? ' current' : ''}`} aria-current={current ? 'step' : undefined}>
                    {content}
                  </span>
                )}
              </span>
            )
          })}
        </nav>
      )}

      <div className="header-actions">{actions}</div>
    </header>
  )
}
