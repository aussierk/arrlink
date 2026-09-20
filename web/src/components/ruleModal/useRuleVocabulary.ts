import { useEffect, useMemo, useState } from 'react'
import {
  api,
  RICH_CATEGORIES,
  type ConditionCategory,
  type ConditionItem,
  type RuleInput,
  type TagItem,
} from '../../lib/api'
import { type ServiceType } from '../../lib/tagOptions'
import { computeCustomOptions, optionsForCategory, type FormState, type Vocab } from './helpers'

type Args = {
  form: FormState
  conditions: ConditionItem[]
  serviceType: ServiceType
  representativeAppId: number | null
  tags: TagItem[]
}

/**
 * Known values per rich category (genre/language/quality/certification/
 * collection), backed by the DB vocabulary table (TMDB/TRaSH/instance,
 * synced in the background — see Settings > Metadata providers), plus the
 * debounced, non-blocking "this value isn't a known X" advisory check.
 */
export function useRuleVocabulary({
  form,
  conditions,
  serviceType,
  representativeAppId,
  tags,
}: Args) {
  const [vocab, setVocab] = useState<Vocab>({})
  const [vocabWarnings, setVocabWarnings] = useState<string[]>([])

  useEffect(() => {
    if (form.app_scope === null && form.app_type_scope === null) {
      setVocab({})
      return
    }
    let cancelled = false
    void Promise.all(
      RICH_CATEGORIES.map((cat) =>
        api
          .getVocabulary(cat, serviceType, representativeAppId)
          .then((entries) => [cat, entries] as const)
          .catch(() => [cat, []] as const),
      ),
    ).then((pairs) => {
      if (!cancelled) setVocab(Object.fromEntries(pairs) as Vocab)
    })
    return () => {
      cancelled = true
    }
  }, [serviceType, representativeAppId, form.app_scope, form.app_type_scope])

  // Debounced, non-blocking vocabulary-membership check — mirrors how Live
  // Preview already dry-runs without saving. Purely advisory: never blocks
  // submit, just surfaces "this value isn't a known X" hints as you edit.
  useEffect(() => {
    if (conditions.length === 0) {
      setVocabWarnings([])
      return
    }
    const body: RuleInput = { ...form, conditions }
    const handle = setTimeout(() => {
      api
        .checkRuleVocabulary(body)
        .then((r) => setVocabWarnings(r.warnings))
        .catch(() => setVocabWarnings([]))
    }, 400)
    return () => clearTimeout(handle)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conditions, form.app_scope, form.app_type_scope])

  const customOptions = useMemo(() => computeCustomOptions(tags, vocab), [tags, vocab])

  function optionsFor(category: ConditionCategory): string[] {
    return optionsForCategory(category, vocab, tags, customOptions)
  }

  return { vocabWarnings, optionsFor }
}
