import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, type AppContext } from '../../src/app.js'
import { loadSettings } from '../../src/config/env.js'
import { apps, vocabulary as vocabularyTable } from '../../src/db/schema.js'

let dir: string
let ctx: AppContext

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'arrlink-api-rules-'))
  const settings = await loadSettings({ CONFIG_DIR: dir })
  ctx = await createApp(settings)
})

afterEach(async () => {
  vi.unstubAllGlobals()
  await ctx.close()
  rmSync(dir, { recursive: true, force: true })
})

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/** Mocks the three Radarr endpoints the adapter's fetchSnapshot touches --
 * same shape as poller.test.ts's mockRadarr, just inline (no movies on disk
 * needed here since these tests only care whether a poll ran at all). */
function mockRadarr(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string | URL) => {
      const u = String(url)
      if (u.includes('/api/v3/tag')) return Promise.resolve(jsonResponse([]))
      if (u.includes('/api/v3/qualityprofile')) return Promise.resolve(jsonResponse([]))
      if (u.includes('/api/v3/language')) return Promise.resolve(jsonResponse([]))
      if (u.includes('/api/v3/movie')) return Promise.resolve(jsonResponse([]))
      return Promise.resolve(new Response('not found', { status: 404 }))
    }),
  )
}

function ruleBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'kids',
    dir_template: '/media/kids',
    conditions: [
      { category: 'user', match_type: 'exact', match_value: 'kids', join: null },
    ],
    ...overrides,
  }
}

describe('POST /api/rules', () => {
  it('creates a rule and returns vocabulary_warnings', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/rules',
      payload: ruleBody(),
    })
    expect(res.statusCode).toBe(201)
    const body = res.json<{
      id: number
      conditions: unknown[]
      vocabulary_warnings: string[]
    }>()
    expect(body.conditions).toHaveLength(1)
    expect(body.vocabulary_warnings).toEqual([])
  })

  it('rejects a dir_template outside the allowed roots', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/rules',
      payload: ruleBody({ dir_template: '/etc/passwd' }),
    })
    expect(res.statusCode).toBe(422)
  })

  it('rejects an unknown placeholder', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/rules',
      payload: ruleBody({ dir_template: '/media/{$nope}' }),
    })
    expect(res.statusCode).toBe(422)
  })

  it('rejects a missing join operator on the second condition', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/rules',
      payload: ruleBody({
        conditions: [
          { category: 'user', match_type: 'exact', match_value: 'kids', join: null },
          { category: 'genre', match_type: 'exact', match_value: 'Comedy', join: null },
        ],
      }),
    })
    expect(res.statusCode).toBe(422)
  })

  it('rescans the scoped app automatically, without a separate /rescan call', async () => {
    mockRadarr()
    const appRes = await ctx.app.inject({
      method: 'POST',
      url: '/api/apps',
      payload: {
        name: 'Radarr',
        type: 'radarr',
        url: 'http://radarr.local',
        api_key: 'k',
      },
    })
    const appId = appRes.json<{ id: number; last_poll_at: number | null }>().id
    expect(appRes.json<{ last_poll_at: number | null }>().last_poll_at).toBeNull()

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/rules',
      payload: ruleBody({ app_scope: appId }),
    })
    expect(res.statusCode).toBe(201)

    // triggerRescan() (see api/rules.ts) fires the poll in the background --
    // it must not block the save response -- so poll for its result instead
    // of asserting on it synchronously.
    await vi.waitFor(() => {
      const appNow = ctx.app.inject({ method: 'GET', url: `/api/apps/${appId}` })
      return appNow.then((r) => {
        expect(r.json<{ last_poll_at: number | null }>().last_poll_at).not.toBeNull()
      })
    })
  })

  it('rejects an invalid regex condition', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/rules',
      payload: ruleBody({
        conditions: [
          { category: 'user', match_type: 'regex', match_value: '(unclosed', join: null },
        ],
      }),
    })
    expect(res.statusCode).toBe(422)
  })
})

