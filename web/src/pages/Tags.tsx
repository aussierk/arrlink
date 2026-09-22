import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useBlocker } from 'react-router-dom'
import {
  api,
  fmtTime,
  type AppItem,
  type ConditionCategory,
  type TagItem,
} from '../lib/api'
import { useBeforeUnloadGuard } from '../lib/unsavedGuard'
import Button from '../components/ui/Button'
import PageHeader from '../components/ui/PageHeader'
import SortHeader from '../components/ui/SortHeader'
import { Table, TableEmpty, Thead } from '../components/ui/Table'
import { useAsyncLoad } from '../lib/useAsyncLoad'
import { useConfirm } from '../lib/useConfirm'
import { useSort } from '../lib/useSort'
import { useToast } from '../lib/useToast'
import { selectCls } from '../lib/ui'

const CLASSIFIABLE_CATEGORIES: ConditionCategory[] = [
  'genre',
  'certification',
  'collection',
  'quality',
  'language',
  'audio_language',
  'user',
  'custom',
]

const TAG_SORT: Record<string, (t: TagItem) => string | number> = {
  label: (t) => t.label.toLowerCase(),
  category: (t) => t.category ?? '',
  count: (t) => t.count,
  rules: (t) => t.rule_count,
  imported: (t) => t.imported_at,
}

/**
 * Tags: the tag vocabulary imported from each app, with usage counts and
 * per-tag category classification.
 */
