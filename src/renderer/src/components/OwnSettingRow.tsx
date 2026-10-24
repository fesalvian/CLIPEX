interface Props {
  text: string
  onReset: () => void
  onApplyAll: () => void
}

/** Aviso de que o corte tem um ajuste só dele, com os atalhos pra voltar ao padrão ou espalhar. */
export function OwnSettingRow({ text, onReset, onApplyAll }: Props) {
  return (
    <div className="own-setting">
      <span>{text}</span>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 8 }}>
        <button className="btn sm" onClick={onReset}>
          Voltar ao padrão
        </button>
        <button className="btn sm" onClick={onApplyAll}>
          Usar em todos
        </button>
      </div>
    </div>
  )
}
