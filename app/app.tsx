import { WindowFrame } from './shell'
import { Workbench } from './components/workbench'
import './styles/app.css'

/** App root. The custom window shell (titlebar, menus, controls) wraps the workbench UI. */
export default function App() {
  return (
    <WindowFrame title="Sam AI">
      <Workbench />
    </WindowFrame>
  )
}
