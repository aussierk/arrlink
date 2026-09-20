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
  /** Source inode as stat'd when the snapshot was built, so the reconciler can skip
   * re-stat'ing it every poll. Null if unavailable. */
  srcInode: number | null
  /** "" for the rule's primary destination; "category=tag" for a fan-out extra. Tied to the
   * matched tag (not the resolved path), so a rename keeps the same link identity. */
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

/** Every (matchKey, matchedConditions) variant for one (rule, item): the primary
 * combination, plus one per extra matching tag -- a union across conditions, not a
 * cross-product. */
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

/** The item's real Radarr/Sonarr metadata, keyed by condition category, for
 * source == "native" conditions. Single-valued fields become 0-or-1-element
 * lists so matchRuleAll works unchanged regardless of source. */
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
export function ruleAppliesToApp(
  rule: Pick<PlannerRule, 'appScope' | 'appTypeScope'>,
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

    // Rule matching depends only on tags/native metadata, not files --
    // evaluate once per (item, rule), reuse for every file.
    for (const rule of active) {
      const cr = matchConditions(rule.conditions, tags, native)
      if (!cr.result) continue
      const variants = fanoutVariants(cr)

      for (const f of files) {
        const src = f.absPath
        // filesStale (Sonarr delta-skip) means the stored inode could lag a
        // same-size replacement -- drop it so the reconciler re-stats live.
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
            // two matching tags resolved to the same destination -- one link, not a duplicate.
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
