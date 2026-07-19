import { useState } from 'react'
import { api, type RuleInput } from '../lib/api'

type PreviewData = {
  app_id: number
  app_name: string
  total: number
  sample: { item_title: string; src_path: string; dst_path: string }[]
  errors: { item_title: string; src_path: string; error: string }[]
}

/**
 * Live dry-run preview for a rule against one app. No links are created;
 * it shows exactly which files would land where (plus any template errors).
 */
export default function PreviewPanel({
  rule,
  appId,
}: {
  rule: RuleInput
  appId: number | null
}) {
  const [data, setData] = useState<PreviewData | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [stamp, setStamp] = useState(0)

  async function run() {
    if (appId === null) return
    setBusy(true)
    setErr(null)
    try {
      const r = await api.previewRule(rule, appId)
      setData(r)
      setStamp(Date.now())
    } catch (e) {
      setErr(String(e))
      setData(null)
    } finally {
      setBusy(false)
    }
  }

  if (appId === null) {
    return (
      <p className="text-xs text-zinc-600">
        Pick an app to preview this rule.
      </p>
    )
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-3">
        <button
          onClick={() => void run()}
          disabled={busy}
          className="rounded-md border border-indigo-500/50 px-3 py-1 text-xs text-indigo-300 hover:bg-indigo-950/40 disabled:opacity-50"
        >
          {busy ? 'Previewing…' : data ? 'Re-run preview' : 'Preview'}
        </button>
        {data && (
          <span className="text-xs text-zinc-500">
            {data.total} file{data.total === 1 ? '' : 's'} would be linked ·{' '}
            {new Date(stamp).toLocaleTimeString()}
          </span>
        )}
      </div>
      {err && (
        <p className="text-xs text-red-400">{err}</p>
      )}
      {data && data.sample.length > 0 && (
        <div className="overflow-x-auto rounded-md border border-zinc-800">
          <table className="w-full text-xs">
            <thead className="bg-zinc-900 text-left text-zinc-500">
              <tr>
                <th className="px-2 py-1">Item</th>
                <th className="px-2 py-1">Source</th>
                <th className="px-2 py-1">Would link to</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800/60">
              {data.sample.map((s, i) => (
                <tr key={i}>
                  <td className="px-2 py-1 text-zinc-300">{s.item_title}</td>
                  <td className="px-2 py-1 font-mono text-zinc-500">
                    {s.src_path}
                  </td>
                  <td className="px-2 py-1 font-mono text-emerald-300">
                    {s.dst_path}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {data && data.errors.length > 0 && (
        <div className="rounded-md border border-amber-900/60 bg-amber-950/20 p-2">
          {data.errors.map((e, i) => (
            <p key={i} className="text-xs text-amber-300">
              {e.item_title} ({e.src_path}): {e.error}
            </p>
          ))}
        </div>
      )}
      {data && data.total === 0 && data.errors.length === 0 && (
        <p className="text-xs text-zinc-600">No matching files for this rule.</p>
      )}
    </div>
  )
}
