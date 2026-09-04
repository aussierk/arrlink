import { describe, expect, it } from 'vitest'
import { joinList, parseList } from './tagOptions'

describe('parseList', () => {
  it('splits, trims, and drops blanks', () => {
    expect(parseList('a, b ,  c')).toEqual(['a', 'b', 'c'])
    expect(parseList(' , a ,, ')).toEqual(['a'])
    expect(parseList('')).toEqual([])
  })
})

describe('joinList', () => {
  it('dedupes and comma-joins', () => {
    expect(joinList(['a', 'b', 'a'])).toBe('a,b')
    expect(joinList([])).toBe('')
  })

  it('round-trips with parseList', () => {
    expect(parseList(joinList(['x', 'y', 'x']))).toEqual(['x', 'y'])
  })
})
