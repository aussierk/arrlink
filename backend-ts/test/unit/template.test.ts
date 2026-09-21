import { sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ConditionMatch } from '../../src/core/matching.js'
import {
  TemplateError,
  buildContext,
  checkJail,
  resolveDestination,
  resolveTemplate,
  sanitizeDirPath,
  sanitizeFilename,
} from '../../src/core/template.js'

// Expected outputs are built with the native separator throughout: this
// backend targets native deployment on any host OS (not just Docker/Linux),
// so sanitizeDirPath/checkJail adapt to whatever platform they run on --
// these tests validate that adaptation, not one hardcoded style.
function P(...segments: string[]): string {
  return segments.join(sep)
}

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
    expect(d).toBe(P('', 'linked', 'Radarr', 'PG-13', 'Inception (2010)'))
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
    expect(d).toBe(P('', 'linked', 'movies', 'users', 'alice'))
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
    expect(d).toBe(P('', 'linked', 'a b c d e'))
    // no separator of either style leaked through into the sanitized segment
    expect(d.slice(d.lastIndexOf(sep) + 1)).not.toMatch(/[\\/]/)
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

describe('resolveDestination dir auto-append', () => {
  it("appends the item's own source directory basename under the rule's categorization prefix", () => {
    const { dirPath, filename } = resolveDestination(
      '/linked/movies/{$genre}',
      null,
      matched('genre', 'Comedy'),
      'Radarr',
      'Aloha Scooby-Doo!',
      2005,
      '/media/movies/Aloha Scooby-Doo! (2005) [tmdbid-24615]/Aloha Scooby-Doo!.mkv',
      ['/linked'],
      '/media/movies/Aloha Scooby-Doo! (2005) [tmdbid-24615]',
    )
    expect(dirPath).toBe(
      P('', 'linked', 'movies', 'Comedy', 'Aloha Scooby-Doo! (2005) [tmdbid-24615]'),
    )
    expect(filename).toBe('Aloha Scooby-Doo!.mkv')
  })

  it('leaves dirPath unchanged when no item path is given', () => {
    const { dirPath } = resolveDestination(
      '/linked/movies/kids',
      null,
      matched('custom', 'kids'),
      'Radarr',
      'T',
      2010,
      '/media/movies/T.mkv',
      ['/linked'],
    )
    expect(dirPath).toBe(P('', 'linked', 'movies', 'kids'))
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

  it('rejects escaping via a literal traversal segment even when mixed with the native separator', () => {
    expect(() => sanitizeDirPath(`/linked${sep}..${sep}etc`)).toThrow(TemplateError)
  })
})

describe('cross-platform root handling', () => {
  // A Windows drive-letter path (e.g. C:/media/...) is only absolute on
  // Windows -- path.isAbsolute correctly returns false for it on POSIX,
  // where it's just an unusual relative segment. This test validates
  // Windows-specific behavior, so it only makes sense to run there.
  it.runIf(process.platform === 'win32')(
    'sanitizes a Windows drive-letter absolute path, preserving the drive root',
    () => {
      const d = sanitizeDirPath('C:/media/movies/kids')
      expect(d.startsWith('C:')).toBe(true)
    },
  )

  it('rejects a relative path regardless of platform', () => {
    expect(() => sanitizeDirPath('relative/path')).toThrow(TemplateError)
    expect(() => sanitizeDirPath('relative\\path')).toThrow(TemplateError)
  })
})
