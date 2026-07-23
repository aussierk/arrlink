import { useCallback, useEffect, useState } from 'react'
import { api, type Me } from '../lib/api'

/**
 * Settings (M6+): structured, no raw JSON. Two sections:
 *  - Linking: global unlink-on-mismatch, cross-filesystem fallback, allowed
 *    roots — the resolved runtime values the poller/repairer use.
 *  - Access control (OIDC only): group / email allow-lists.
 */
export default function Settings() {
  const [err, setErr] = useState<string | null>(null)
  const [ok, setOk] = useState<string | null>(null)
  const [me, setMe] = useState<Me | null>(null)

  // Linking
  const [unlink, setUnlink] = useState(true)
  const [fsFallback, setFsFallback] = useState('skip')
  const [fsModes, setFsModes] = useState<string[]>(['skip', 'copy', 'symlink'])
  const [rootsText, setRootsText] = useState('/media')

  // Access control (OIDC)
  const [groupsText, setGroupsText] = useState('')
  const [emailsText, setEmailsText] = useState('')

  const load = useCallback(async () => {
    try {
      const eff = await api.getEffectiveSettings()
      setUnlink(eff.global_unlink_on_mismatch)
      setFsFallback(eff.fs_fallback)
      setFsModes(eff.fs_fallback_modes)
      setRootsText(eff.allowed_roots.join(', '))
      const s = await api.getSettings()
      setGroupsText(
        ((s['oidc_allowed_groups'] as string[] | undefined) ?? []).join(', '),
      )
      setEmailsText(
        ((s['oidc_allowed_emails'] as string[] | undefined) ?? []).join(', '),
      )
    } catch (e) {
      setErr(String(e))
    }
  }, [])

  useEffect(() => {
    void load()
    api.me().then(setMe).catch(() => {})
  }, [load])

  async function saveLinking() {
    setErr(null)
    setOk(null)
    const roots = rootsText
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    if (roots.length === 0) {
      setErr('Allowed roots must not be empty.')
      return
    }
    try {
      await api.setSetting('global_unlink_on_mismatch', unlink)
      await api.setSetting('fs_fallback', fsFallback)
      await api.setSetting('allowed_roots', roots)
      setOk('Linking settings saved — they take effect on the next poll.')
      await load()
    } catch (e) {
      setErr(String(e))
    }
  }

  async function saveAllowlist() {
    setErr(null)
    setOk(null)
    const parse = (t: string) =>
      t.split(',').map((s) => s.trim()).filter(Boolean)
    try {
      await api.setSetting('oidc_allowed_groups', parse(groupsText))
      await api.setSetting('oidc_allowed_emails', parse(emailsText))
      setOk('Allow-list saved.')
      await load()
    } catch (e) {
      setErr(String(e))
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold">Settings</h2>
        <p className="text-sm text-zinc-500">
          Runtime settings. Environment-level settings (auth mode, OIDC
          issuer/client) are configured via the compose file.
        </p>
      </div>

      {err && (
        <div className="rounded-md border border-red-900 bg-red-950/40 p-3 text-sm text-red-300">
          {err}
        </div>
      )}
      {ok && (
        <div className="rounded-md border border-emerald-900 bg-emerald-950/40 p-3 text-sm text-emerald-300">
          {ok}
        </div>
      )}

      <div className="space-y-3 rounded-lg border border-zinc-800 bg-zinc-900/40 p-4">
        <h3 className="text-sm font-semibold text-zinc-200">Linking</h3>
        <p className="text-xs text-zinc-500">
          Applied by the poller and the repair action. Changes take effect on
          the next poll — no restart needed.
        </p>
        <label className="flex items-center gap-2 text-sm text-zinc-300">
          <input
            type="checkbox"
            checked={unlink}
            onChange={(e) => setUnlink(e.target.checked)}
          />
          Unlink on mismatch (remove links when a rule no longer matches)
        </label>
        <div className="flex flex-wrap items-end gap-4">
          <label className="text-sm">
            <span className="mb-1 block text-zinc-400">
              Cross-filesystem fallback
            </span>
            <select
              className={inputCls}
              value={fsFallback}
              onChange={(e) => setFsFallback(e.target.value)}
            >
              {fsModes.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </label>
          <label className="min-w-64 flex-1 text-sm">
            <span className="mb-1 block text-zinc-400">
              Allowed roots <span className="text-zinc-600">(comma-separated)</span>
            </span>
            <input
              className={inputCls}
              value={rootsText}
              onChange={(e) => setRootsText(e.target.value)}
              placeholder="/media, /mnt/pool/linked"
            />
          </label>
        </div>
        <p className="text-xs text-zinc-600">
          <span className="font-mono">skip</span> = never link across
          filesystems (default) · <span className="font-mono">copy</span> =
          copy the file · <span className="font-mono">symlink</span> = symlink.
          Destinations are always jailed to the allowed roots.
        </p>
        <div className="flex justify-end">
          <button
            onClick={() => void saveLinking()}
            className="rounded-md bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-indigo-500"
          >
            Save linking settings
          </button>
        </div>
      </div>

      {me?.auth_mode === 'oidc' && (
        <div className="space-y-3 rounded-lg border border-zinc-800 bg-zinc-900/40 p-4">
          <h3 className="text-sm font-semibold text-zinc-200">
            Access control
          </h3>
          <p className="text-xs text-zinc-500">
            OIDC login is allowed for any authenticated user whose email is in
            the email list <span className="text-zinc-400">or</span> whose group
            is in the group list. Both empty = anyone signed in may use
            ArrLink.
          </p>
          <label className="block text-sm">
            <span className="mb-1 block text-zinc-400">Allowed groups</span>
            <input
              className={inputCls}
              value={groupsText}
              onChange={(e) => setGroupsText(e.target.value)}
              placeholder="arrlink, family"
            />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block text-zinc-400">Allowed emails</span>
            <input
              className={inputCls}
              value={emailsText}
              onChange={(e) => setEmailsText(e.target.value)}
              placeholder="alice@example.com"
            />
          </label>
          <div className="flex justify-end">
            <button
              onClick={() => void saveAllowlist()}
              className="rounded-md bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-indigo-500"
            >
              Save allow-list
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

const inputCls =
  'w-full rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-sm text-zinc-100 outline-none focus:border-indigo-500'
