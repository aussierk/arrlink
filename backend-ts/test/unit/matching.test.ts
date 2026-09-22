import { describe, expect, it } from 'vitest'
import { matchConditions, matchRule, matchRuleAll } from '../../src/core/matching.js'

describe('matchRule / matchRuleAll: exact', () => {
  it('matches an item tag exactly', () => {
    const m = matchRule('exact', 'kids', ['kids', '4k'])
    expect(m?.tag).toBe('kids')
    expect(matchRule('exact', 'kids', ['nope'])).toBeNull()
  })

  it('trims the match value before comparing', () => {
    expect(matchRule('exact', '  kids  ', ['kids'])?.tag).toBe('kids')
  })
})

describe('matchRule / matchRuleAll: list', () => {
  it('matches comma-separated values, trimming whitespace', () => {
    expect(matchRule('list', 'kids, 4k, hdr', ['hdr'])?.tag).toBe('hdr')
    expect(matchRule('list', 'kids , 4k', ['4k'])).not.toBeNull()
    expect(matchRule('list', 'kids,4k', ['nope'])).toBeNull()
  })

  it('accepts a JSON array as the match value', () => {
    expect(matchRule('list', '["kids","4k"]', ['4k'])?.tag).toBe('4k')
  })
})

describe('matchRule / matchRuleAll: regex', () => {
  it('captures a Python-style named group', () => {
    const m = matchRule('regex', '^##\\s*-\\s*(?P<user>.+)$', ['## - alice'])
    expect(m).not.toBeNull()
    expect(m!.regexMatch).not.toBeNull()
    expect(m!.regexMatch!.groups?.user).toBe('alice')
    expect(m!.regexMatch!.slice(1)).toEqual(['alice'])
  })

  it('returns no match for a non-matching pattern', () => {
    expect(matchRule('regex', '^##\\s*-\\s*(?P<user>.+)$', ['kids'])).toBeNull()
  })

  it('treats an invalid regex as never matching rather than throwing', () => {
    expect(matchRule('regex', 'bad[regex', ['x'])).toBeNull()
  })

  it('returns every matching tag, not just the first', () => {
    const all = matchRuleAll('regex', '^4k', ['4k-hdr', '4k-sdr', 'kids'])
    expect(all.map((m) => m.tag)).toEqual(['4k-hdr', '4k-sdr'])
  })

  it('caches compiled patterns without changing behavior on repeated use', () => {
    const pattern = '^##\\s*-\\s*(?P<user>.+)$'
    for (let i = 0; i < 3; i++) {
      expect(matchRule('regex', pattern, ['## - bob'])?.regexMatch?.groups?.user).toBe(
        'bob',
      )
    }
  })
})

describe('matchRule / matchRuleAll: range', () => {
  it('matches an open-ended lower bound ("rating >= 7")', () => {
    expect(matchRuleAll('range', '{"min":7}', ['6.9', '7', '9.5']).map((m) => m.tag)).toEqual(
      ['7', '9.5'],
    )
  })

  it('matches an open-ended upper bound ("runtime <= 90")', () => {
    expect(
      matchRuleAll('range', '{"min":null,"max":90}', ['45', '90', '91']).map((m) => m.tag),
    ).toEqual(['45', '90'])
  })

  it('matches a closed min/max range, inclusive on both ends', () => {
    expect(
      matchRuleAll('range', '{"min":5,"max":8}', ['4.9', '5', '8', '8.1']).map((m) => m.tag),
    ).toEqual(['5', '8'])
  })

  it('ignores non-numeric candidate values instead of throwing', () => {
    expect(matchRuleAll('range', '{"min":1}', ['abc', '2'])).toEqual([
      { tag: '2', regexMatch: null },
    ])
  })

  it('never matches for malformed range JSON (no bound, bad JSON, non-numeric bound)', () => {
    expect(matchRuleAll('range', '{}', ['5'])).toEqual([])
    expect(matchRuleAll('range', 'not json', ['5'])).toEqual([])
    expect(matchRuleAll('range', '{"min":"x"}', ['5'])).toEqual([])
  })
})

