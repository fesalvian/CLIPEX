import { useEffect } from 'react'
import { call, useApiEvent } from './api'
import { Toasts } from './components/Toasts'
import { Clipar } from './screens/Clipar'
import { Home } from './screens/Home'
import { Posts } from './screens/Posts'
import { Profiles } from './screens/Profiles'
import { Revisar } from './screens/Revisar'
import { SettingsScreen } from './screens/Settings'
import { useStore } from './store'

export function App() {
  const route = useStore((s) => s.route)
  const st = useStore.getState

  useEffect(() => {
    void Promise.all([
      call('projects:list'),
      call('settings:get'),
      call('components:status'),
      call('watcher:status'),
      call('profiles:list'),
      call('profiles:active'),
      call('sources:status')
    ]).then(([projects, settings, components, watcher, profiles, activeProfileId, source]) => {
      // com mais de um perfil, abre na escolha de perfil (como a Netflix)
      useStore.setState({
        projects,
        settings,
        components,
        watcher,
        profiles,
        activeProfileId,
        source,
        ...(profiles.length > 1 ? { route: { name: 'profiles' } } : {})
      })
    })
    void useStore.getState().loadFonts()
  }, [])

  useApiEvent('projects:changed', (projects) => useStore.setState({ projects }))
  useApiEvent('project:updated', (p) => st().setProject(p))
  useApiEvent('clip:updated', (c) => st().upsertClip(c))
  useApiEvent('clips:added', (list) => st().upsertClips(list))
  useApiEvent('clip:removed', ({ id }) => st().removeClip(id))
  useApiEvent('components:changed', (components) => useStore.setState({ components }))
  useApiEvent('watcher:changed', (watcher) => useStore.setState({ watcher }))
  useApiEvent('post:updated', (p) => st().upsertPost(p))
  useApiEvent('profiles:changed', (profiles) => useStore.setState({ profiles }))
  useApiEvent('source:status', (s) => {
    if (s.profileId === st().activeProfileId) useStore.setState({ source: s })
  })
  useApiEvent('toast', (t) => st().toast(t.kind, t.text))

  return (
    <div className="app">
      {route.name === 'profiles' && <Profiles />}
      {route.name === 'home' && <Home />}
      {route.name === 'settings' && <SettingsScreen />}
      {route.name === 'posts' && <Posts />}
      {route.name === 'clipar' && <Clipar />}
      {route.name === 'revisar' && <Revisar />}
      <Toasts />
    </div>
  )
}
