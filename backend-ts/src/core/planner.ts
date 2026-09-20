import { join } from 'node:path'
import type { Condition, ConditionMatch, ConditionsResult } from './matching.js'
import { matchConditions } from './matching.js'
import { TemplateError, resolveDestination } from './template.js'

/** Ported from core/planner.py: given rules + a snapshot of items/files, decide
 * the destination for each file. */

export interface PlanError {
  itemTitle: string
  srcPath: string
  ruleName: string
  error: string
}

export interface PlannedLink {
  ruleId: number
  ruleName: string
  itemId: number
  itemTitle: string
  srcPath: string
  dstPath: string
  fileId: number | null
  /** The current source file's inode, as stat'd when the snapshot was built. Lets the
   * reconciler skip re-stat'ing the source on every poll. Null if unavailable. */
  srcInode: number | null
  /** "" for the rule's primary destination; "category=tag" for a fan-out extra (when a
   * condition matched more than one of the item's tags). Stable across polls (tied to the
   * matched tag, not the resolved path), so a rename that only changes the resolved dst_path
   * is still tracked as the same link identity by the reconciler. */
  matchKey: string
}

export interface PlannerRule {
  id: number
  name: string
  appScope: number | null
  appTypeScope: string | null
  conditions: Condition[]
  dirTemplate: string
  filenameTemplate: string | null
  enabled: boolean
  priority: number
}

export interface PlannerFile {
  id: number | null
  absPath: string
  inode: number | null
  size?: number | null
}

export interface PlannerItem {
  id: number
  title: string
  year: number | null
  tags: string[]
  genres?: string[]
  certification?: string | null
  collection?: string | null
  qualityProfileName?: string | null
  originalLanguage?: string | null
  filesStale?: boolean
  files: PlannerFile[]
}

/**
 * Every (matchKey, matchedConditions) variant to resolve for one (rule,
 * item): the primary combination, plus one variant per extra tag beyond
 * the first in any category that matched more than one -- a union across
 * conditions, not a cross-product (two multi-matching conditions add their
 * extra variants independently rather than combining).
 */
function fanoutVariants(cr: ConditionsResult): Array<[string, ConditionMatch[]]> {
  const variants: Array<[string, ConditionMatch[]]> = [['', cr.matchedConditions]]
  for (const [category, matches] of Object.entries(cr.allMatches)) {
    for (const extra of matches.slice(1)) {
      const variant = cr.matchedConditions.map((cm) =>
        cm.category === category ? extra : cm,
      )
      variants.push([`${category}=${extra.tag}`, variant])
    }
  }
  return variants
}

/**
 * The item's real Radarr/Sonarr metadata, keyed by condition category, for
 * conditions with source == "native". Single-valued fields become a
 * 0-or-1-element list so matchRuleAll's exact/list/regex matching (which
 * all operate over a list of candidate strings) works unchanged regardless
 * of source.
 */
function nativeValues(it: PlannerItem): Record<string, string[]> {
  return {
    genre: it.genres ?? [],
    certification: it.certification ? [it.certification] : [],
    collection: it.collection ? [it.collection] : [],
    quality: it.qualityProfileName ? [it.qualityProfileName] : [],
    language: it.originalLanguage ? [it.originalLanguage] : [],
  }
}

/** Does this rule's scope cover the given app? */
function ruleAppliesToApp(
  rule: PlannerRule,
  appId: number | null,
  appType: string | null,
): boolean {
  if (rule.appScope !== null) return rule.appScope === appId
  if (rule.appTypeScope !== null) return rule.appTypeScope === appType
  return true
}

/** Compute the set of links the given rules would create for the snapshot. */
export function planLinks(
  rules: PlannerRule[],
  items: PlannerItem[],
  appName: string,
  appId: number | null,
  roots: string[],
  appType: string | null = null,
): { planned: PlannedLink[]; errors: PlanError[] } {
  const active = rules
    .filter((r) => r.enabled && ruleAppliesToApp(r, appId, appType))
    .sort((a, b) => a.priority - b.priority || a.id - b.id)

  const planned: PlannedLink[] = []
  const errors: PlanError[] = []

  for (const item of items) {
    const tags = item.tags ?? []
    const native = nativeValues(item)
    const files = item.files ?? []

    // Rule matching depends only on the item's tags/native metadata, not
    // on individual files -- evaluate it once per (item, rule) and reuse
    // for every file, rather than re-running it.
    for (const rule of active) {
      const cr = matchConditions(rule.conditions, tags, native)
      if (!cr.result) continue
      const variants = fanoutVariants(cr)

      for (const f of files) {
        const src = f.absPath
        // filesStale => this item's files came from the stored snapshot,
        // not a fresh adapter fetch (Sonarr delta-skip), so the stored
        // inode could lag a same-size file replacement. Drop it so the
        // reconciler does a live source stat instead.
        const srcInode = item.filesStale ? null : f.inode
        const seenDstPaths = new Set<string>()

        for (const [matchKey, matchedConditions] of variants) {
          let dirPath: string
          let filename: string
          try {
            ;({ dirPath, filename } = resolveDestination(
              rule.dirTemplate,
              rule.filenameTemplate,
              matchedConditions,
              appName,
              item.title,
              item.year,
              src,
              roots,
            ))
          } catch (e) {
            if (e instanceof TemplateError) {
              errors.push({
                itemTitle: item.title,
                srcPath: src,
                ruleName: rule.name,
                error: e.message,
              })
              continue
            }
            throw e
          }
          const dstPath = join(dirPath, filename)
          if (seenDstPaths.has(dstPath)) {
            // two matching tags resolved to the same destination (e.g. the
            // varying category isn't referenced by the template) -- one
            // link, not a duplicate.
            continue
          }
          seenDstPaths.add(dstPath)
          planned.push({
            ruleId: rule.id,
            ruleName: rule.name,
            itemId: item.id,
            itemTitle: item.title,
            srcPath: src,
            dstPath,
            fileId: f.id,
            srcInode,
            matchKey,
          })
        }
      }
    }
  }

  return { planned, errors }
}
