import { describe, expect, it } from 'vitest'
import type { ConditionItem } from '../../lib/api'
import {
  creatableFor,
  decodeServiceValue,
  encodeServiceValue,
  selectedFor,
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
