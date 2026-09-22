import { describe, expect, it } from 'vitest'
import { TRANSCRIPT_VERSION } from '@/conveyor/protocol/transcript'
import {
  appendCustom,
  customProviderSchema,
  modelsUrl,
  newProviderId,
  validateProviderDraft,
} from '@/conveyor/protocol/custom-provider'

/**
 * The rules that decide whether a custom provider may exist, and under what name and id.
 *
 * These are the checks a form cannot be trusted to make: the same draft arrives over IPC from the
 * renderer, and main has to answer for it. Kept as pure functions over arguments rather than as a
 * schema, because two of the three questions are not about one field — a name is only valid against
 * the names already taken, and an id only exists in relation to the ids already used.
 */

const LOCAL = { name: 'Local Llama', baseUrl: 'http://localhost:1234/v1', apiKey: '' }

describe('a provider draft', () => {
  it('needs a name, and treats a blank one as absent rather than as a name', () => {
    expect(validateProviderDraft({ ...LOCAL, name: '   ' }, [])).toEqual({ ok: false, code: 'NAME_REQUIRED' })
  })

  it('is refused when its name is already taken, whatever the case', () => {
    expect(validateProviderDraft(LOCAL, ['Local Llama'])).toEqual({ ok: false, code: 'NAME_TAKEN' })
    // Case and surrounding space are the two ways a user retypes the same name, and neither is a
    // second provider.
    expect(validateProviderDraft({ ...LOCAL, name: ' local llama ' }, ['Local Llama'])).toEqual({
      ok: false,
      code: 'NAME_TAKEN',
    })
  })

  it('needs a base URL that parses as http or https, and refuses anything else', () => {
    expect(validateProviderDraft({ ...LOCAL, baseUrl: 'localhost:1234' }, [])).toEqual({
      ok: false,
      code: 'BASE_URL_INVALID',
    })
    expect(validateProviderDraft({ ...LOCAL, baseUrl: 'ftp://example.com/v1' }, [])).toEqual({
      ok: false,
      code: 'BASE_URL_INVALID',
    })
    expect(validateProviderDraft({ ...LOCAL, baseUrl: '' }, [])).toEqual({
      ok: false,
      code: 'BASE_URL_INVALID',
    })
  })

  it('is accepted with a trailing slash trimmed, so the URL it yields joins cleanly', () => {
    const result = validateProviderDraft({ ...LOCAL, baseUrl: 'http://localhost:1234/v1/' }, [])
    expect(result).toEqual({
      ok: true,
      draft: { name: 'Local Llama', baseUrl: 'http://localhost:1234/v1', apiKey: '' },
    })
  })

  it('may carry no API key at all — a local server that wants none is the ordinary case', () => {
    expect(validateProviderDraft(LOCAL, []).ok).toBe(true)
    expect(validateProviderDraft({ ...LOCAL, apiKey: 'sk-local' }, []).ok).toBe(true)
  })
})

describe('a provider id', () => {
  it('is derived from the name and stays the same for the same name', () => {
    expect(newProviderId('Local Llama', [])).toBe('local-llama')
    expect(newProviderId('Local Llama', [])).toBe(newProviderId('Local Llama', []))
  })

  it('cannot collide with an id already in use', () => {
    expect(newProviderId('Local Llama', ['local-llama'])).toBe('local-llama-2')
    expect(newProviderId('Local Llama', ['local-llama', 'local-llama-2'])).toBe('local-llama-3')
  })

  it('still yields something usable from a name with nothing sluggable in it', () => {
    expect(newProviderId('★', [])).toBe('custom-provider')
    expect(newProviderId('★', ['custom-provider'])).toBe('custom-provider-2')
  })
})

describe('appending a custom provider', () => {
  it('keeps creation order and lands after the providers already there', () => {
    const first = appendCustom([], { id: 'alpha', name: 'Alpha', baseUrl: 'http://a/v1', apiKey: '' })
    const second = appendCustom(first, { id: 'beta', name: 'Beta', baseUrl: 'http://b/v1', apiKey: 'k' })

    expect(second.map((p) => p.id)).toEqual(['alpha', 'beta'])
    expect(second[1]).toEqual({
      id: 'beta',
      name: 'Beta',
      baseUrl: 'http://b/v1',
      apiKey: 'k',
      dialect: 'openai',
      models: [],
    })
    // The list that was passed in is not the list that comes back: a store action assigns the result,
    // and a reducer that mutated its input in place would be a second source of truth.
    expect(first.map((p) => p.id)).toEqual(['alpha'])
  })
})

describe('the descriptor', () => {
  it('is only valid as the one dialect this build speaks', () => {
    const ok = { id: 'a', name: 'A', baseUrl: 'http://a/v1', apiKey: '', dialect: 'openai', models: ['m'] }
    expect(customProviderSchema.safeParse(ok).success).toBe(true)
    expect(customProviderSchema.safeParse({ ...ok, dialect: 'anthropic' }).success).toBe(false)
    expect(customProviderSchema.safeParse({ ...ok, models: 'm' }).success).toBe(false)
  })

  it('builds the two URLs a provider is asked for from one base', () => {
    expect(modelsUrl('http://localhost:1234/v1')).toBe('http://localhost:1234/v1/models')
    expect(modelsUrl('http://localhost:1234/v1/')).toBe('http://localhost:1234/v1/models')
  })

  it('does not move the transcript version: nothing outside the settings slice changed shape', () => {
    expect(TRANSCRIPT_VERSION).toBe(2)
  })
})
