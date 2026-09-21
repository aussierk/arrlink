import { sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { planLinks, type PlannerItem, type PlannerRule } from '../../src/core/planner.js'

// planLinks joins dirPath+filename with the native path module (this
// backend targets native deployment on any host OS), so expected dst
// paths are built the same way rather than hardcoded as POSIX literals.
function P(...segments: string[]): string {
  return segments.join(sep)
}

function rule(overrides: Partial<PlannerRule>): PlannerRule {
  return {
    id: 1,
    name: 'r',
    appScope: null,
    appTypeScope: null,
    conditions: [],
    dirTemplate: '/linked/x',
    filenameTemplate: null,
    enabled: true,
    priority: 100,
    ...overrides,
  }
}

describe('planLinks', () => {
  it('plans links for matching rules and skips disabled ones', () => {
    const rules: PlannerRule[] = [
      rule({
        id: 1,
        name: 'kids',
        conditions: [
          { category: 'custom', matchType: 'exact', matchValue: 'kids', join: null },
        ],
        dirTemplate: '/linked/movies/kids',
      }),
      rule({
        id: 2,
        name: 'users',
        conditions: [
          {
            category: 'user',
            matchType: 'regex',
            matchValue: '^##\\s*-\\s*(?P<user>.+)$',
            join: null,
          },
        ],
        dirTemplate: '/linked/movies/users/{$user}',
      }),
    ]
    const items: PlannerItem[] = [
      {
        id: 1,
        title: 'Inception',
        year: 2010,
        tags: ['4k', '## - alice'],
        path: '',
        files: [
          { id: null, absPath: '/media/movies/Inception.2010.2160p.mkv', inode: null },
        ],
      },
      {
        id: 2,
        title: 'Kids Movie',
        year: 2019,
        tags: ['kids'],
        path: '',
        files: [
          {
            id: null,
            absPath: '/media/movies/Kids Movie/Kids Movie.2019.mkv',
            inode: null,
          },
        ],
      },
    ]

    const { planned, errors } = planLinks(rules, items, 'Radarr', 1, ['/linked'])
    expect(errors).toEqual([])
    const dsts = planned.map((p) => p.dstPath).sort()
    expect(dsts).toEqual(
      [
        P('', 'linked', 'movies', 'kids', 'Kids Movie.2019.mkv'),
        P('', 'linked', 'movies', 'users', 'alice', 'Inception.2010.2160p.mkv'),
      ].sort(),
    )

    rules[0].enabled = false
    const second = planLinks(rules, items, 'Radarr', 1, ['/linked'])
    expect(second.planned).toHaveLength(1)
  })

  it('reports a jail-violation template as a plan error instead of throwing', () => {
    const rules: PlannerRule[] = [
      rule({
        id: 1,
        name: 'bad',
        conditions: [
          { category: 'custom', matchType: 'exact', matchValue: 'kids', join: null },
        ],
        dirTemplate: '/etc/evil/{$custom}',
      }),
    ]
    const items: PlannerItem[] = [
      {
        id: 2,
        title: 'Kids Movie',
        year: 2019,
        tags: ['kids'],
        path: '',
        files: [
          {
            id: null,
            absPath: '/media/movies/Kids Movie/Kids Movie.2019.mkv',
            inode: null,
          },
        ],
      },
    ]
    const { planned, errors } = planLinks(rules, items, 'Radarr', 1, ['/linked'])
    expect(planned).toEqual([])
    expect(errors).toHaveLength(1)
    expect(errors[0].error).toMatch(/outside/)
  })

  it('scopes a rule to a specific app id', () => {
    const rules: PlannerRule[] = [
      rule({
        appScope: 42,
        dirTemplate: '/linked/x',
        conditions: [{ category: 'c', matchType: 'exact', matchValue: 'x', join: null }],
      }),
    ]
    const items: PlannerItem[] = [
      {
        id: 1,
        title: 'T',
        year: null,
        tags: ['x'],
        path: '',
        files: [{ id: null, absPath: '/m/t.mkv', inode: null }],
      },
    ]

    expect(planLinks(rules, items, 'Radarr', 42, ['/linked']).planned).toHaveLength(1)
    expect(planLinks(rules, items, 'Radarr', 99, ['/linked']).planned).toHaveLength(0)
  })

  it('scopes a rule to an app type when no specific app_scope is set', () => {
    const rules: PlannerRule[] = [
      rule({
        appTypeScope: 'sonarr',
        conditions: [{ category: 'c', matchType: 'exact', matchValue: 'x', join: null }],
      }),
    ]
    const items: PlannerItem[] = [
      {
        id: 1,
        title: 'T',
        year: null,
        tags: ['x'],
        path: '',
        files: [{ id: null, absPath: '/m/t.mkv', inode: null }],
      },
    ]
    expect(
      planLinks(rules, items, 'Sonarr', 1, ['/linked'], 'sonarr').planned,
    ).toHaveLength(1)
    expect(
      planLinks(rules, items, 'Radarr', 1, ['/linked'], 'radarr').planned,
    ).toHaveLength(0)
  })

  it('fans a multi-tag match out into multiple links without duplicating identical destinations', () => {
    const rules: PlannerRule[] = [
      rule({
        conditions: [
          { category: 'custom', matchType: 'regex', matchValue: '^4k', join: null },
        ],
        dirTemplate: '/linked/{$custom}',
      }),
    ]
    const items: PlannerItem[] = [
      {
        id: 1,
        title: 'T',
        year: null,
        tags: ['4k-hdr', '4k-sdr'],
        path: '',
        files: [{ id: null, absPath: '/m/t.mkv', inode: null }],
      },
    ]
    const { planned } = planLinks(rules, items, 'Radarr', 1, ['/linked'])
    expect(planned.map((p) => p.dstPath).sort()).toEqual(
      [P('', 'linked', '4k-hdr', 't.mkv'), P('', 'linked', '4k-sdr', 't.mkv')].sort(),
    )
    expect(new Set(planned.map((p) => p.matchKey)).size).toBe(2)
  })

  it('drops the stored inode for stale (delta-skipped) files so the reconciler re-stats the source', () => {
    const rules: PlannerRule[] = [
      rule({
        conditions: [{ category: 'c', matchType: 'exact', matchValue: 'x', join: null }],
      }),
    ]
    const items: PlannerItem[] = [
      {
        id: 1,
        title: 'T',
        year: null,
        tags: ['x'],
        path: '',
        filesStale: true,
        files: [{ id: 5, absPath: '/m/t.mkv', inode: 999 }],
      },
    ]
    const { planned } = planLinks(rules, items, 'Radarr', 1, ['/linked'])
    expect(planned[0].srcInode).toBeNull()
  })

  it('sorts active rules by priority then id', () => {
    const rules: PlannerRule[] = [
      rule({
        id: 2,
        priority: 50,
        dirTemplate: '/linked/second',
        conditions: [{ category: 'c', matchType: 'exact', matchValue: 'x', join: null }],
      }),
      rule({
        id: 1,
        priority: 10,
        dirTemplate: '/linked/first',
        conditions: [{ category: 'c', matchType: 'exact', matchValue: 'x', join: null }],
      }),
    ]
    const items: PlannerItem[] = [
      {
        id: 1,
        title: 'T',
        year: null,
        tags: ['x'],
        path: '',
        files: [{ id: null, absPath: '/m/t.mkv', inode: null }],
      },
    ]
    const { planned } = planLinks(rules, items, 'Radarr', 1, ['/linked'])
    expect(planned.map((p) => p.ruleId)).toEqual([1, 2])
  })
})
