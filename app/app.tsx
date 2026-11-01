import { WindowFrame } from './shell'
import { Toaster } from 'sonner'
import { Workbench } from './components/workbench'
import { SplashScreen } from './splash/splash-screen'
import './styles/app.css'

/**
 * App root. The custom window shell (titlebar, menus, controls) wraps the workbench UI.
 *
 * The `Toaster` is mounted here rather than inside a panel so a toast survives the view that raised
 * it: saving a key in Settings and switching back to Chat should not swallow the confirmation.
 */
export default function App() {
  // The splash is the same bundle under a hash rather than a second Vite entry. It deliberately
  // bypasses the shell and workbench while staying inside the renderer's ErrorBoundary.
  if (window.location.hash === '#splash') return <SplashScreen />

  return (
    <WindowFrame>
      <Workbench />
      <Toaster position="bottom-right" theme="system" closeButton />
    </WindowFrame>
  )
}
