import { useEffect, useMemo, useState } from 'react'
import {
  api,
  RICH_CATEGORIES,
  type ConditionCategory,
  type ConditionItem,
  type ConditionSource,
  type RuleInput,
  type TagItem,
} from '../../lib/api'
import { type ServiceType } from '../../lib/tagOptions'
import {
  computeCustomOptions,
  optionsForCategory,
  type FormState,
  type Vocab,
} from './helpers'

type Args = {
  form: FormState
  conditions: ConditionItem[]
  serviceType: ServiceType
  tags: TagItem[]
}

/**
 * Known values per rich category (genre/language/quality/certification/
 * collection), backed by the DB vocabulary table (TMDB/TRaSH/instance,
 * synced in the background -- see Settings > Metadata providers), plus the
 * debounced, non-blocking "this value isn't a known X" advisory check.
 */
export function useRuleVocabulary({ form, conditions, serviceType, tags }: Args) {
  const [vocab, setVocab] = useState<Vocab>({})
  const [vocabWarnings, setVocabWarnings] = useState<string[]>([])

  useEffect(() => {
    let cancelled = false
    // A specific instance (app_scope) asks for just that app's own known
    // values; a type-scope (app_type_scope, no one specific instance) -- or
    // no scope at all yet -- omits app_id so the backend unions every
    // instance of that type instead of guessing at one representative that
    // might not have synced the value another instance already knows about
    // (e.g. language, which has no shared/global source at all -- only
    // per-instance sync). The backend already de-dupes that union by value,
    // so an unscoped rule still gets real suggestions instead of an empty
    // dropdown.
    void Promise.all(
      RICH_CATEGORIES.map((cat) =>
        api
          .getVocabulary(cat, serviceType, form.app_scope)
          .then((entries) => [cat, entries] as const)
          .catch(() => [cat, []] as const),
      ),
    ).then((pairs) => {
      if (!cancelled) setVocab(Object.fromEntries(pairs) as Vocab)
    })
    return () => {
      cancelled = true
    }
  }, [serviceType, form.app_scope, form.app_type_scope])

  // Debounced, non-blocking vocabulary-membership check -- mirrors how Live
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

  function optionsFor(
    category: ConditionCategory,
    source?: ConditionSource | null,
  ): string[] {
    return optionsForCategory(category, vocab, tags, customOptions, source)
  }

  return { vocabWarnings, optionsFor }
}
