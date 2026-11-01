import type { Profile } from '@shared/types'

/** Avatar do perfil: inicial do nome no círculo da cor do perfil. */
export function ProfileAvatar({ profile, size = 40 }: { profile: Pick<Profile, 'name' | 'color'>; size?: number }) {
  const initial = profile.name.trim().replace(/^@/, '').charAt(0).toUpperCase() || '?'
  return (
    <span
      className="profile-avatar"
      aria-hidden="true"
      style={{ width: size, height: size, fontSize: Math.round(size * 0.44), ['--pc' as string]: profile.color }}
    >
      {initial}
    </span>
  )
}
