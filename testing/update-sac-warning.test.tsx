import { beforeEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { UpdateReadyNotice } from '@/app/components/workbench/update-ready-notice'
import { UpdatesSection } from '@/app/components/workbench/updates-settings'
import type { UpdateStatusState } from '@/conveyor/stores/update-status'
import { createBridgeStub, setActiveStub, stubStore, type BridgeStub } from './bridge-stub'

/**
 * The Smart App Control warning on the two surfaces that offer the blocked install.
 *
 * The probe is main's business and `tests/updates/updates-sac-policy-test.ts` pins it. What only jsdom can
 * prove is the consequence: when the store carries `enforcing`, the ready card says the silent install will
 * be blocked and leaves Install enabled, while the Updates section shows the same one-line banner. `off` and
 * `unknown` are silent, which is the fail-open rule rendered rather than merely stated.
 *
 * The install state is seeded rather than reached through a click-driven update flow: the card's install rule
 * is already `updateAvailability`'s, and this file is about one advisory line beside it.
 */

const WARNING =
  'Smart App Control is enforcing on this machine — the silent install will be blocked. Turn it off in Windows Security (App & browser control), or install the setup from the release page by hand.'

function statusState(over: Partial<UpdateStatusState> = {}): UpdateStatusState {
  return {
    state: 'idle',
    availableVersion: null,
    currentVersion: '1.2.0',
    lastCheckedAt: null,
    errorCode: null,
    pendingInstall: null,
    sacPolicyState: 'unknown',
    ...over,
  }
}

/** Both surfaces over one status mirror, with every updater action answered emptily. */
function stubUpdates(status: UpdateStatusState): BridgeStub {
  const stub = createBridgeStub({
    check: () => undefined,
    download: () => undefined,
    install: () => undefined,
    showInstaller: () => undefined,
    installVisible: () => undefined,
  })
  stubStore(stub, 'update-status', status)
  stubStore(stub, 'update-preferences', { autoDownload: true })
  setActiveStub(stub)
  return stub
}

function renderNotice() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <UpdateReadyNotice />
    </QueryClientProvider>
  )
}

function renderUpdatesSection() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <UpdatesSection />
    </QueryClientProvider>
  )
}

function readyNotice(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-slot="update-ready-notice"]')
}

function settingsWarning(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-slot="updates-sac-warning"]')
}

beforeEach(() => {
  localStorage.clear()
})

describe('the Smart App Control warning', () => {
  it('warns above the ready card’s Install button and keeps the install enabled', async () => {
    const stub = stubUpdates(statusState({ state: 'ready', availableVersion: '1.3.0', sacPolicyState: 'enforcing' }))
    renderNotice()

    await waitFor(() => expect(readyNotice()).not.toBeNull())
    const card = readyNotice() as HTMLElement
    const warning = card.querySelector<HTMLElement>('[data-slot="sac-policy-warning"]')

    expect(warning?.textContent).toBe(WARNING)
    // It is advisory: the user can still ask for the install the policy is expected to block.
    const install = within(card).getByRole('button', { name: 'Install and restart' })
    expect(install.hasAttribute('disabled')).toBe(false)

    await userEvent.click(install)
    await waitFor(() => expect(stub.methodsOn('updates')).toContain('install'))
  })

  it('says nothing on the ready card when the policy is off or unknown', async () => {
    for (const sacPolicyState of ['off', 'unknown'] as const) {
      stubUpdates(statusState({ state: 'ready', availableVersion: '1.3.0', sacPolicyState }))
      renderNotice()

      await waitFor(() => expect(readyNotice()).not.toBeNull())
      expect(readyNotice()?.querySelector('[data-slot="sac-policy-warning"]')).toBeNull()
      cleanup()
    }
  })

  it('shows the same banner in Updates while enforcing, and hides it otherwise', async () => {
    stubUpdates(statusState({ state: 'ready', availableVersion: '1.3.0', sacPolicyState: 'enforcing' }))
    renderUpdatesSection()

    await waitFor(() => expect(settingsWarning()).not.toBeNull())
    expect(settingsWarning()?.textContent).toBe(WARNING)
    expect(screen.getByRole('button', { name: 'Install and restart' })).toBeTruthy()

    for (const sacPolicyState of ['off', 'unknown'] as const) {
      cleanup()
      stubUpdates(statusState({ state: 'ready', availableVersion: '1.3.0', sacPolicyState }))
      renderUpdatesSection()

      await screen.findByRole('button', { name: 'Install and restart' })
      await waitFor(() => expect(settingsWarning()).toBeNull())
    }
  })
})