export default function Tags() {
  const { t } = useTranslation()
  const confirm = useConfirm()
  const toast = useToast()
  const [apps, setApps] = useState<AppItem[]>([])
  const [appId, setAppId] = useState<number | null>(null)
  const [tags, setTags] = useState<TagItem[]>([])
  const [busy, setBusy] = useState(false)
  const [filter, setFilter] = useState('')
  const {
    sorted: sortedTags,
    sortKey,
    sortDir,
    toggleSort,
  } = useSort(tags, TAG_SORT, 'label')
  const q = filter.trim().toLowerCase()
  const visibleTags = q
    ? sortedTags.filter((tg) => tg.label.toLowerCase().includes(q))
    : sortedTags

  // Category edits are staged here, not saved on select -- the row's
  // dropdown shows the pending value if there is one, else the saved
  // tag.category. Cleared on save, discard, or a full tag-list reload.
  const [pendingEdits, setPendingEdits] = useState<
    Record<number, ConditionCategory | null>
  >({})
  const [saving, setSaving] = useState(false)
  const hasPending = Object.keys(pendingEdits).length > 0

  useAsyncLoad(async () => {
    const a = await api.listApps()
    setApps(a)
    if (appId === null && a.length > 0) setAppId(a[0].id)
    if (appId !== null && !a.some((x) => x.id === appId)) setAppId(null)
  }, [appId])

  const loadTags = useAsyncLoad(async () => {
    if (appId === null) return
    setTags(await api.listTags(appId))
    setPendingEdits({})
  }, [appId])

  const saveTagEdits = useCallback(async (): Promise<boolean> => {
    const ids = Object.keys(pendingEdits).map(Number)
    if (ids.length === 0 || appId === null) return true
    setSaving(true)
    try {
      const results = await Promise.all(
        ids.map((id) => api.setTagCategory(appId, id, pendingEdits[id])),
      )
      const byId = new Map(results.map((r) => [r.id, r]))
      setTags((prev) => prev.map((tg) => byId.get(tg.id) ?? tg))
      setPendingEdits({})
      return true
    } catch (e) {
      toast.error(String(e))
      return false
    } finally {
      setSaving(false)
    }
  }, [pendingEdits, appId, toast])

  // Blocks any in-app navigation away from this page (sidebar, SettingsNav,
  // browser back/forward) while there's something unsaved -- react-router's
  // own mechanism, works for every nav surface with no per-surface wiring.
  // beforeunload (tab close/refresh/URL bar) isn't a router navigation, so
  // it needs the separate hook below.
  const blocker = useBlocker(hasPending)
  useEffect(() => {
    if (blocker.state !== 'blocked') return
    let cancelled = false
    void confirm({
      title: t('tags.unsaved.title'),
      message: t('tags.unsaved.leaveMessage'),
      confirmLabel: t('tags.unsaved.save'),
      cancelLabel: t('tags.unsaved.discard'),
    }).then((save) => {
      if (cancelled) return
      if (!save) {
        blocker.proceed()
        return
      }
      void saveTagEdits().then((ok) => {
        if (ok) blocker.proceed()
        else blocker.reset() // save failed -- stay so the error is visible
      })
    })
    return () => {
      cancelled = true
    }
  }, [blocker, saveTagEdits, confirm, t])
  useBeforeUnloadGuard(hasPending)

  function stageTagCategory(tagId: number, category: ConditionCategory | null) {
    const tag = tags.find((tg) => tg.id === tagId)
    setPendingEdits((prev) => {
      const next = { ...prev }
      if (tag && category === tag.category) {
        delete next[tagId] // back to the saved value -> no longer pending
      } else {
        next[tagId] = category
      }
      return next
    })
  }

  async function switchApp(nextId: number) {
    if (hasPending) {
      const save = await confirm({
        title: t('tags.unsaved.title'),
        message: t('tags.unsaved.switchMessage'),
        confirmLabel: t('tags.unsaved.save'),
        cancelLabel: t('tags.unsaved.discard'),
      })
      if (save) {
        const ok = await saveTagEdits()
        if (!ok) return // stay put so the error (and the edits) are still visible
      } else {
        setPendingEdits({})
      }
    }
    setAppId(nextId)
  }

  async function doImport() {
    if (appId === null) return
    setBusy(true)
    try {
      const r = await api.importTags(appId)
      toast.success(t('tags.appTags.imported', { count: r.imported }))
      await loadTags()
    } catch (e) {
      toast.error(String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-6">
      {/* ------------------------------ App tags --------------------------- */}
      <PageHeader
        title={t('tags.appTags.title')}
        subtitle={t('tags.appTags.subtitle')}
        actions={
          <div className="flex flex-wrap items-center gap-3">
            {apps.length > 0 && (
              <select
                className={selectCls}
                value={appId ?? ''}
                onChange={(e) => void switchApp(Number(e.target.value))}
              >
                {apps.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name} ({a.type})
                  </option>
                ))}
              </select>
            )}
            <Button
              onClick={() => void doImport()}
              disabled={appId === null || busy}
              loading={busy}
            >
              {busy ? t('tags.appTags.importing') : t('tags.appTags.importTags')}
            </Button>
            <Button
              variant="warning"
              onClick={() => void saveTagEdits()}
              disabled={!hasPending || saving}
            >
              {saving
                ? t('tags.appTags.saving')
                : t('tags.appTags.saveChanges', {
                    count: Object.keys(pendingEdits).length,
                  })}
            </Button>
          </div>
        }
      />

      {tags.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="search"
            className={`${selectCls} w-56`}
            placeholder={t('tags.appTags.filterPlaceholder')}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          <span className="text-xs text-fg-subtle">
            {t('tags.appTags.countShown', {
              shown: visibleTags.length,
              total: tags.length,
            })}
          </span>
        </div>
      )}

      <Table className="min-w-2xl">
        <Thead>
          <tr>
            <SortHeader
              label={t('tags.appTags.colTag')}
              columnKey="label"
              activeKey={sortKey}
              dir={sortDir}
              onSort={toggleSort}
            />
            <SortHeader
              label={t('tags.appTags.colCategory')}
              columnKey="category"
              activeKey={sortKey}
              dir={sortDir}
              onSort={toggleSort}
            />
            <SortHeader
              label={t('tags.appTags.colInUse')}
              columnKey="count"
              activeKey={sortKey}
              dir={sortDir}
              onSort={toggleSort}
            />
            <SortHeader
              label={t('tags.appTags.colRules')}
              columnKey="rules"
              activeKey={sortKey}
              dir={sortDir}
              onSort={toggleSort}
            />
            <SortHeader
              label={t('tags.appTags.colImported')}
              columnKey="imported"
              activeKey={sortKey}
              dir={sortDir}
              onSort={toggleSort}
            />
          </tr>
        </Thead>
        <tbody className="divide-y divide-line">
          {tags.length === 0 && (
            <TableEmpty colSpan={5}>
              {appId === null
                ? t('tags.appTags.connectFirst')
                : t('tags.appTags.emptyImport')}
            </TableEmpty>
          )}
          {tags.length > 0 && visibleTags.length === 0 && (
            <TableEmpty colSpan={5}>
              {t('tags.appTags.noMatch', { query: filter.trim() })}
            </TableEmpty>
          )}
          {visibleTags.map((tag) => {
            const isPending = tag.id in pendingEdits
            const shown = isPending ? pendingEdits[tag.id] : tag.category
            return (
              <tr key={tag.id} className="bg-sunken/40">
                <td className="px-3 py-2 font-mono text-xs text-fg">{tag.label}</td>
                <td className="px-3 py-2">
                  <select
                    className={`rounded-md border bg-sunken px-2 py-1 text-xs text-fg ${
                      isPending ? 'border-warning-fg' : 'border-line-strong'
                    }`}
                    value={shown ?? ''}
                    onChange={(e) =>
                      stageTagCategory(
                        tag.id,
                        (e.target.value || null) as ConditionCategory | null,
                      )
                    }
                  >
                    <option value="">{t('tags.appTags.unclassified')}</option>
                    {CLASSIFIABLE_CATEGORIES.map((cat) => (
                      <option key={cat} value={cat}>
                        {t(`ruleModal.categoryLabel.${cat}`)}
                      </option>
                    ))}
                  </select>
                  {isPending && (
                    <span className="ml-1.5 text-xs text-warning-fg">
                      {t('tags.appTags.unsaved')}
                    </span>
                  )}
                </td>
                <td className="px-3 py-2 text-fg-muted">{tag.count}</td>
                <td className="px-3 py-2 text-fg-muted">
                  {tag.rule_count > 0 ? (
                    <span className="text-accent">{tag.rule_count}</span>
                  ) : (
                    <span className="text-fg-faint">-</span>
                  )}
                </td>
                <td className="px-3 py-2 text-fg-subtle">{fmtTime(tag.imported_at)}</td>
              </tr>
            )
          })}
        </tbody>
      </Table>
    </div>
  )
}
