import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Tags as TagsIcon } from 'lucide-react'
import ManageTagsModal from '../components/ManageTagsModal'
import Button from '../components/ui/Button'
import PageHeader from '../components/ui/PageHeader'
import SortHeader from '../components/ui/SortHeader'
import { Table, TableEmpty, Th, Thead } from '../components/ui/Table'
import { api, type AppItem, type MediaItem } from '../lib/api'
import { pruneSelection } from '../lib/pruneSelection'
import { useAsyncLoad } from '../lib/useAsyncLoad'
import { useSort } from '../lib/useSort'
import { useToast } from '../lib/useToast'
import { selectCls } from '../lib/ui'

const ITEM_SORT: Record<string, (i: MediaItem) => string | number> = {
  title: (i) => i.title.toLowerCase(),
  year: (i) => i.year ?? 0,
}

/**
 * Library: browse one app's media items and, via multi-select, add/remove
 * tags on them -- writes back to the live Radarr/Sonarr instance (see
 * api/items.ts), not just ArrLink's own tag vocabulary. Distinct from the
 * Tags page, which manages tag *labels* (one row per tag), not items.
 */
export default function Library() {
  const { t } = useTranslation()
  const toast = useToast()
  const [apps, setApps] = useState<AppItem[]>([])
  const [appId, setAppId] = useState<number | null>(null)
  const [items, setItems] = useState<MediaItem[]>([])
  const [tagSuggestions, setTagSuggestions] = useState<string[]>([])
  const [filter, setFilter] = useState('')
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set())
  const [manageOpen, setManageOpen] = useState(false)
  const selectAllRef = useRef<HTMLInputElement>(null)

  const { sorted: sortedItems, sortKey, sortDir, toggleSort } = useSort(
    items,
    ITEM_SORT,
    'title',
  )
  const q = filter.trim().toLowerCase()
  const visibleItems = q
    ? sortedItems.filter((i) => i.title.toLowerCase().includes(q))
    : sortedItems

  useAsyncLoad(async () => {
    const a = await api.listApps()
    setApps(a)
    if (appId === null && a.length > 0) setAppId(a[0].id)
    if (appId !== null && !a.some((x) => x.id === appId)) setAppId(null)
  }, [appId])

  const load = useAsyncLoad(async () => {
    if (appId === null) {
      setItems([])
      return
    }
    const [libItems, appTags, repoTags] = await Promise.all([
      api.listItems(appId),
      api.listTags(appId),
      api.listTagRepository(),
    ])
    setItems(libItems)
    setTagSuggestions(
      Array.from(new Set([...appTags.map((tg) => tg.label), ...repoTags.map((tg) => tg.label)])).sort(),
    )
  }, [appId])

  // A selection can outlive the filter/app that made it visible -- prune to
  // still-visible rows whenever the visible set actually changes, same
  // pattern as Rules.tsx's bulk-select.
  const visibleIdsKey = visibleItems.map((i) => i.id).join(',')
  useEffect(() => {
    const visibleIds = new Set(visibleItems.map((i) => i.id))
    setSelectedIds((prev) => pruneSelection(prev, visibleIds))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleIdsKey])

  const allVisibleSelected =
    visibleItems.length > 0 && visibleItems.every((i) => selectedIds.has(i.id))
  const someVisibleSelected = visibleItems.some((i) => selectedIds.has(i.id))

  useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate = someVisibleSelected && !allVisibleSelected
    }
  }, [someVisibleSelected, allVisibleSelected])

  function toggleSelected(id: number) {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function toggleSelectAll() {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (allVisibleSelected) {
        for (const i of visibleItems) next.delete(i.id)
      } else {
        for (const i of visibleItems) next.add(i.id)
      }
      return next
    })
  }

  function clearSelection() {
    setSelectedIds(new Set())
  }

  function handleApplied(result: { ok: number; failed: number }) {
    if (result.failed > 0) {
      toast.error(t('library.manageTags.partialResult', result))
    } else {
      toast.success(t('library.manageTags.appliedMsg', { count: result.ok }))
    }
    clearSelection()
    void load()
  }

  const selectedItems = items.filter((i) => selectedIds.has(i.id))

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('library.title')}
        subtitle={t('library.subtitle')}
        actions={
          apps.length > 0 && (
            <select
              className={selectCls}
              value={appId ?? ''}
              onChange={(e) => setAppId(Number(e.target.value))}
            >
              {apps.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} ({a.type})
                </option>
              ))}
            </select>
          )
        }
      />

      {items.length > 0 &&
        (selectedIds.size > 0 ? (
          <div className="flex flex-wrap items-center gap-2 rounded-md bg-accent-bg p-2">
            <span className="px-1 text-xs font-medium text-accent">
              {t('library.selectedCount', { count: selectedIds.size })}
            </span>
            <Button variant="secondary" size="sm" onClick={() => setManageOpen(true)}>
              <TagsIcon className="size-3.5" />
              {t('library.manageTags.button')}
            </Button>
            <Button variant="ghost" size="sm" onClick={clearSelection}>
              {t('library.clearSelection')}
            </Button>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="search"
              className={`${selectCls} w-56`}
              placeholder={t('library.filterPlaceholder')}
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
            <span className="text-xs text-fg-subtle">
              {t('library.countShown', { shown: visibleItems.length, total: items.length })}
            </span>
          </div>
        ))}

      <Table className="min-w-2xl">
        <Thead>
          <tr>
            <Th className="w-8">
              <input
                ref={selectAllRef}
                type="checkbox"
                aria-label={t('library.selectAll')}
                checked={allVisibleSelected}
                onChange={toggleSelectAll}
              />
            </Th>
            <SortHeader
              label={t('library.colTitle')}
              columnKey="title"
              activeKey={sortKey}
              dir={sortDir}
              onSort={toggleSort}
            />
            <SortHeader
              label={t('library.colYear')}
              columnKey="year"
              activeKey={sortKey}
              dir={sortDir}
              onSort={toggleSort}
            />
            <Th>{t('library.colTags')}</Th>
          </tr>
        </Thead>
        <tbody className="divide-y divide-line">
          {items.length === 0 && (
            <TableEmpty colSpan={4}>
              {appId === null ? t('library.connectFirst') : t('library.empty')}
            </TableEmpty>
          )}
          {items.length > 0 && visibleItems.length === 0 && (
            <TableEmpty colSpan={4}>{t('library.noMatch', { query: filter.trim() })}</TableEmpty>
          )}
          {visibleItems.map((item) => (
            <tr key={item.id} className="bg-sunken/40">
              <td className="px-3 py-2">
                <input
                  type="checkbox"
                  aria-label={t('library.selectRow', { title: item.title })}
                  checked={selectedIds.has(item.id)}
                  onChange={() => toggleSelected(item.id)}
                />
              </td>
              <td className="px-3 py-2 font-medium">{item.title}</td>
              <td className="px-3 py-2 text-fg-muted">{item.year ?? '-'}</td>
              <td className="px-3 py-2">
                {item.tags.length === 0 ? (
                  <span className="text-fg-faint">-</span>
                ) : (
                  <div className="flex flex-wrap gap-1">
                    {item.tags.map((tg) => (
                      <span
                        key={tg}
                        className="rounded-full border border-line-strong bg-surface px-2 py-0.5 text-xs text-fg-soft"
                      >
                        {tg}
                      </span>
                    ))}
                  </div>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </Table>

      {manageOpen && appId !== null && (
        <ManageTagsModal
          appId={appId}
          selectedItems={selectedItems}
          suggestions={tagSuggestions}
          onClose={() => setManageOpen(false)}
          onApplied={handleApplied}
        />
      )}
    </div>
  )
}
