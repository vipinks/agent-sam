import { beforeEach, describe, expect, it } from 'vitest'
import { createWorkbenchStore } from '@/app/components/workbench/store'
import { setBootTargetSeed } from '@/app/components/workbench/boot-target-seed'

/**
 * T-D3's startup half: what a launch opens on before anyone has picked a model in the header.
 *
 * Each case builds a store of its own with the catalogue it is asserting against, because the
 * singleton is built once at module evaluation, before a launch has heard from main. The launch
 * case with no stored preference is the regression: it used to open on the literal `deepseek-chat`
 * whether or not that model was switched on.
 */

const TARGET_KEY = 'sam-ai-chat-target'

beforeEach(() => {
  localStorage.clear()
})

describe('T-D3 startup target derivation', () => {
  it('starts on the first enabled model, never the old hardcoded deepseek-chat', () => {
    const store = createWorkbenchStore({
      enabledModels: { deepseek: ['deepseek-flash'] },
      providerOrder: ['deepseek'],
    })

    expect(store.getState()).toMatchObject({ activeProviderId: 'deepseek', activeModel: 'deepseek-flash' })
    expect(store.getState().activeModel).not.toBe('deepseek-chat')
  })

  it('starts with no active model when nothing is enabled', () => {
    const store = createWorkbenchStore({ enabledModels: { deepseek: [] }, providerOrder: ['deepseek'] })

    expect(store.getState().activeModel).toBeNull()
  })

  it('keeps a remembered model when the provider record is present but empty', () => {
    localStorage.setItem(TARGET_KEY, JSON.stringify({ providerId: 'deepseek', model: 'deepseek-reasoner' }))

    const store = createWorkbenchStore({ enabledModels: { deepseek: [] }, providerOrder: ['deepseek'] })

    // An empty list is "not read yet" here too, exactly as `reconcileTarget` reads it: the remembered
    // pair is not stale just because Settings has no enabled models on record.
    expect(store.getState()).toMatchObject({ activeProviderId: 'deepseek', activeModel: 'deepseek-reasoner' })
  })

  it('reapplies the provider-config boot seed after the mirror resolves', () => {
    localStorage.setItem(TARGET_KEY, JSON.stringify({ providerId: 'deepseek', model: 'deepseek-reasoner' }))
    const store = createWorkbenchStore()

    setBootTargetSeed({ deepseek: ['deepseek-flash'] })
    store.getState().seedTarget()

    expect(store.getState()).toMatchObject({ activeProviderId: 'deepseek', activeModel: 'deepseek-flash' })
  })

  it('drops a stored model the provider has since switched off', () => {
    localStorage.setItem(TARGET_KEY, JSON.stringify({ providerId: 'deepseek', model: 'deepseek-chat' }))

    const store = createWorkbenchStore({
      enabledModels: { deepseek: ['deepseek-flash'] },
      providerOrder: ['deepseek'],
    })

    expect(store.getState().activeModel).toBe('deepseek-flash')
  })

  it('keeps a stored model that is still enabled', () => {
    localStorage.setItem(TARGET_KEY, JSON.stringify({ providerId: 'deepseek', model: 'deepseek-reasoner' }))

    const store = createWorkbenchStore({
      enabledModels: { deepseek: ['deepseek-flash', 'deepseek-reasoner'] },
      providerOrder: ['deepseek'],
    })

    expect(store.getState()).toMatchObject({ activeProviderId: 'deepseek', activeModel: 'deepseek-reasoner' })
  })

  it('moves off a provider that has left the order, ignoring the record it left behind', () => {
    localStorage.setItem(TARGET_KEY, JSON.stringify({ providerId: 'local-llama', model: 'llama-3.1-8b' }))
    const store = createWorkbenchStore()

    // The leftover record is what a delete used to keep: the provider is gone from the order the header
    // offers, but its enabled list still names the model it used to serve.
    store.getState().reconcileTarget({ 'local-llama': ['llama-3.1-8b'], deepseek: ['deepseek-chat'] }, ['deepseek'])

    expect(store.getState()).toMatchObject({ activeProviderId: 'deepseek', activeModel: 'deepseek-chat' })
  })

  it('drops a gone provider to the empty target rather than naming it', () => {
    localStorage.setItem(TARGET_KEY, JSON.stringify({ providerId: 'local-llama', model: 'llama-3.1-8b' }))
    const store = createWorkbenchStore()

    // No live provider has a model switched on, so there is no pair to move to — and the dead id is not
    // a fallback either: the header names nothing until the user chooses, which is the truth.
    store.getState().reconcileTarget({ 'local-llama': [] }, ['deepseek'])

    expect(store.getState()).toMatchObject({ activeProviderId: '', activeModel: null })
  })
})