describe('GET/PATCH/DELETE /api/rules/:ruleId', () => {
  it('rescans the union of old+new scope on update, and the scope again on delete', async () => {
    mockRadarr()
    const mkApp = async (name: string): Promise<number> => {
      const r = await ctx.app.inject({
        method: 'POST',
        url: '/api/apps',
        payload: { name, type: 'radarr', url: 'http://radarr.local', api_key: 'k' },
      })
      return r.json<{ id: number }>().id
    }
    const appA = await mkApp('A')
    const appB = await mkApp('B')
    const lastPollAt = async (appId: number): Promise<number | null> => {
      const r = await ctx.app.inject({ method: 'GET', url: `/api/apps/${appId}` })
      return r.json<{ last_poll_at: number | null }>().last_poll_at
    }
    const resetPolls = (): void => {
      ctx.db.update(apps).set({ lastPollAt: null }).run()
    }

    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/rules',
      payload: ruleBody({ app_scope: appA }),
    })
    const ruleId = created.json<{ id: number }>().id
    await vi.waitFor(async () => expect(await lastPollAt(appA)).not.toBeNull())

    // Re-scoping from A to B should rescan both: B because it's newly in
    // scope, A because it's leaving scope and its now-stale links need
    // retiring promptly rather than waiting for A's next natural poll.
    resetPolls()
    const patch = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/rules/${ruleId}`,
      payload: ruleBody({ app_scope: appB }),
    })
    expect(patch.statusCode).toBe(200)
    await vi.waitFor(async () => {
      expect(await lastPollAt(appA)).not.toBeNull()
      expect(await lastPollAt(appB)).not.toBeNull()
    })

    // Deleting should rescan the rule's (now former) scope, B.
    resetPolls()
    const del = await ctx.app.inject({ method: 'DELETE', url: `/api/rules/${ruleId}` })
    expect(del.statusCode).toBe(204)
    await vi.waitFor(async () => expect(await lastPollAt(appB)).not.toBeNull())
  })

  it('round-trips a rule through update and delete', async () => {
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/rules',
      payload: ruleBody(),
    })
    const id = created.json<{ id: number }>().id

    const patch = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/rules/${id}`,
      payload: ruleBody({ name: 'kids v2', priority: 50 }),
    })
    expect(patch.statusCode).toBe(200)
    expect(patch.json<{ name: string; priority: number }>().priority).toBe(50)

    const list = await ctx.app.inject({ method: 'GET', url: '/api/rules' })
    expect(list.json<Array<{ id: number; link_count: number }>>()).toHaveLength(1)

    const del = await ctx.app.inject({ method: 'DELETE', url: `/api/rules/${id}` })
    expect(del.statusCode).toBe(204)
    const get = await ctx.app.inject({ method: 'GET', url: `/api/rules/${id}` })
    expect(get.statusCode).toBe(404)
  })
})

describe('POST /api/rules/vocabulary-check', () => {
  it('returns an empty warning list with no vocabulary configured', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/rules/vocabulary-check',
      payload: ruleBody(),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json<{ warnings: string[] }>().warnings).toEqual([])
  })

  it('checks against the union of every instance for a type-scoped rule, not just one', async () => {
    const appA = (
      await ctx.app.inject({
        method: 'POST',
        url: '/api/apps',
        payload: { name: 'A', type: 'radarr', url: 'http://a', api_key: 'k' },
      })
    ).json<{ id: number }>().id
    const appB = (
      await ctx.app.inject({
        method: 'POST',
        url: '/api/apps',
        payload: { name: 'B', type: 'radarr', url: 'http://b', api_key: 'k' },
      })
    ).json<{ id: number }>().id

    // A has a non-empty vocabulary (so the old single-representative check
    // wouldn't just no-op on a totally empty set) but doesn't know
    // "English" -- only B does. Old behavior: a type-scoped rule picked one
    // "representative" instance (lowest enabled id, i.e. A here) to check
    // against; "English" isn't in A's known set -> false-positive warning.
    // Fixed behavior: unions every instance of that type -> "English" is
    // known via B -> no warning.
    ctx.db
      .insert(vocabularyTable)
      .values([
        {
          category: 'language',
          appType: 'radarr',
          appId: appA,
          value: 'Spanish',
          source: 'instance',
          importedAt: 0,
        },
        {
          category: 'language',
          appType: 'radarr',
          appId: appB,
          value: 'English',
          source: 'instance',
          importedAt: 0,
        },
      ])
      .run()

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/rules/vocabulary-check',
      payload: ruleBody({
        app_type_scope: 'radarr',
        conditions: [
          {
            category: 'language',
            match_type: 'exact',
            match_value: 'English',
            join: null,
            source: 'native',
          },
        ],
      }),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json<{ warnings: string[] }>().warnings).toEqual([])
  })
})

describe('POST /api/rules/preview', () => {
  it('404s for an unknown app', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/rules/preview?app_id=999',
      payload: ruleBody(),
    })
    expect(res.statusCode).toBe(404)
  })

  it('falls back to a live fetch and surfaces the adapter error when never polled', async () => {
    const appRes = await ctx.app.inject({
      method: 'POST',
      url: '/api/apps',
      payload: { name: 'Radarr', type: 'radarr', url: 'http://x', api_key: 'k' },
    })
    const appId = appRes.json<{ id: number }>().id
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/rules/preview?app_id=${appId}`,
      payload: ruleBody(),
    })
    expect(res.statusCode).toBe(502)
  })
})
