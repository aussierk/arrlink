import { describe, expect, it } from 'vitest'
import type { ConditionItem, TagItem, VocabularyEntry } from '../../lib/api'
import {
  computeCustomOptions,
  creatableFor,
  decodeServiceValue,
  encodeServiceValue,
  nextMatchValueForSelection,
  optionsForCategory,
  reorderConditions,
  selectedFor,
  type Vocab,
} from './helpers'

describe('encode/decodeServiceValue', () => {
  it('round-trips "any service"', () => {
    const v = encodeServiceValue(null, null)
    expect(v).toBe('')
    expect(decodeServiceValue(v)).toEqual({ app_scope: null, app_type_scope: null })
  })

  it('round-trips a type scope', () => {
    const v = encodeServiceValue(null, 'sonarr')
    expect(v).toBe('type:sonarr')
    expect(decodeServiceValue(v)).toEqual({ app_scope: null, app_type_scope: 'sonarr' })
  })

  it('round-trips a specific app id', () => {
    const v = encodeServiceValue(7, null)
    expect(v).toBe('7')
    expect(decodeServiceValue(v)).toEqual({ app_scope: 7, app_type_scope: null })
  })

  it('prefers the type scope when both are somehow set', () => {
    expect(encodeServiceValue(7, 'radarr')).toBe('type:radarr')
  })
})

describe('selectedFor', () => {
  const cond = (
    match_type: ConditionItem['match_type'],
    match_value: string,
  ): ConditionItem => ({ category: 'genre', join: null, match_type, match_value })

  it('splits a list match_value', () => {
    expect(selectedFor(cond('list', 'a, b ,c'))).toEqual(['a', 'b', 'c'])
  })

  it('wraps a single non-list value, or nothing when empty', () => {
    expect(selectedFor(cond('exact', 'x'))).toEqual(['x'])
    expect(selectedFor(cond('exact', ''))).toEqual([])
  })
})

describe('creatableFor', () => {
  it('blocks free text only for the vocabulary match type', () => {
    expect(creatableFor('vocabulary')).toBe(false)
    expect(creatableFor('list')).toBe(true)
    expect(creatableFor('regex')).toBe(true)
  })
})

describe('reorderConditions', () => {
  const cond = (
    category: ConditionItem['category'],
    join: ConditionItem['join'],
  ): ConditionItem => ({ category, match_type: 'list', match_value: 'x', join })

  it('moves an item and renormalizes joins (index 0 is always null)', () => {
    const conditions = [cond('genre', null), cond('language', 'AND'), cond('quality', 'OR')]
    const result = reorderConditions(conditions, 2, 0)
    expect(result.map((c) => c.category)).toEqual(['quality', 'genre', 'language'])
    expect(result[0].join).toBeNull()
    expect(result[1].join).toBe('AND') // backfilled -- freed up by the move
    expect(result[2].join).toBe('AND') // kept
  })

  it('is a no-op when the target index is out of range', () => {
    const conditions = [cond('genre', null), cond('language', 'AND')]
    expect(reorderConditions(conditions, 0, 5)).toBe(conditions)
    expect(reorderConditions(conditions, 0, -1)).toBe(conditions)
  })
})

describe('nextMatchValueForSelection', () => {
  it('adds and removes tags from a list match_value', () => {
    expect(nextMatchValueForSelection('list', 'a,b', ['a', 'b'], ['a', 'c'])).toBe('a,c')
  })

  it('dedupes when the added tag is already present', () => {
    expect(nextMatchValueForSelection('list', 'a,b', ['a'], ['a', 'b'])).toBe('a,b')
  })

  it('replaces the value outright for a non-list match type', () => {
    expect(nextMatchValueForSelection('exact', 'old', [], ['new'])).toBe('new')
    expect(nextMatchValueForSelection('exact', 'old', ['old'], [])).toBe('')
  })
})

describe('computeCustomOptions', () => {
  const tag = (label: string): TagItem => ({
    id: 1,
    app_id: 1,
    label,
    count: 1,
    rule_count: 0,
    imported_at: 0,
    category: null,
  })
  const vocabEntry = (value: string): VocabularyEntry => ({
    value,
    source: 'tmdb',
    external_id: null,
    app_id: null,
  })

  it('includes app tags and the static suggestions, excluding known vocabulary values', () => {
    const tags = [tag('hd'), tag('Action')]
    const vocab: Vocab = { genre: [vocabEntry('Action')] }
    const result = computeCustomOptions(tags, vocab)
    expect(result).toContain('hd')
    expect(result).not.toContain('Action') // already a known genre, not "custom"
    expect(result).toEqual(expect.arrayContaining(['kids', 'children', 'family']))
  })

  it('dedupes', () => {
    const result = computeCustomOptions([tag('kids')], {})
    expect(result.filter((v) => v === 'kids')).toHaveLength(1)
  })
})

describe('optionsForCategory', () => {
  const tag = (label: string, category: TagItem['category']): TagItem => ({
    id: 1,
    app_id: 1,
    label,
    count: 1,
    rule_count: 0,
    imported_at: 0,
    category,
  })
  const vocabEntry = (value: string): VocabularyEntry => ({
    value,
    source: 'tmdb',
    external_id: null,
    app_id: null,
  })

  it('merges vocabulary values with manually classified tags for a rich category', () => {
    const vocab: Vocab = { genre: [vocabEntry('Action')] }
    const tags = [tag('Thriller', 'genre'), tag('hd', null)]
    expect(optionsForCategory('genre', vocab, tags, [])).toEqual(
      expect.arrayContaining(['Action', 'Thriller']),
    )
  })

  it('returns the precomputed custom options for the custom category', () => {
    expect(optionsForCategory('custom', {}, [], ['a', 'b'])).toEqual(['a', 'b'])
  })

  it('returns nothing for the user category', () => {
    expect(optionsForCategory('user', {}, [], ['a'])).toEqual([])
  })
})
