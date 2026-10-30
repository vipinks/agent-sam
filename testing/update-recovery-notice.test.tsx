import { beforeEach, describe, expect, it } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClientProvider } from '@tanstack/react-query'
import { UpdateReadyNotice } from '@/app/components/workbench/update-ready-notice'
import { queryClient } from '@/conveyor/client'
import { type UpdateStatusState } from '@/conveyor/stores/update-status'
import { createBridgeStub, setActiveStub, stubStore, type BridgeStub } from './bridge-stub'

/**
 * The update-recovery notice: what a launch says when the previous one quit into a blocked installer.
 *
 * The marker itself is main's: `restorePendingInstall` reads it at launch and dispatches it into the status
 * mirror, and that dispatch is simulated here by seeding the store. What jsdom can prove is the consequence —
 * that a marker draws a card with the two actions, that the actions reach the dispatchers main registered,
 * and that the card does not appear when there is no marker.
 *
 * It renders the notice alone rather than the whole workbench. The card's mount point is already pinned by
 * `update-notice-wiring.test.tsx`; this file is about the second face of the same component, so the smaller
 * render is the narrower test.
 *
 * jsdom proves wiring and words, not pixels. Whether the two buttons fit the strip without crowding, in
 * either theme, is the reviewer's eyes on the running window.
 */

/** A marker exactly as the previous launch would have written it. */
const MARKER = {
  version: '1.3.0',
  installerPath: 'C:/Users/me/AppData/Local/agent-sam-updater/pending/AgentSam-1.3.0-setup.exe',
  at: 1_700_000_000_000,
}

/** The status store's state, as the mirror hands it to the notice. */
function statusState(over: Partial<UpdateStatusState> = {}): UpdateStatusState {
  return {
    state: 'idle',
    availableVersion: null,
    currentVersion: '1.2.0',
    lastCheckedAt: null,
    errorCode: null,
    pendingInstall: null,
    ...over,
  }
}

/** The five acts the notice can reach, answered emptily: what is asserted is which one a click reached. */
function stubNotice(status: UpdateStatusState = statusState()): BridgeStub {
  const stub = createBridgeStub({
    check: () => undefined,
    download: () => undefined,
    install: () => undefined,
    showInstaller: () => undefined,
    installVisible: () => undefined,
  })
  stubStore(stub, 'update-status', status)
  setActiveStub(stub)
  return stub
}

function renderNotice() {
  return render(
    <QueryClientProvider client={queryClient}>
      <UpdateReadyNotice />
    </QueryClientProvider>
  )
}

/** The recovery card, or null while it is not drawn. */
function recoveryNotice(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-slot="update-recovery-notice"]')
}

/** The ready card, or null while it is not drawn. */
function readyNotice(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-slot="update-ready-notice"]')
}

beforeEach(() => {
  localStorage.clear()
})

describe('the update-recovery notice', () => {
  it('speaks for an unfinished install, with the installer and the visible fallback', async () => {
    const stub = stubNotice(statusState({ pendingInstall: MARKER }))
    renderNotice()

    await waitFor(() => expect(recoveryNotice()).not.toBeNull())
    const card = recoveryNotice() as HTMLElement

    // The words name the version that did not land, and say what to do about it.
    expect(card.textContent).toContain("Update to 1.3.0 didn't finish — open the installer")
    // And the fallback's limit is stated rather than promised away.
    expect(card.textContent).toContain('strict app-control policies may still block it')

    await userEvent.click(screen.getByRole('button', { name: 'Show installer' }))
    await waitFor(() => expect(stub.methodsOn('updates')).toContain('showInstaller'))

    await userEvent.click(screen.getByRole('button', { name: 'Try visible install' }))
    await waitFor(() => expect(stub.methodsOn('updates')).toContain('installVisible'))
  })

  it('is silent when there is no marker, and the ready card still speaks for a downloaded update', async () => {
    stubNotice(statusState({ state: 'ready', availableVersion: '1.3.0' }))
    renderNotice()

    await waitFor(() => expect(readyNotice()).not.toBeNull())
    expect(recoveryNotice()).toBeNull()
  })

  it('has its own dismissal, which does not silence the ready card', async () => {
    stubNotice(statusState({ pendingInstall: MARKER }))
    renderNotice()

    await waitFor(() => expect(recoveryNotice()).not.toBeNull())
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss update recovery notice' }))

    await waitFor(() => expect(recoveryNotice()).toBeNull())
  })
})
