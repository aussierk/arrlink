import { basename, extname, isAbsolute, normalize, parse, sep } from 'node:path'
import type { ConditionMatch } from './matching.js'

/**
 * Template engine: dir + filename resolution, sanitization, and the path
 * jail. Ported from core/template.py. Uses native `node:path`, not forced
 * POSIX, since this backend also targets native deployment on any host OS.
 * checkJail's traversal check runs on raw, unnormalized segments so a
 * literal `..` is rejected before `normalize` could collapse it away.
 */

// Default allowed root. Matches the common Docker/Linux setup (*arr media
// mounted at /media, links written under /media/linked). Still valid
// (root-relative) on Windows, but native Windows/macOS deployments should
// set `allowed_roots` to a real path instead of relying on this default.
export const DEFAULT_ROOTS = ['/media']

// Unsafe path-segment characters (Windows + POSIX + control).
// eslint-disable-next-line no-control-regex -- intentional
const ILLEGAL = /[\\/:*?"<>|\x00-\x1f]/g
const WS = /\s+/g
const PLACEHOLDER = /\{\$([A-Za-z0-9_]+)\}/g

// Placeholders valid regardless of which categories a rule matches on.
export const FIXED_PLACEHOLDERS = new Set([
  'app',
  'title',
  'year',
  'basename',
  'stem',
  'ext',
])

export class TemplateError extends Error {}

/** The resolved value for one category's matched condition. */
export interface CategoryCapture {
  /** The tag that satisfied the condition. */
  tag: string
  /** match[1] if the regex captured a group, else the tag. */
  value: string
}

export interface TemplateContext {
  /** category name -> CategoryCapture, for every matched condition */
  categories: Record<string, CategoryCapture>
  appName: string
  itemTitle: string
  itemYear: number | null
  srcBasename: string
  srcStem: string
  srcExt: string
}

function clean(value: string): string {
  let v = (value || '').replace(ILLEGAL, ' ')
  v = v.replace(WS, ' ').trim()
  v = v.replaceAll('..', '')
  return v.slice(0, 100)
}

function resolveToken(name: string, ctx: TemplateContext): string {
  if (name === 'app') return clean(ctx.appName)
  if (name === 'title') return clean(ctx.itemTitle)
  if (name === 'year') return ctx.itemYear !== null ? String(ctx.itemYear) : ''
  if (name === 'basename') return clean(ctx.srcBasename)
  if (name === 'stem') return clean(ctx.srcStem)
  if (name === 'ext') return ctx.srcExt || '' // keep verbatim -- carries the real file type
  // category-keyed capture (e.g. {$genre}, {$user}, ...)
  if (name in ctx.categories) return clean(ctx.categories[name].value)
  throw new TemplateError(`unknown placeholder {$${name}}`)
}

/** The placeholder names used in a template (for validation). */
export function findPlaceholders(template: string): string[] {
  return [...(template || '').matchAll(PLACEHOLDER)].map((m) => m[1])
}

/** Substitute every {$...} placeholder using the context. */
export function resolveTemplate(template: string | null, ctx: TemplateContext): string {
  if (template === null) throw new TemplateError('template is empty')
  return template.replace(PLACEHOLDER, (_whole, name: string) => resolveToken(name, ctx))
}

/** Turn a resolved (absolute) dir string into a safe, native absolute path
 * (POSIX, Windows drive-letter, or UNC). `path.parse`, not `normalize`, gives
 * the root without collapsing `..` before the traversal check below sees it. */
export function sanitizeDirPath(resolved: string): string {
  if (!isAbsolute(resolved)) {
    throw new TemplateError('dir template must resolve to an absolute path')
  }
  const { root } = parse(resolved)
  const rest = resolved.slice(root.length)
  const parts: string[] = []
  for (const raw of rest.split(/[\\/]+/)) {
    if (raw === '' || raw === '.') continue
    if (raw === '..') throw new TemplateError("path traversal ('..') not allowed")
    const c = clean(raw)
    if (c) parts.push(c)
  }
  if (parts.length === 0) {
    throw new TemplateError('dir template resolved to an empty path')
  }
  // Normalize the root's separator too, so the result is consistently native.
  return root.replace(/[\\/]/g, sep) + parts.join(sep)
}

export function sanitizeFilename(resolved: string): string {
  const c = clean(resolved)
  if (!c) throw new TemplateError('filename template resolved to an empty name')
  // never allow separators / traversal in a filename
  ILLEGAL.lastIndex = 0
  if (ILLEGAL.test(c))
    throw new TemplateError('filename template resolved to an unsafe name')
  return c
}

/** Ensure dirPath stays under one of the allowed roots. */
export function checkJail(dirPath: string, roots: string[]): void {
  const real = normalize(dirPath)
  for (const root of roots) {
    const r = normalize(root)
    if (real === r || real.startsWith(r + sep)) return
  }
  throw new TemplateError(
    `destination '${dirPath}' is outside the allowed root(s) ${JSON.stringify(roots)}`,
  )
}

/** Best-effort static prefix of a dir template (placeholders blanked) -- a
 * jail-check here is conservative: if the fixed part already escapes the
 * allowed roots, no placeholder value can ever fix it. */
export function staticPrefix(template: string | null): string {
  return normalize((template || '').replace(PLACEHOLDER, 'x'))
}

/** Names of enabled rules whose dir template escapes the allowed roots. Used
 * at startup and by the dashboard to surface legacy rules (e.g. after a
 * root-default change) -- pure over a caller-supplied rule list, not DB-aware. */
export function auditRuleRoots(
  rules: Array<{ name: string; dirTemplate: string }>,
  roots: string[],
): string[] {
  const bad: string[] = []
  for (const rule of rules) {
    try {
      checkJail(staticPrefix(rule.dirTemplate), roots)
    } catch (e) {
      if (e instanceof TemplateError) bad.push(rule.name)
      else throw e
    }
  }
  return bad
}

export function buildContext(
  matchedConditions: ConditionMatch[],
  appName: string,
  itemTitle: string,
  itemYear: number | null,
  srcPath: string,
): TemplateContext {
  const base = basename(srcPath)
  const ext = extname(base)
  const stem = ext ? base.slice(0, -ext.length) : base
  const categories: Record<string, CategoryCapture> = {}
  for (const cm of matchedConditions) {
    // match[0] is the whole match; match[1] is the first captured group.
    const value = cm.regexMatch && cm.regexMatch.length > 1 ? cm.regexMatch[1] : cm.tag
    categories[cm.category] = { tag: cm.tag, value: value ?? cm.tag }
  }
  return {
    categories,
    appName,
    itemTitle,
    itemYear,
    srcBasename: base,
    srcStem: stem,
    srcExt: ext,
  }
}

/** Resolve a rule + item + file to (dirPath, filename). Throws TemplateError
 * on any invalid template or jail violation. */
export function resolveDestination(
  dirTemplate: string,
  filenameTemplate: string | null,
  matchedConditions: ConditionMatch[],
  appName: string,
  itemTitle: string,
  itemYear: number | null,
  srcPath: string,
  roots: string[],
): { dirPath: string; filename: string } {
  const ctx = buildContext(matchedConditions, appName, itemTitle, itemYear, srcPath)
  const dirPath = sanitizeDirPath(resolveTemplate(dirTemplate, ctx))
  checkJail(dirPath, roots)

  let filename: string
  if (filenameTemplate) {
    filename = sanitizeFilename(resolveTemplate(filenameTemplate, ctx))
    // never drop the real source extension -- re-attach if missing (names
    // can themselves contain dots, e.g. "Inception.2010.2160p")
    if (ctx.srcExt && !filename.toLowerCase().endsWith(ctx.srcExt.toLowerCase())) {
      filename += ctx.srcExt
    }
  } else {
    filename = ctx.srcBasename
  }

  return { dirPath, filename }
}
