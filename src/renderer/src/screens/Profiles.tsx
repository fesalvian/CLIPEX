import { useState } from 'react'
import { KIND_LABEL } from '@shared/defaults'
import { errorText } from '../api'
import { Icon } from '../components/Icon'
import { NewProfileModal } from '../components/NewProfileModal'
import { ProfileAvatar } from '../components/ProfileAvatar'
import { useStore } from '../store'

/** "Quem está clipando?": escolha de perfil, como na Netflix. */
export function Profiles() {
  const profiles = useStore((s) => s.profiles)
  const activeId = useStore((s) => s.activeProfileId)
  const selectProfile = useStore((s) => s.selectProfile)
  const toast = useStore((s) => s.toast)
  const [creating, setCreating] = useState(false)

  const pick = (id: string): void => {
    void selectProfile(id).catch((e) => toast('error', errorText(e)))
  }

  return (
    <main className="screen profiles-screen">
      <h1>Qual canal você vai clipar?</h1>
      <div className="profiles-grid">
        {profiles.map((p) => (
          <button key={p.id} className={`profile-tile${p.id === activeId ? ' current' : ''}`} onClick={() => pick(p.id)}>
            <ProfileAvatar profile={p} size={112} />
            <span className="profile-name">{p.name}</span>
            <span className="profile-kind">
              {KIND_LABEL[p.kind]}
              {p.autoPost.enabled && !p.autoPost.paused && ' · automático'}
              {p.autoPost.enabled && p.autoPost.paused && ' · pausado'}
            </span>
          </button>
        ))}
        <button className="profile-tile add" onClick={() => setCreating(true)}>
          <span className="profile-add-circle">
            <Icon name="plus" size={40} strokeWidth={1.8} />
          </span>
          <span className="profile-name">Novo perfil</span>
          <span className="profile-kind">gameplay, podcast ou 16:9</span>
        </button>
      </div>
      {creating && <NewProfileModal onClose={() => setCreating(false)} />}
    </main>
  )
}
