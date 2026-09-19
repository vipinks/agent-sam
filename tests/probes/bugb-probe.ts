import { planFirstSend } from '../../app/components/workbench/session-resume'
const cases = [
  {
    name: 'untitled + unhydrated (the restart state)',
    input: {
      activeId: 'aaaaaaaa-1111-4111-8111-111111111111',
      activeTitle: 'Untitled conversation',
      message: 'make a fibonacci script',
      isHydrated: false,
    },
  },
  {
    name: 'untitled + hydrated (in-session first send)',
    input: {
      activeId: 'aaaaaaaa-1111-4111-8111-111111111111',
      activeTitle: 'Untitled conversation',
      message: 'make a fibonacci script',
      isHydrated: true,
    },
  },
  {
    name: 'no session at all',
    input: { activeId: null, activeTitle: null, message: 'hello there', isHydrated: false },
  },
]
for (const c of cases) console.log(c.name, '->', JSON.stringify(planFirstSend(c.input as never)))
