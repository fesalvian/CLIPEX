import { useEffect } from 'react'
import { call, useApiEvent } from './api'
import { Toasts } from './components/Toasts'
import { Clipar } from './screens/Clipar'
import { Home } from './screens/Home'
import { Posts } from './screens/Posts'
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
      call('watcher:status')
    ]).then(([projects, settings, components, watcher]) => {
      useStore.setState({ projects, settings, components, watcher })
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
  useApiEvent('toast', (t) => st().toast(t.kind, t.text))

  return (
    <div className="app">
      {route.name === 'home' && <Home />}
      {route.name === 'settings' && <SettingsScreen />}
      {route.name === 'posts' && <Posts />}
      {route.name === 'clipar' && <Clipar />}
      {route.name === 'revisar' && <Revisar />}
      <Toasts />
    </div>
  )
}
