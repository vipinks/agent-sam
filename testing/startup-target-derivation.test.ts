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
})
