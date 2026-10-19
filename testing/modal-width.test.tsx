import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
} from '@/app/components/ui/alert-dialog'
import { CustomProviders } from '@/app/components/workbench/custom-provider-settings'
import { createBridgeStub, setActiveStub, stubStore } from './bridge-stub'

/**
 * The width a popup form takes, as the class ladder it carries.
 *
 * Every popup in this app is the same primitive — `AlertDialogContent` — so the ladder lives there
 * once and each form inherits it. The ladder is a cap, not a fixed width: below the first breakpoint
 * the dialog keeps a gutter against the viewport edge, `md` widens it to `xl`, and `lg` to `2xl` on a
 * desktop window. The point of the test is that the narrow screen is still bounded by the viewport and
 * that the wide screen actually gets the wider box.
 *
 * jsdom lays nothing out, so these are the classes that produce the width rather than a measured
 * rectangle. The measured rectangle is the running window's judgement.
 */

/** Class tokens, not substrings: `sm:max-w-md` must never satisfy a `max-w-md` check. */
function tokensOf(element: Element): Set<string> {
  return new Set(element.className.split(/\s+/).filter(Boolean))
}

function renderDialog(className?: string): Set<string> {
  render(
    <AlertDialog open>
      <AlertDialogContent className={className}>
        <AlertDialogTitle>Width probe</AlertDialogTitle>
        <AlertDialogDescription>A dialog, for its width alone.</AlertDialogDescription>
      </AlertDialogContent>
    </AlertDialog>
  )

  const content = document.querySelector<HTMLElement>('[data-slot="alert-dialog-content"]')
  expect(content).not.toBeNull()
  return tokensOf(content as HTMLElement)
}

describe('popup width', () => {
  it('widens from a viewport-bounded narrow box to xl and then 2xl', () => {
    const tokens = renderDialog()

    expect(tokens.has('w-full')).toBe(true)
    expect(tokens.has('max-w-[calc(100%-2rem)]')).toBe(true)
    expect(tokens.has('md:max-w-xl')).toBe(true)
    expect(tokens.has('lg:max-w-2xl')).toBe(true)
  })

  it('drops the old one-step width', () => {
    const tokens = renderDialog()

    expect(tokens.has('sm:max-w-md')).toBe(false)
  })

  it('stays centred with one padding', () => {
    const tokens = renderDialog()

    expect(tokens.has('left-1/2')).toBe(true)
    expect(tokens.has('-translate-x-1/2')).toBe(true)
    expect(tokens.has('p-5')).toBe(true)
  })

  it('keeps the ladder when a form names its own width', () => {
    // mcp-settings names `max-w-xl` for its form; the breakpoint caps must survive that override.
    const tokens = renderDialog('max-w-xl')

    expect(tokens.has('max-w-xl')).toBe(true)
    expect(tokens.has('lg:max-w-2xl')).toBe(true)
  })

  it('gives the add-a-provider form the same ladder', async () => {
    const stub = createBridgeStub()
    setActiveStub(stub)
    stubStore(stub, 'provider-config', { providers: {}, customProviders: [] })

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const user = userEvent.setup()
    render(
      <QueryClientProvider client={client}>
        <CustomProviders configured={[]} disabled={false} onProvidersChanged={() => {}} />
      </QueryClientProvider>
    )

    await user.click(await screen.findByRole('button', { name: '+ Add Provider' }))

    const dialog = await screen.findByRole('alertdialog')
    expect(dialog.getAttribute('data-slot')).toBe('alert-dialog-content')

    const tokens = tokensOf(dialog)
    expect(tokens.has('max-w-[calc(100%-2rem)]')).toBe(true)
    expect(tokens.has('md:max-w-xl')).toBe(true)
    expect(tokens.has('lg:max-w-2xl')).toBe(true)
  })
})