describe('matchConditions', () => {
  it('returns false with no conditions', () => {
    expect(matchConditions([], ['kids'])).toEqual({
      result: false,
      matchedConditions: [],
      allMatches: {},
    })
  })

  it('ANDs two conditions', () => {
    const r = matchConditions(
      [
        { category: 'custom', matchType: 'exact', matchValue: 'kids', join: null },
        { category: 'custom', matchType: 'exact', matchValue: '4k', join: 'AND' },
      ],
      ['kids', '4k'],
    )
    expect(r.result).toBe(true)
  })

  it('short-circuits AND without evaluating the second condition', () => {
    const r = matchConditions(
      [
        { category: 'custom', matchType: 'exact', matchValue: 'kids', join: null },
        { category: 'custom', matchType: 'exact', matchValue: '4k', join: 'AND' },
      ],
      ['nope'],
    )
    expect(r.result).toBe(false)
    // the second condition was never evaluated -- no match recorded for it
    expect(r.allMatches.custom).toBeUndefined()
  })

  it('ORs two conditions', () => {
    const r = matchConditions(
      [
        { category: 'custom', matchType: 'exact', matchValue: 'kids', join: null },
        { category: 'custom', matchType: 'exact', matchValue: '4k', join: 'OR' },
      ],
      ['4k'],
    )
    expect(r.result).toBe(true)
  })

  it('short-circuits OR without evaluating the second condition once true', () => {
    const r = matchConditions(
      [
        { category: 'custom', matchType: 'exact', matchValue: 'kids', join: null },
        { category: 'genre', matchType: 'exact', matchValue: 'Horror', join: 'OR' },
      ],
      ['kids'],
    )
    expect(r.result).toBe(true)
    expect(r.allMatches.genre).toBeUndefined()
  })

  it('reads native metadata for source: native conditions instead of tags', () => {
    const r = matchConditions(
      [
        {
          category: 'genre',
          matchType: 'exact',
          matchValue: 'Horror',
          join: null,
          source: 'native',
        },
      ],
      ['unrelated-tag'],
      { genre: ['Horror'] },
    )
    expect(r.result).toBe(true)
    expect(r.matchedConditions[0]).toMatchObject({ category: 'genre', tag: 'Horror' })
  })

  it('matches native metadata case-insensitively (exact and list), unlike tags', () => {
    // Radarr/Sonarr's own fields are a fixed Title Case ("English", not
    // "english") -- a user typing lowercase in the rule editor shouldn't
    // get a silent zero-match.
    const exact = matchConditions(
      [
        {
          category: 'language',
          matchType: 'exact',
          matchValue: 'english',
          join: null,
          source: 'native',
        },
      ],
      [],
      { language: ['English'] },
    )
    expect(exact.result).toBe(true)

    const list = matchConditions(
      [
        {
          category: 'language',
          matchType: 'list',
          matchValue: 'english,spanish',
          join: null,
          source: 'native',
        },
      ],
      [],
      { language: ['English'] },
    )
    expect(list.result).toBe(true)

    // Tags stay case-sensitive -- same values, but as a plain (non-native) condition.
    const tag = matchConditions(
      [{ category: 'custom', matchType: 'exact', matchValue: 'english', join: null }],
      ['English'],
    )
    expect(tag.result).toBe(false)
  })

  it('treats audio_language as a distinct native category from language', () => {
    // A foreign-language film with an English dub: originalLanguage stays
    // "Spanish" (production language), but the file's own audio track is
    // "English" -- the two categories must not be conflated.
    const native = { language: ['Spanish'], audio_language: ['English'] }

    const matchesFileLanguage = matchConditions(
      [
        {
          category: 'audio_language',
          matchType: 'exact',
          matchValue: 'English',
          join: null,
          source: 'native',
        },
      ],
      [],
      native,
    )
    expect(matchesFileLanguage.result).toBe(true)

    const missesOriginalLanguage = matchConditions(
      [
        {
          category: 'language',
          matchType: 'exact',
          matchValue: 'English',
          join: null,
          source: 'native',
        },
      ],
      [],
      native,
    )
    expect(missesOriginalLanguage.result).toBe(false)
  })

  it('records every matching tag for a category, not just the first (fan-out source)', () => {
    const r = matchConditions(
      [{ category: 'custom', matchType: 'regex', matchValue: '^4k', join: null }],
      ['4k-hdr', '4k-sdr'],
    )
    expect(r.result).toBe(true)
    expect(r.allMatches.custom.map((m) => m.tag)).toEqual(['4k-hdr', '4k-sdr'])
    // matchedConditions carries only the first, for the primary destination
    expect(r.matchedConditions).toHaveLength(1)
    expect(r.matchedConditions[0].tag).toBe('4k-hdr')
  })
})
