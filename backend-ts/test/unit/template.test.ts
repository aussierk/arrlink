import { describe, expect, it } from 'vitest'
import type { ConditionMatch } from '../../src/core/matching.js'
import {
  TemplateError,
  buildContext,
  checkJail,
  resolveTemplate,
  sanitizeDirPath,
  sanitizeFilename,
} from '../../src/core/template.js'

function matched(
  category: string,
  tag: string,
  regexMatch: RegExpMatchArray | null = null,
): ConditionMatch[] {
  return [{ category, tag, regexMatch }]
}

function resolve(
  dirT: string,
  fileT: string | null,
  ctx: ReturnType<typeof buildContext>,
): { d: string; f: string } {
  const d = sanitizeDirPath(resolveTemplate(dirT, ctx))
  checkJail(d, ['/linked'])
  let f: string
  if (fileT) {
    f = sanitizeFilename(resolveTemplate(fileT, ctx))
    if (ctx.srcExt && !f.toLowerCase().endsWith(ctx.srcExt.toLowerCase())) f += ctx.srcExt
  } else {
    f = ctx.srcBasename
  }
  return { d, f }
}

describe('template placeholders', () => {
  it('resolves fixed placeholders', () => {
    const ctx = buildContext(
      matched('certification', 'PG-13'),
      'Radarr',
      'Inception',
      2010,
      '/media/movies/Inception.2010.2160p.mkv',
    )
    const { d } = resolve('/linked/{$app}/{$certification}/{$title} ({$year})', null, ctx)
    expect(d).toBe('/linked/Radarr/PG-13/Inception (2010)')
  })

  it('uses the regex capture group as the placeholder value, not the whole matched tag', () => {
    const m = '## - alice'.match(/^##\s*-\s*(?<user>.+)$/)
    const ctx = buildContext(
      matched('user', '## - alice', m),
      'Radarr',
      'Inception',
      2010,
      '/media/movies/Inception.2010.2160p.mkv',
    )
    const { d, f } = resolve('/linked/movies/users/{$user}', null, ctx)
    expect(d).toBe('/linked/movies/users/alice')
    expect(f).toBe('Inception.2010.2160p.mkv') // source basename kept
  })

  it('resolves stem/ext/basename filename placeholders, re-attaching the real extension', () => {
    const ctx = buildContext(
      matched('custom', 'kids'),
      'Radarr',
      'Inception',
      2010,
      '/media/movies/Inception.2010.2160p.mkv',
    )
    expect(resolve('/linked/movies/kids', '{$stem}', ctx).f).toBe(
      'Inception.2010.2160p.mkv',
    )
    expect(resolve('/linked/movies/kids', '{$title}{$ext}', ctx).f).toBe('Inception.mkv')
    expect(resolve('/linked/movies/kids', '{$basename}', ctx).f).toBe(
      'Inception.2010.2160p.mkv',
    )
  })

  it('sanitizes illegal characters to spaces and collapses whitespace', () => {
    const ctx = buildContext(
      matched('custom', 'a/b\\c:d*e"<>|'),
      'Radarr',
      'T',
      2010,
      '/media/movies/T.mkv',
    )
    const { d } = resolve('/linked/{$custom}', null, ctx)
    expect(d).toBe('/linked/a b c d e')
    expect(d.split('/linked/')[1]).not.toContain('/')
  })

  it('throws for an unknown placeholder', () => {
    const ctx = buildContext(
      matched('custom', 'x'),
      'Radarr',
      'T',
      2010,
      '/media/movies/T.mkv',
    )
    expect(() => resolveTemplate('/linked/{$nope}', ctx)).toThrow(/unknown placeholder/)
  })
})

describe('path jail', () => {
  it('rejects a dir template that resolves outside the jail via ..', () => {
    const ctx = buildContext(
      matched('custom', 'x'),
      'Radarr',
      'T',
      2010,
      '/media/movies/T.mkv',
    )
    expect(() => sanitizeDirPath(resolveTemplate('/linked/../etc', ctx))).toThrow(
      TemplateError,
    )
  })

  it('rejects a path outside the allowed roots', () => {
    expect(() => checkJail('/etc/evil', ['/linked'])).toThrow(TemplateError)
  })

  it('rejects a sibling directory that merely shares a prefix', () => {
    expect(() => checkJail('/linkedx', ['/linked'])).toThrow(TemplateError)
  })

  it('allows a real child path and the root itself', () => {
    expect(() => checkJail('/linked/movies/kids', ['/linked'])).not.toThrow()
    expect(() => checkJail('/linked', ['/linked'])).not.toThrow()
  })
})
