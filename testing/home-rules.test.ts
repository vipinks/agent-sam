import { describe, expect, it } from 'vitest'
import {
  HOME_OPEN_FOLDER,
  HOME_STARTERS,
  homeChip,
  MAX_HOME_RECENTS,
  projectRowLabel,
  recentSessionsForHome,
} from '@/app/components/workbench/home'
import type { ChatSession } from '@/conveyor/stores/chat-sessions'

/**
 * The home screen's decisions, as rules rather than as a rendered screen.
 *
 * Which conversations are offered back, what a chip calls the project it belongs to, and what the
 * project row says with and without a folder open are all decisions a test should make by calling a
 * function. The wiring suite covers the part a rule cannot see — that the screen reaches these.
 */

function session(id: string, title: string, lastRoot?: string, updatedAt = 1_700_000_000_000): ChatSession {
  return {
    id,
    title,
    createdAt: 1_700_000_000_000,
    updatedAt,
    providerId: 'deepseek',
    model: 'deepseek-chat',
    ...(lastRoot !== undefined ? { lastRoot } : {}),
  }
}

describe('the conversations offered back', () => {
  it('keeps the three most recently touched, across projects', () => {
    const oldest = session('aaaaaaaa-1111-4111-8111-111111111111', 'oldest', 'C:/work/one', 1)
    const second = session('bbbbbbbb-2222-4222-8222-222222222222', 'second', 'C:/work/two', 2)
    const third = session('cccccccc-3333-4333-8333-333333333333', 'third', 'C:/work/one', 3)
    const newest = session('dddddddd-4444-4444-8444-444444444444', 'newest', 'C:/work/three', 4)

    // The store's own order is deliberately not trusted: the rule states its ordering rather than
    // inheriting whatever the list happens to have arrived in.
    const picked = recentSessionsForHome([second, oldest, newest, third])

    expect(picked.map((s) => s.title)).toEqual(['newest', 'third', 'second'])
    expect(picked).toHaveLength(MAX_HOME_RECENTS)
    // A project does not get a second slot while another conversation is more recent.
    expect(picked.some((s) => s.title === 'oldest')).toBe(false)
  })

  it('offers everything there is when there are fewer than three', () => {
    expect(recentSessionsForHome([session('aaaaaaaa-1111-4111-8111-111111111111', 'only one')])).toHaveLength(1)
    expect(recentSessionsForHome([])).toHaveLength(0)
  })

  it('leaves the caller’s list alone', () => {
    const sessions = [session('aaaaaaaa-1111-4111-8111-111111111111', 'one', undefined, 1)]
    recentSessionsForHome(sessions)
    expect(sessions).toHaveLength(1)
  })
})

describe('what a chip says', () => {
  it('names the project by its last segment, and the conversation by its title', () => {
    expect(homeChip(session('aaaaaaaa-1111-4111-8111-111111111111', 'Composer card', 'C:/work/sam-ai'))).toEqual({
      project: 'sam-ai',
      title: 'Composer card',
    })
  })

  it('truncates a long title rather than growing the chip', () => {
    const long = homeChip(session('aaaaaaaa-1111-4111-8111-111111111111', 'a'.repeat(80), 'C:/work/sam-ai'))

    expect(long.title.length).toBeLessThanOrEqual(32)
    expect(long.title.endsWith('…')).toBe(true)
  })

  it('says a conversation with no project has none, rather than naming it after one', () => {
    expect(homeChip(session('aaaaaaaa-1111-4111-8111-111111111111', 'Untitled')).project).toBe('No project')
  })
})

describe('the project row’s label', () => {
  it('is the open folder’s last segment', () => {
    expect(projectRowLabel('C:/work/sam-ai')).toBe('sam-ai')
    expect(projectRowLabel('C:/work/deeply/nested/project/')).toBe('project')
  })

  it('is the way to open one when nothing is open', () => {
    expect(projectRowLabel(null)).toBe(HOME_OPEN_FOLDER)
  })
})

describe('the starter prompts', () => {
  it('is three distinct prompts, each with something in it', () => {
    expect(HOME_STARTERS).toHaveLength(3)
    expect(new Set(HOME_STARTERS).size).toBe(3)
    for (const prompt of HOME_STARTERS) expect(prompt.trim().length).toBeGreaterThan(0)
  })
})
