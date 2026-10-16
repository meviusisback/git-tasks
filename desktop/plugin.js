
/**
 * git-tasks — multi-repo issues & PRs in an Orca-style Tasks view.
 * Single self-contained ESM file: the desktop loads it uncompiled and only
 * `@hermes/plugin-sdk`, `react`, `react/jsx-runtime` resolve.
 * Pure helpers are exported for `node --test`; the desktop never sees them.
 */
import {
  host, atom, useValue, useQuery, queryClient,
  Button, Badge, ScrollArea, EmptyState, ErrorState, Skeleton,
  SearchField, SegmentedControl, Separator, Checkbox, Textarea,
  CopyButton, Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
  Codicon, cn, relativeTime, Tip,
} from '@hermes/plugin-sdk'
import { useState, useEffect, useMemo, useRef } from 'react'
import { jsx, jsxs, Fragment } from 'react/jsx-runtime'

export const ID = 'git-tasks'
export const TASKS_ROUTE = '/tasks'
export const STORAGE_KEY_REPOS = 'selectedRepos'
export const STORAGE_KEY_FILTER = 'filter'
export const STORAGE_KEY_WORKTREE_SESSIONS = 'worktreeSessions'
export const STORAGE_KEY_CLONE_ROOTS = 'cloneRoots'
export const DEFAULT_CLONE_ROOTS = ['~/repo', '~/repos', '~/src', '~/orca', '~/dev', '~/projects']

// Registry areas as string literals: works even if a host build omits named exports.
export const ROUTES_AREA_LIT = 'routes'
export const SIDEBAR_NAV_LIT = 'sidebar.nav'
export const PALETTE_AREA_LIT = 'palette'
export const PANES_AREA_LIT = 'panes'
export const STATUSBAR_RIGHT_LIT = 'statusBar.right'
export const SETTINGS_PLUGINS_AREA_LIT = 'settings.plugins'

const GH_PATH = 'PATH=/opt/homebrew/bin:/usr/local/bin:$PATH'
const GH = `${GH_PATH} gh`

export function sq(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'"
}

export function repoOk(r) {
  if (typeof r !== 'string') return false
  const m = r.match(/^([A-Za-z0-9_.'-]+)\/([A-Za-z0-9_.'-]+)$/)
  if (!m || m[1] === '.' || m[1] === '..' || m[2] === '.' || m[2] === '..') return false
  return true
}

export function parseRepoList(text) {
  if (!text) return []
  const seen = new Set()
  const out = []
  for (const rawLine of String(text).split(/[\n,]/)) {
    let s = rawLine.trim()
    if (!s || s.startsWith('#')) continue
    const hash = s.indexOf(' #')
    if (hash !== -1) s = s.slice(0, hash).trim()
    const url = s.match(/github\.com[\/:]([^\/\s]+\/[^\/\s#?]+?)(?:\.git)?\s*$/i)
    if (url) s = url[1]
    if (!repoOk(s)) continue
    const key = s.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(s)
  }
  return out
}

export function remoteToRepo(url) {
  if (!url) return null
  const m = String(url).trim().match(/github\.com[:\/]([^\/\s]+\/[^\/\s#?]+?)(?:\.git)?\s*$/i)
  if (!m) return null
  return m[1].replace(/\.git$/i, '')
}

export const ROOT_SAFE = /^[A-Za-z0-9_.\/~][A-Za-z0-9_.\/~ -]*$/

export function parseCloneRoots(text) {
  const out = []
  const seen = new Set()
  for (const raw of String(text || '').split(/[\n,]/)) {
    let s = raw.trim()
    if (!s || s.startsWith('#')) continue
    const hash = s.indexOf(' #')
    if (hash !== -1) s = s.slice(0, hash).trim()
    if (s.endsWith('/') && s.length > 1) s = s.replace(/\/+$/, '')
    if (!ROOT_SAFE.test(s)) continue
    if (s.includes('..')) continue
    if (seen.has(s)) continue
    seen.add(s)
    out.push(s)
  }
  return out.length ? out : [...DEFAULT_CLONE_ROOTS]
}

export function expandRoot(root, home) {
  const r = String(root || '')
  if (!home || !r.startsWith('~')) return r
  if (r === '~') return home
  return r.slice(1).startsWith('/') ? home + r.slice(1) : r
}

export function buildCloneScanCommand(roots, home) {
  const paths = parseCloneRoots((roots || []).join('\n'))
    .map(r => expandRoot(r, home))
    .filter(Boolean)
  const list = paths.map(sq).join(' ')
  if (!list) return 'set -o pipefail; true'
  return (
    'set -o pipefail; ' +
    `for root in ${list}; do [ -d "$root" ] || continue; ` +
    'for d in "$root"/*/; do [ -d "$d/.git" ] || continue; ' +
    `printf '%s\\t%s\\n' "$d" "$(git -C "$d" remote get-url origin 2>/dev/null)"; done; done`
  )
}

export function buildListScript(repos, opts = {}) {
  const state = opts.state === 'all' || opts.state === 'closed' || opts.state === 'merged' ? opts.state : 'open'
  const limit = Number.isSafeInteger(opts.limit) && opts.limit > 0 ? opts.limit : 30
  const PR_FIELDS = 'number,title,state,isDraft,author,createdAt,updatedAt,labels,url'
  const ISSUE_FIELDS = 'number,title,state,author,createdAt,updatedAt,labels,url'
  const parts = ['set -o pipefail']
  for (const r of parseRepoList(Array.isArray(repos) ? repos.join('\n') : repos)) {
    parts.push(`printf "@@R ${r} pr\\n"`)
    parts.push(`gh pr list --repo ${sq(r)} --state ${state} --limit ${limit} --json ${PR_FIELDS} 2>/dev/null || printf '[]\\n'`)
    parts.push(`printf "@@R ${r} issue\\n"`)
    parts.push(`gh issue list --repo ${sq(r)} --state ${state} --limit ${limit} --json ${ISSUE_FIELDS} 2>/dev/null || printf '[]\\n'`)
  }
  return parts.join('; ')
}

export function parseListOutput(stdout) {
  const items = []
  if (!stdout) return items
  let repo = null
  let kind = null
  for (const line of String(stdout).split('\n')) {
    const marker = line.match(/^@@R (\S+) (pr|issue)\s*$/)
    if (marker) { repo = marker[1]; kind = marker[2]; continue }
    if (!repo || !kind) continue
    const trimmed = line.trim()
    if (!trimmed.startsWith('[')) { repo = null; kind = null; continue }
    let rows
    try { rows = JSON.parse(trimmed) } catch { repo = null; kind = null; continue }
    if (!Array.isArray(rows)) { repo = null; kind = null; continue }
    for (const row of rows) {
      items.push({
        kind, repo,
        number: row.number,
        title: row.title || '',
        state: String(row.state || '').toUpperCase(),
        isDraft: !!row.isDraft,
        author: row.author?.login || '',
        createdAt: row.createdAt || '',
        updatedAt: row.updatedAt || '',
        labels: Array.isArray(row.labels) ? row.labels : [],
        url: row.url || '',
      })
    }
    repo = null; kind = null
  }
  return items
}

export function filterItems(items, { state = 'all', kind = 'all', repos = null, query = '' } = {}) {
  const q = String(query || '').trim().toLowerCase()
  const repoSet = Array.isArray(repos) && repos.length ? new Set(repos) : null
  const wanted = String(state || 'all').trim().toLowerCase()
  return (Array.isArray(items) ? items : []).filter(it => {
    if (wanted !== 'all') {
      if (wanted === 'closed') {
        if (it.state !== 'CLOSED' && it.state !== 'MERGED') return false
      } else if (it.state !== String(state).toUpperCase()) {
        return false
      }
    }
    if (kind !== 'all' && it.kind !== kind) return false
    if (repoSet && !repoSet.has(it.repo)) return false
    if (!q) return true
    const hay = [
      it.title, `#${it.number}`, String(it.number), it.author, it.repo,
      ...(it.labels || []).map(l => (typeof l === 'string' ? l : l?.name || '')),
    ].join(' ').toLowerCase()
    return hay.includes(q)
  })
}

export function sortItems(items, mode = 'updated') {
  const arr = [...(Array.isArray(items) ? items : [])]
  if (mode === 'repo') return arr.sort((a, b) => a.repo.localeCompare(b.repo) || (a.number - b.number))
  if (mode === 'created') return arr.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
  return arr.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
}

export function groupByRepo(items) {
  const order = []
  const map = new Map()
  for (const it of Array.isArray(items) ? items : []) {
    if (!map.has(it.repo)) { map.set(it.repo, []); order.push(it.repo) }
    map.get(it.repo).push(it)
  }
  return order.map(repo => ({ repo, items: map.get(repo) }))
}

export function itemRef(item) { return `${item.repo}#${item.number}` }

export function deriveBranchName(item) {
  const slug = String(item?.title || '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    .slice(0, 60).replace(/-+$/g, '')
  return `${item?.kind === 'pr' ? 'pr' : 'issue'}/${item?.number || 0}-${slug || 'task'}`
}

export function formatSeedMessage(item) {
  const kind = item?.kind === 'pr' ? 'pull request' : 'issue'
  return [
    `Work on this GitHub ${kind}: ${itemRef(item)}`,
    '', `Title: ${item?.title || ''}`,
    item?.url ? `URL: ${item.url}` : '',
    '', `Branch: ${deriveBranchName(item)}`,
    'Read the full thread with `gh` before changing code.',
  ].filter(Boolean).join('\n')
}

export function stateColor(state, isDraft) {
  if (isDraft) return 'var(--ui-text-tertiary)'
  if (state === 'OPEN') return 'var(--ui-accent)'
  if (state === 'MERGED') return 'var(--ui-text-secondary)'
  if (state === 'CLOSED') return 'var(--ui-text-quaternary)'
  return 'var(--ui-text-tertiary)'
}

export function deriveChunkOffsets(byteLength, chunkSize = 3800) {
  if (!Number.isSafeInteger(byteLength) || byteLength < 0) throw new Error('invalid chunk byte length')
  if (!Number.isSafeInteger(chunkSize) || chunkSize < 1) throw new Error('invalid chunk size')
  return Array.from({ length: Math.ceil(byteLength / chunkSize) }, (_, i) => i * chunkSize + 1)
}

export function formatViewCmd(item) {
  const entity = item.kind === 'pr' ? 'pr' : 'issue'
  return `gh ${entity} view ${Number(item.number)} --repo ${sq(item.repo)} --json number,title,body,state,author,createdAt,url,comments`
}

export function formatCheckoutCmd(item) {
  if (item.kind === 'pr') return `gh pr checkout ${Number(item.number)} --repo ${item.repo}`
  const name = item.repo.split('/')[1]
  return `gh repo clone ${item.repo} && cd ${name} && git switch -c ${deriveBranchName(item)}`
}

const STATE_ACTION = { close: 'close', reopen: 'reopen' }

export function formatStateCmd(item, action) {
  const verb = STATE_ACTION[action]
  if (!verb) throw new Error(`unsupported state action: ${action}`)
  if (!repoOk(item.repo)) throw new Error('invalid repo')
  const entity = item.kind === 'pr' ? 'pr' : 'issue'
  return `gh ${entity} ${verb} ${Number(item.number)} --repo ${sq(item.repo)}`
}

export function buildCommentCmd(item) {
  if (!repoOk(item.repo)) throw new Error('invalid repo')
  const entity = item.kind === 'pr' ? 'pr' : 'issue'
  return `gh ${entity} comment ${Number(item.number)} --repo ${sq(item.repo)} --body-file`
}

export function formatWorktreeRemoveCmd(repoRoot, branch) {
  const dir = `.worktrees/${String(branch).replace(/\//g, '-')}`
  return `git -C ${sq(repoRoot)} worktree remove ${sq(dir)}`
}

export function pickLocalClone(clones, repo) {
  const want = String(repo || '').toLowerCase()
  if (!want) return null
  for (const c of Array.isArray(clones) ? clones : []) {
    const acc = (c?.remote ? remoteToRepo(c.remote) : null)?.toLowerCase()
    if (acc === want) return c.path
  }
  return null
}

export function parseCloneScanOutput(stdout) {
  return String(stdout || '').split('\n').map(l => {
    if (!l.trim()) return null
    const [path, remote] = l.split('\t')
    if (!path) return null
    return { path: path.replace(/\/+$/, ''), remote: remote || '' }
  }).filter(Boolean)
}

export function buildWorktreeCommand(repoRoot, branch, baseRef = '') {
  const dir = `.worktrees/${String(branch).replace(/\//g, '-')}`
  const from = baseRef ? ` ${sq(baseRef)}` : ''
  return `git -C ${sq(repoRoot)} fetch --prune origin && git -C ${sq(repoRoot)} worktree add ${sq(dir)} -b ${sq(branch)}${from}`
}

export const readChunksConcurrently = async (byteLength, readChunk, options = {}) => {
  const chunkSize = options.chunkSize ?? 3800
  const offsets = deriveChunkOffsets(byteLength, chunkSize)
  const concurrency = options.concurrency ?? 4
  const chunks = new Array(offsets.length)
  let next = 0
  async function worker() {
    while (next < chunks.length) { const i = next++; chunks[i] = await readChunk(offsets[i]) }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, chunks.length) }, () => worker()))
  return chunks.join('')
}

async function sh(cmd) {
  const r = await host.request('shell.exec', { command: cmd })
  if (r.code !== 0) throw new Error(String(r.stderr || r.stdout || `exit ${r.code}`).trim().slice(0, 600))
  return String(r.stdout || '').trim()
}

async function shHome() {
  try { return (await sh('printf %s "$HOME"')).trim() } catch { return '' }
}

async function shBig(cmd) {
  const tag = `gittasks.${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
  const dir = '/home/alberto/.hermes/cache/scratch'
  const raw = `${dir}/${tag}.raw`
  const hex = `${dir}/${tag}.hex`
  try {
    await sh(`mkdir -p ${sq(dir)} && ${cmd} > ${sq(raw)} && od -An -v -tx1 ${sq(raw)} > ${sq(hex)}`)
    const byteLength = Number(await sh(`wc -c < ${sq(hex)}`))
    const out = await readChunksConcurrently(byteLength, off => sh(`tail -c +${off} ${sq(hex)} | head -c 3800`))
    const hexStr = out.replace(/\s+/g, '')
    const bytes = []
    for (let i = 0; i + 1 < hexStr.length; i += 2) bytes.push(parseInt(hexStr.slice(i, i + 2), 16))
    return new TextDecoder('utf-8').decode(Uint8Array.from(bytes))
  } finally {
    sh(`unlink ${sq(raw)} 2>/dev/null; unlink ${sq(hex)} 2>/dev/null`).catch(() => {})
  }
}

export async function ghJson(cmd) {
  const out = await sh(cmd)
  if (!out) return null
  try { return JSON.parse(out) } catch { throw new Error('gh JSON parse failed: ' + out.slice(0, 300)) }
}

export async function fetchRepoItems(repos, opts = {}) {
  const normalized = Array.isArray(repos) ? repos : (typeof repos === 'string' ? repos.split('\n') : [])
  const all = []
  for (const r of parseRepoList(normalized)) {
    const out = await sh(buildListScript([r], { ...opts, limit: opts.limit || 15 }))
    all.push(...parseListOutput(out))
  }
  return all
}

export async function listUserRepos(limit = 50) {
  const rows = await ghJson(`${GH} repo list --limit ${Number(limit)} --json nameWithOwner,isPrivate`)
  return (Array.isArray(rows) ? rows : []).map(r => ({ repo: r.nameWithOwner, private: !!r.isPrivate, updatedAt: r.updatedAt || '' }))
}

export async function postComment(item, text) {
  const tag = `gittasks.cmt.${Date.now().toString(36)}`
  const file = `/tmp/${tag}`
  const b64 = `/tmp/${tag}.b64`
  try {
    const bytes = new TextEncoder().encode(String(text))
    let bin = ''
    for (const b of bytes) bin += String.fromCharCode(b)
    const encoded = btoa(bin)
    await sh(`: > ${sq(b64)}`)
    for (let i = 0; i < encoded.length; i += 1800) {
      await sh(`printf %s ${sq(encoded.slice(i, i + 1800))} >> ${sq(b64)}`)
    }
    await sh(`{ base64 -d < ${sq(b64)} || base64 -D < ${sq(b64)}; } > ${sq(file)}`)
    return ghJson(`${buildCommentCmd(item)} ${sq(file)} --json url`)
  } finally {
    sh(`unlink ${sq(file)} 2>/dev/null; unlink ${sq(b64)} 2>/dev/null`).catch(() => {})
  }
}

export async function setItemState(item, action) {
  await sh(formatStateCmd(item, action))
}

export async function viewItem(item) {
  const base = await ghJson(`${GH_PATH} ${formatViewCmd(item)}`)
  if (!base || item.kind !== 'pr') return base
  try {
    const extra = await ghJson(`${GH_PATH} gh pr view ${Number(item.number)} --repo ${sq(item.repo)} --json updatedAt,labels,assignees,requestedReviewers,reviewDecision,statusCheckRollup,baseRefName,headRefName,mergeable,closedAt`)
    return { ...base, ...(extra || {}) }
  } catch {
    return base
  }
}

export async function discoverLocalClones() {
  const roots = $cloneRoots.get()
  const home = await shHome()
  return parseCloneScanOutput(await sh(buildCloneScanCommand(roots, home)))
}

export async function createWorktree(repoRoot, branch, baseRef = '') {
  const slug = String(branch).replace(/\//g, '-')
  let b = branch
  let dir = `.worktrees/${slug}`
  try {
    const exists = await sh(`git -C ${sq(repoRoot)} rev-parse --verify --quiet ${sq('refs/heads/' + branch)} >/dev/null 2>&1 && echo yes || echo no`)
    if (exists === 'yes') {
      const suffix = Date.now().toString(36)
      b = `${branch}-${suffix}`
      dir = `.worktrees/${slug}-${suffix}`
    }
  } catch { /* treat as new branch */ }
  await sh(`git -C ${sq(repoRoot)} fetch --prune origin && git -C ${sq(repoRoot)} worktree add ${sq(dir)} -b ${sq(b)}${baseRef ? ' ' + sq(baseRef) : ''}`)
  return `${repoRoot}/${dir}`
}

export async function startWorktreeSession(item, worktreePath, profile = null) {
  const raw = await host.request('session.create', {
    cwd: worktreePath,
    cwd_explicit: true,
    title: `${itemRef(item)} ${item.title}`.slice(0, 120),
    messages: [{ role: 'user', content: formatSeedMessage(item) }],
    ...(profile ? { profile } : {}),
  })
  const res = (raw && typeof raw === 'object' && raw.result && typeof raw.result === 'object') ? raw.result : raw
  const storedId = res?.stored_session_id || res?.storedSessionId || res?.session_id || res?.sessionId || res?.id || res?.session?.stored_session_id || res?.session?.storedSessionId || res?.session?.session_id || res?.session?.id
  if (!storedId) {
    throw new Error(`session.create did not return a session id: ${JSON.stringify(raw).slice(0, 300)}`)
  }
  try {
    await host.openSession(storedId, { intent: 'tab' })
  } catch (e) {
    throw new Error(`created session but could not open it: ${e?.message || e}`)
  }
  if (pluginCtx) {
    const map = pluginCtx.storage.get(STORAGE_KEY_WORKTREE_SESSIONS, {}) || {}
    map[itemRef(item)] = storedId
    pluginCtx.storage.set(STORAGE_KEY_WORKTREE_SESSIONS, map)
  }
  return raw
}

let pluginCtx = null

const $selectedRepos = atom([])
const $cloneRoots = atom([...DEFAULT_CLONE_ROOTS])
const $filter = atom({ state: 'open', kind: 'all', repos: [], query: '', sort: 'updated', group: false })
const $selectedTask = atom(null)

export function loadPersisted(ctx) {
  const savedRepos = ctx.storage.get(STORAGE_KEY_REPOS, [])
  if (Array.isArray(savedRepos)) $selectedRepos.set(parseRepoList(savedRepos.join('\n')))
  const savedRoots = ctx.storage.get(STORAGE_KEY_CLONE_ROOTS, null)
  $cloneRoots.set(Array.isArray(savedRoots) ? parseCloneRoots(savedRoots.join('\n')) : [...DEFAULT_CLONE_ROOTS])
  const savedFilter = ctx.storage.get(STORAGE_KEY_FILTER, null)
  if (savedFilter && typeof savedFilter === 'object') $filter.set({ ...$filter.get(), ...savedFilter, repos: [] })
}

export function persistRepos(ctx, repos) {
  const clean = parseRepoList((repos || []).join('\n'))
  $selectedRepos.set(clean)
  ctx.storage.set(STORAGE_KEY_REPOS, clean)
  return clean
}

export function persistCloneRoots(ctx, text) {
  const clean = parseCloneRoots(text)
  $cloneRoots.set(clean)
  ctx.storage.set(STORAGE_KEY_CLONE_ROOTS, clean)
  return clean
}

export function openTaskDetail(item) {
  $selectedTask.set(item)
}

function useRepoItems() {
  const repos = useValue($selectedRepos)
  const filter = useValue($filter)
  return useQuery({
    queryKey: [ID, 'items', repos, filter.state],
    enabled: repos.length > 0,
    queryFn: () => fetchRepoItems(repos, { state: filter.state === 'all' ? 'all' : filter.state }),
    staleTime: 30_000,
    refetchInterval: 90_000,
    refetchOnWindowFocus: true,
  })
}

function StartWorktreeButton({ item }) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [existingPath, setExistingPath] = useState(null)
  useEffect(() => {
    let cancelled = false
    async function check() {
      try {
        const clones = await discoverLocalClones()
        const root = pickLocalClone(clones, item.repo)
        if (!root) { if (!cancelled) setExistingPath(null); return }
        const slug = deriveBranchName(item).replace(/\//g, '-')
        const path = `${root}/.worktrees/${slug}`
        const yes = await sh(`[ -d ${sq(path)} ] && echo yes || echo no`)
        if (!cancelled) setExistingPath(yes === 'yes' ? path : null)
      } catch {
        if (!cancelled) setExistingPath(null)
      }
    }
    void check()
    return () => { cancelled = true }
  }, [item.repo, item.number, item.title])
  const openExisting = async () => {
    setBusy(true); setErr('')
    try {
      const map = (pluginCtx?.storage.get(STORAGE_KEY_WORKTREE_SESSIONS, {}) || {})
      const id = map[itemRef(item)]
      if (id) {
        await host.openSession(id, { intent: 'tab' })
        host.notify?.({ kind: 'success', message: 'Opened existing worktree session.' })
      } else {
        await startWorktreeSession(item, existingPath)
      }
    } catch (error) {
      const msg = String(error?.message || error)
      setErr(msg)
      host.notify?.({ kind: 'error', message: msg })
    } finally { setBusy(false) }
  }
  const startNew = async () => {
    setBusy(true); setErr('')
    try {
      const clones = await discoverLocalClones()
      const root = pickLocalClone(clones, item.repo)
      if (!root) throw new Error(`No local clone of ${item.repo} under: ${$cloneRoots.get().join(', ')}. Clone it or add its folder in Settings.`)
      await startWorktreeSession(item, await createWorktree(root, deriveBranchName(item)))
      host.notify?.({ kind: 'success', message: 'Worktree session opened.' })
    } catch (error) {
      const msg = String(error?.message || error)
      setErr(msg)
      host.notify?.({ kind: 'error', message: msg })
    } finally { setBusy(false) }
  }
  return jsxs('div', { className: 'flex flex-col gap-1', children: [
    jsx(Button, {
      size: 'sm', className: 'rounded-full px-3 py-1.5 text-[11px] font-medium shadow-sm hover:shadow-md', disabled: busy,
      onClick: async e => { e.stopPropagation(); if (existingPath) await openExisting(); else await startNew() },
      children: busy ? 'Working...' : (existingPath ? 'Go to worktree' : 'Start worktree'),
    }),
    err ? jsx('div', { className: 'text-[10px] text-(--ui-text-quaternary)', children: err }) : null,
  ] })
}

function LabelChip({ label }) {
  return jsx('span', { className: 'truncate rounded bg-(--ui-bg-quinary) px-1 text-[9px] text-(--ui-text-tertiary)', children: label })
}

function TaskCard({ item }) {
  return jsxs('div', { className: 'flex flex-col gap-1', children: [
    jsxs('button', {
      type: 'button',
      className: cn('w-full rounded-lg border border-(--ui-stroke-secondary) bg-(--ui-bg-quaternary) px-2.5 py-2 text-left',
        'hover:border-(--ui-accent) hover:bg-(--ui-bg-quinary)'),
      onClick: () => openTaskDetail(item),
      children: [
        jsxs('div', { className: 'flex items-center gap-1.5 text-[10px] text-(--ui-text-tertiary)', children: [
          jsx(Codicon, { name: item.kind === 'pr' ? 'git-pull-request' : 'issue-opened' }),
          jsx('span', { className: 'truncate font-medium text-(--ui-text-secondary)', children: item.repo }),
          jsx('span', { children: `#${item.number}` }),
          jsx('span', { className: 'ml-auto shrink-0', style: { color: stateColor(item.state, item.isDraft) }, children: item.isDraft ? 'draft' : item.state.toLowerCase() }),
        ] }),
        jsx('div', { className: 'mt-1 line-clamp-2 text-xs text-(--ui-text-primary)', children: item.title }),
        jsxs('div', { className: 'mt-1 flex items-center gap-1.5 text-[10px] text-(--ui-text-quaternary)', children: [
          jsx('span', { children: item.author || '—' }),
          jsx('span', { children: '·' }),
          jsx('span', { children: formatTaskAge(item.updatedAt) }),
          ...(item.labels || []).slice(0, 3).map(l => jsx(LabelChip, { label: typeof l === 'string' ? l : l?.name }, typeof l === 'string' ? l : l?.name)),
        ] }),
      ],
    }),
    jsx(Button, { size: 'sm', variant: 'ghost', className: 'h-7 px-2 text-[11px]', onClick: () => openTaskDetail(item), children: 'Open details' }),
    jsx(StartWorktreeButton, { item }),
  ] })
}

function RepoFilterRow({ repos, selected, onChange }) {
  const toggle = r => onChange(selected.includes(r) ? selected.filter(x => x !== r) : [...selected, r])
  return jsxs('div', { className: 'flex flex-wrap gap-1', children: [
    ...(repos || []).map(r => jsx('button', {
      key: r, type: 'button',
      className: cn('rounded-full border px-2 py-0.5 text-[10px]',
        selected.includes(r) ? 'border-(--ui-accent) text-(--ui-accent)' : 'border-(--ui-stroke-secondary) text-(--ui-text-tertiary)'),
      onClick: () => toggle(r), children: r.split('/').pop(),
    })),
    selected.length ? jsx('button', { type: 'button', className: 'text-[10px] text-(--ui-text-quaternary)', onClick: () => onChange([]), children: 'clear' }) : null,
  ] })
}

function TasksToolbar() {
  const repos = useValue($selectedRepos)
  const filter = useValue($filter)
  const set = patch => {
    const next = { ...$filter.get(), ...patch }
    $filter.set(next)
    if (pluginCtx) pluginCtx.storage.set(STORAGE_KEY_FILTER, { ...next, query: '' })
  }
  return jsxs('div', { className: 'flex shrink-0 flex-col gap-1.5 border-b border-(--ui-stroke-secondary) p-2', children: [
    jsx(SearchField, { value: filter.query, onChange: v => set({ query: v }), placeholder: 'Search issues and PRs...', className: 'w-full' }),
    jsx(SegmentedControl, { value: filter.state, onChange: v => set({ state: v }), className: 'w-full',
      options: [{ id: 'open', label: 'Open' }, { id: 'all', label: 'All' }, { id: 'closed', label: 'Closed' }] }),
    jsxs('div', { className: 'flex flex-wrap items-center gap-1.5', children: [
      jsx(SegmentedControl, { value: filter.kind, onChange: v => set({ kind: v }), className: 'w-full',
        options: [{ id: 'all', label: 'All' }, { id: 'pr', label: 'PRs' }, { id: 'issue', label: 'Issues' }] }),
      jsxs(Select, { value: filter.sort, onValueChange: v => set({ sort: v }), children: [
        jsx(SelectTrigger, { className: 'h-7 text-[11px]', children: jsx(SelectValue, { placeholder: 'Sort' }) }),
        jsxs(SelectContent, { children: [
          jsx(SelectItem, { value: 'updated', children: 'Recently updated' }),
          jsx(SelectItem, { value: 'created', children: 'Newest' }),
          jsx(SelectItem, { value: 'repo', children: 'By repo' }),
        ] }),
      ] }),
      jsx(Tip, { label: 'Group by repository', children: jsx(Button, {
        variant: filter.group ? 'secondary' : 'ghost', size: 'sm', className: 'h-7 px-2 text-[11px]',
        onClick: () => set({ group: !filter.group }), children: 'Group' }) }),
    ] }),
    repos.length > 1 ? jsx(RepoFilterRow, { repos, selected: filter.repos, onChange: v => set({ repos: v }) }) : null,
  ] })
}

function TaskRow({ item }) {
  return jsxs('div', { className: 'grid items-center gap-2 px-2 py-1 text-xs border-b border-(--ui-stroke-secondary) hover:bg-(--ui-bg-quinary)', style: { gridTemplateColumns: 'minmax(150px, 1.3fr) 48px minmax(180px, 2.2fr) 74px 92px 54px minmax(170px, 1fr)' }, children: [
    jsx('span', { className: 'truncate font-medium text-(--ui-text-secondary)', children: item.repo }),
    jsx('span', { className: 'text-(--ui-text-tertiary)', children: `#${item.number}` }),
    jsx('div', { className: 'truncate', children: [
      jsx('span', { children: item.title }),
      item.kind === 'pr' ? jsx(Codicon, { className: 'ml-1 inline text-(--ui-text-quaternary)', name: 'git-pull-request' }) : null,
    ] }),
    jsx('span', { className: cn('truncate', stateColor(item.state, item.isDraft)), style: { color: stateColor(item.state, item.isDraft) }, children: item.isDraft ? 'draft' : item.state.toLowerCase() }),
    jsx('span', { className: 'truncate text-(--ui-text-quaternary)', children: item.author || '—' }),
    jsx('span', { className: 'text-(--ui-text-quaternary)', children: formatTaskAge(item.updatedAt) }),
    jsx(StartWorktreeButton, { item }),
  ] })
}

function TasksList() {
  const repos = useValue($selectedRepos)
  const filter = useValue($filter)
  const q = useRepoItems()
  const rows = useMemo(() => sortItems(filterItems(q.data || [], filter), filter.sort), [q.data, filter])
  const grouped = filter.group ? groupByRepo(rows) : null
  if (!repos.length) return jsx(EmptyState, { title: 'No repositories selected', description: 'Pick repositories in Settings -> Plugins -> Git Tasks.' })
  if (q.isLoading) return jsxs('div', { className: 'space-y-2 p-3', children: [
    jsx(Skeleton, { className: 'h-12 w-full rounded-md' }),
    jsx(Skeleton, { className: 'h-12 w-full rounded-md' }),
  ] })
  if (q.isError) {
    const msg = String(q.error?.message || q.error)
    if (typeof console !== 'undefined') console.error('[git-tasks] task list failed:', q.error)
    return jsxs('div', { className: 'm-2 rounded-lg border border-red-500 bg-red-950/40 p-3 text-sm text-red-200', children: [
      jsx('div', { className: 'font-semibold', children: 'Failed to load tasks' }),
      jsx('div', { className: 'mt-1 whitespace-pre-wrap break-words text-xs', children: msg }),
      jsxs('div', { className: 'mt-2 flex gap-2', children: [
        jsx(Button, { size: 'sm', variant: 'ghost', className: 'h-7 px-2 text-[11px]', onClick: () => { try { navigator.clipboard?.writeText(msg) } catch {} }, children: 'Copy error' }),
        jsx(Button, { size: 'sm', className: 'h-7 px-2 text-[11px]', onClick: () => q.refetch(), children: 'Retry' }),
      ] }),
    ] })
  }
  if (!rows.length) return jsx(EmptyState, { title: 'Nothing matches', description: 'Adjust the filters or add repositories.' })
  return jsx(ScrollArea, { className: 'h-full', children: jsx('div', { className: 'flex flex-col gap-1.5 p-3', children: grouped
    ? grouped.flatMap(g => [jsx('div', { className: 'mt-2 text-[10px] font-semibold text-(--ui-text-tertiary)', children: g.repo }, g.repo), ...g.items.map(item => jsx(TaskCard, { item }, itemRef(item)))])
    : rows.map(item => jsx(TaskCard, { item }, itemRef(item))) }) })
}

function TasksPane() {
  const selected = useValue($selectedTask)
  if (selected) return jsx(TaskDetail, { item: selected, onClose: () => $selectedTask.set(null) })
  return jsx(TasksView, {})
}

function TaskDetail({ item, onClose }) {
  const [body, setBody] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [mergeChoice, setMergeChoice] = useState('')
  const view = useQuery({
    queryKey: [ID, 'view', item.repo, item.number, item.kind],
    queryFn: () => viewItem(item),
    staleTime: 30_000,
  })
  const act = fn => async () => {
    setBusy(true); setErr('')
    try { await fn() } catch (e) { setErr(String(e?.message || e)); host.notify?.({ kind: 'error', message: String(e?.message || e) }) }
    finally { setBusy(false) }
  }
  const detail = (view.data && typeof view.data === 'object') ? view.data : {}
  const labels = Array.isArray(detail.labels) ? detail.labels : (Array.isArray(item.labels) ? item.labels : [])
  const comments = Array.isArray(detail.comments) ? detail.comments : []
  const assignees = Array.isArray(detail.assignees) ? detail.assignees : []
  const reviewers = Array.isArray(detail.requestedReviewers) ? detail.requestedReviewers : []
  const checks = Array.isArray(detail.statusCheckRollup) ? detail.statusCheckRollup : []
  const authorName = typeof detail.author === 'string' ? detail.author : (detail.author?.login || item.author || '—')
  return jsxs('div', { className: 'flex h-full min-h-0 flex-col', children: [
    jsxs('div', { className: 'flex shrink-0 flex-wrap items-center gap-1.5 border-b border-(--ui-stroke-secondary) p-2', children: [
      jsx(Button, { variant: 'ghost', size: 'sm', className: 'h-7 w-7 p-0', onClick: onClose, 'aria-label': 'Back', children: jsx(Codicon, { name: 'chevron-left' }) }),
      jsx('span', { className: 'min-w-0 flex-1 truncate text-[11px] text-(--ui-text-tertiary)', children: itemRef(item) }),
      jsx(StartWorktreeButton, { item }),
      jsx(Button, { size: 'sm', className: 'h-7 px-2 text-[11px]', disabled: busy,
        onClick: act(async () => { await setItemState(item, item.state === 'OPEN' ? 'close' : 'reopen'); await queryClient.invalidateQueries({ queryKey: [ID, 'items'] }) }),
        children: item.state === 'OPEN' ? 'Close' : 'Reopen' }),
      jsx(CopyButton, { appearance: 'icon', buttonSize: 'icon-sm', label: 'Copy checkout command', text: formatCheckoutCmd(item) }),
      jsx(Button, { variant: 'ghost', size: 'sm', className: 'h-7 w-7 p-0', onClick: () => { void window.hermesDesktop?.openExternal?.(item.url) }, 'aria-label': 'Open on GitHub', children: jsx(Codicon, { name: 'link-external' }) }),
    ] }),
    jsx(ScrollArea, { className: 'min-h-0 flex-1', children: jsxs('div', { className: 'space-y-3 p-3 text-xs', children: [
      jsx('h2', { className: 'text-sm font-semibold text-(--ui-text-primary) break-words', children: detail.title || item.title }),
      jsxs('div', { className: 'grid grid-cols-1 gap-y-1 rounded-lg border border-(--ui-stroke-secondary) bg-(--ui-bg-quaternary) p-2 sm:grid-cols-[100px_minmax(0,1fr)]', children: [
        jsx('span', { className: 'text-[10px] text-(--ui-text-tertiary)', children: 'Repository' }),
        jsx('span', { className: 'text-[10px] text-(--ui-text-secondary) break-words', children: item.repo }),
        jsx('span', { className: 'text-[10px] text-(--ui-text-tertiary)', children: 'Type' }),
        jsx('span', { className: 'text-[10px] text-(--ui-text-secondary)', children: item.kind === 'pr' ? 'Pull request' : 'Issue' }),
        jsx('span', { className: 'text-[10px] text-(--ui-text-tertiary)', children: 'State' }),
        jsx('span', { className: 'text-[10px] text-(--ui-text-secondary)', children: detail.state || item.state }),
        jsx('span', { className: 'text-[10px] text-(--ui-text-tertiary)', children: 'Author' }),
        jsx('span', { className: 'text-[10px] text-(--ui-text-secondary) break-words', children: authorName }),
        jsx('span', { className: 'text-[10px] text-(--ui-text-tertiary)', children: 'Created' }),
        jsx('span', { className: 'text-[10px] text-(--ui-text-secondary)', children: detail.createdAt || item.createdAt }),
        jsx('span', { className: 'text-[10px] text-(--ui-text-tertiary)', children: 'Updated' }),
        jsx('span', { className: 'text-[10px] text-(--ui-text-secondary)', children: detail.updatedAt || item.updatedAt }),
        (detail.baseRefName || detail.headRefName) ? jsx('span', { className: 'text-[10px] text-(--ui-text-tertiary)', children: 'Branch' }) : null,
        (detail.baseRefName || detail.headRefName) ? jsx('span', { className: 'text-[10px] text-(--ui-text-secondary) break-words', children: (detail.headRefName ? detail.headRefName + ' -> ' : '') + (detail.baseRefName || '') }) : null,
        labels.length ? jsx('span', { className: 'text-[10px] text-(--ui-text-tertiary)', children: 'Labels' }) : null,
        labels.length ? labels.map((l, i) => jsx('span', { key: i, className: 'rounded bg-(--ui-bg-quinary) px-1 text-[9px] text-(--ui-text-tertiary)', children: typeof l === 'string' ? l : l?.name })) : jsx('span', { className: 'text-[10px] text-(--ui-text-quaternary)', children: 'None' }),
        assignees.length ? jsx('span', { className: 'text-[10px] text-(--ui-text-tertiary)', children: 'Assignees' }) : null,
        assignees.length ? assignees.map((a, i) => jsx('span', { key: i, className: 'rounded bg-(--ui-bg-quinary) px-1 text-[9px] text-(--ui-text-tertiary)', children: typeof a === 'string' ? a : (a?.login || a?.name || 'unknown') })) : jsx('span', { className: 'text-[10px] text-(--ui-text-quaternary)', children: 'No one assigned' }),
        reviewers.length ? jsx('span', { className: 'text-[10px] text-(--ui-text-tertiary)', children: 'Reviewers' }) : null,
        reviewers.length ? reviewers.map((r, i) => jsx('span', { key: i, className: 'rounded bg-(--ui-bg-quinary) px-1 text-[9px] text-(--ui-text-tertiary)', children: typeof r === 'string' ? r : (r?.login || r?.name || 'unknown') })) : jsx('span', { className: 'text-[10px] text-(--ui-text-quaternary)', children: 'No reviewers' }),
        checks.length ? jsx('span', { className: 'text-[10px] text-(--ui-text-tertiary)', children: 'Checks' }) : null,
        checks.length ? checks.map((c, i) => jsx('span', { key: i, className: cn('rounded bg-(--ui-bg-quinary) px-1 text-[9px]', c.conclusion === 'SUCCESS' ? 'text-green-400' : c.conclusion === 'FAILURE' ? 'text-red-400' : 'text-(--ui-text-quaternary)'), children: (c.conclusion || c.status || 'pending') + ' ' + (c.name || c.context || 'check') })) : jsx('span', { className: 'text-[10px] text-(--ui-text-quaternary)', children: 'No checks reported yet' }),
      ] }),
      item.kind === 'pr' && item.state === 'OPEN' ? jsxs('div', { className: 'rounded-lg border border-(--ui-stroke-secondary) bg-(--ui-bg-quaternary) p-2', children: [
        jsx('div', { className: 'text-[11px] font-semibold text-(--ui-text-tertiary)', children: 'Merge' }),
        jsxs('div', { className: 'mt-1 flex flex-wrap gap-1.5', children: [
          jsx(Select, { value: mergeChoice, onValueChange: v => { setMergeChoice(v); void act(async () => { await sh(`gh pr merge ${Number(item.number)} --repo ${sq(item.repo)} --${v}`); setMergeChoice('') })() }, children: [
            jsx(SelectTrigger, { className: 'h-7 text-[11px]', children: jsx(SelectValue, { placeholder: 'Merge...' }) }),
            jsxs(SelectContent, { children: [
              jsx(SelectItem, { value: 'merge', children: 'Create merge commit' }),
              jsx(SelectItem, { value: 'squash', children: 'Squash and merge' }),
              jsx(SelectItem, { value: 'rebase', children: 'Rebase and merge' }),
            ] }),
          ] }),
        ] }),
      ] }) : null,
      jsx('div', { className: 'whitespace-pre-wrap break-words text-(--ui-text-secondary)', children: view.isLoading ? 'Loading...' : (detail.body || 'No description.') }),
      comments.length ? jsxs('div', { className: 'space-y-2', children: [
        jsx('div', { className: 'text-[11px] font-semibold text-(--ui-text-tertiary)', children: 'Comments (' + comments.length + ')' }),
        comments.map((c, i) => jsxs('div', { key: i, className: 'rounded border border-(--ui-stroke-secondary) p-2', children: [
          jsx('div', { className: 'text-[10px] text-(--ui-text-tertiary)', children: (typeof c.author === 'string' ? c.author : (c.author?.login || c.user?.login || 'unknown')) + ' · ' + (c.createdAt || c.created_at || '') }),
          jsx('div', { className: 'mt-1 whitespace-pre-wrap break-words text-(--ui-text-secondary)', children: c.body || '' }),
        ] })),
      ] }) : null,
    ] }) }),
    jsxs('div', { className: 'shrink-0 border-t border-(--ui-stroke-secondary) p-2', children: [
      jsx(Textarea, { value: body, onChange: e => setBody(e.target.value), placeholder: 'Leave a comment...', className: 'min-h-[64px] text-xs' }),
      jsxs('div', { className: 'mt-1 flex items-center gap-1.5', children: [
        jsx(Button, { size: 'sm', className: 'h-7 px-2 text-[11px]', disabled: busy || !body.trim(),
          onClick: act(async () => { await postComment(item, body); setBody('') }), children: 'Comment' }),
        err ? jsx('span', { className: 'text-[10px] text-(--ui-text-quaternary)', children: err }) : null,
      ] }),
    ] }),
  ] })
}
function TasksPage() {
  const selected = useValue($selectedTask)
  if (selected) return jsx(TaskDetail, { item: selected, onClose: () => $selectedTask.set(null) })
  return jsx(TasksView, {})
}

function RepoSettings() {
  const repos = useValue($selectedRepos)
  const [q, setQ] = useState('')
  const list = useQuery({ queryKey: [ID, 'gh-repos'], queryFn: () => listUserRepos(50), staleTime: 600_000 })
  const available = useMemo(
    () => (list.data || []).filter(r => r.repo.toLowerCase().includes(q.toLowerCase())),
    [list.data, q]
  )
  const toggle = repo => persistRepos(pluginCtx, repos.includes(repo) ? repos.filter(r => r !== repo) : [...repos, repo])
  return jsxs('div', { className: 'flex flex-col gap-2 p-3', children: [
    jsx('div', { className: 'text-xs text-(--ui-text-tertiary)', children: 'Repositories shown in the Tasks view' }),
    jsx(SearchField, { value: q, onChange: setQ, placeholder: 'Filter repositories...' }),
    jsx('div', { className: 'flex min-h-0 flex-1 flex-col gap-1 overflow-auto', children:
      available.map(r => jsx('label', { key: r.repo, className: 'flex items-center gap-2 text-xs', children: [
        jsx(Checkbox, { checked: repos.includes(r.repo), onCheckedChange: () => toggle(r.repo) }),
        jsx('span', { className: 'truncate', children: r.repo }),
        r.private ? jsx('span', { className: 'text-[9px] text-(--ui-text-quaternary)', children: 'private' }) : null,
      ] }))
    }),
  ] })
}

function CloneRootsSettings() {
  const roots = useValue($cloneRoots)
  const [text, setText] = useState(roots.join('\n'))
  const [saved, setSaved] = useState(false)
  return jsxs('div', { className: 'flex flex-col gap-2 p-3', children: [
    jsx('div', { className: 'text-xs text-(--ui-text-tertiary)', children: 'Folders scanned for local git checkouts (one per line, ~ allowed)' }),
    jsx(Textarea, { value: text, onChange: e => { setText(e.target.value); setSaved(false) }, className: 'min-h-[120px] font-mono text-xs' }),
    jsxs('div', { className: 'flex items-center gap-2', children: [
      jsx(Button, { size: 'sm', className: 'h-7 px-2 text-[11px]', onClick: () => { persistCloneRoots(pluginCtx, text); setText($cloneRoots.get().join('\n')); setSaved(true) }, children: 'Save' }),
      jsx(Button, { variant: 'ghost', size: 'sm', className: 'h-7 px-2 text-[11px]', onClick: () => { setText(DEFAULT_CLONE_ROOTS.join('\n')); setSaved(false) }, children: 'Reset to defaults' }),
      saved ? jsx('span', { className: 'text-[10px] text-(--ui-text-quaternary)', children: 'Saved.' }) : null,
    ] }),
  ] })
}

function TasksStatusChip() {
  const repos = useValue($selectedRepos)
  const q = useRepoItems()
  const n = (q.data || []).filter(i => i.state === 'OPEN').length
  return jsx(Tip, { label: `${n} open across ${repos.length} repos`, children: jsx('button', {
    type: 'button',
    className: cn('inline-flex h-full items-center gap-1 px-1.5 text-[0.6875rem] text-(--ui-text-tertiary) hover:text-foreground'),
    onClick: () => host.navigate(TASKS_ROUTE),
    children: `${n} open`,
  }) })
}

function TasksView() {
  return jsxs('div', { className: 'flex h-full min-h-0 flex-col', children: [
    jsx(RepoPicker, {}),
    jsx(TasksToolbar, {}),
    jsx('div', { className: 'min-h-0 flex-1', children: jsx(TasksList, {}) }),
  ] })
}

function RepoPicker() {
  const selected = useValue($selectedRepos)
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [repos, setRepos] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    if (!open) return
    let cancelled = false
    setError('')
    setLoading(true)
    setRepos(null)
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('Loading repositories timed out after 5 seconds')), 5000))
    void Promise.race([listUserRepos(50), timeout])
      .then(result => { if (!cancelled) { setRepos(Array.isArray(result) ? result : []); setLoading(false) } })
      .catch(e => { if (!cancelled) { setError(String(e?.message || e)); setLoading(false) } })
    return () => { cancelled = true }
  }, [open])
  const available = useMemo(
    () => (repos || []).filter(r => r.repo.toLowerCase().includes(q.toLowerCase())),
    [repos, q]
  )
  const toggle = repo => persistRepos(pluginCtx, selected.includes(repo) ? selected.filter(r => r !== repo) : [...selected, repo])
  return jsxs('div', { className: 'relative z-10 shrink-0 border-b border-(--ui-stroke-secondary) px-2 py-1.5', children: [
    jsxs('div', { className: 'flex items-center gap-2', children: [
      jsx('span', { className: 'text-[11px] font-medium text-(--ui-text-tertiary)', children: 'Repositories' }),
      jsx(Button, { size: 'sm', variant: 'ghost', className: 'h-7 px-2 text-[11px]', onClick: () => setOpen(!open), children: `${selected.length} selected` }),
      selected.length > 0 ? jsx('button', { type: 'button', className: 'text-[10px] text-(--ui-text-quaternary)', onClick: () => persistRepos(pluginCtx, []), children: 'clear' }) : null,
    ] }),
    open ? jsxs('div', { className: 'mt-1 rounded-lg border border-(--ui-stroke-secondary) bg-(--ui-bg-secondary) p-2 text-(--ui-text-primary) shadow-lg', children: [
        jsx(SearchField, { value: q, onChange: setQ, placeholder: 'Filter repositories...' }),
        jsx('div', { className: 'mt-2 max-h-80 overflow-auto', children:
          loading ? jsx('div', { className: 'p-2 text-[11px] text-(--ui-text-tertiary)', children: 'Loading repositories...' }) :
          error ? jsx('div', { className: 'p-2 text-[11px] text-red-400', children: error }) :
          available.length === 0 ? jsx('div', { className: 'p-2 text-[11px] text-(--ui-text-tertiary)', children: 'No repositories found.' }) :
          available.map(r => jsx('label', { key: r.repo, className: 'flex items-center gap-2 rounded px-2 py-1 text-xs hover:bg-(--ui-bg-tertiary)', children: [
            jsx(Checkbox, { checked: selected.includes(r.repo), onCheckedChange: () => toggle(r.repo) }),
            jsx('span', { className: 'truncate', children: r.repo }),
            r.private ? jsx('span', { className: 'text-[9px] text-(--ui-text-quaternary)', children: 'private' }) : null,
          ] }))
        }),
      ] }) : null,
  ] })
}


function formatTaskAge(value) {
  const ms = Date.parse(value || '')
  if (!Number.isFinite(ms)) return ''
  const diff = Date.now() - ms
  if (diff < 60000) return 'just now'
  if (diff < 3600000) return `${Math.round(diff / 60000)}m`
  if (diff < 86400000) return `${Math.round(diff / 3600000)}h`
  return `${Math.round(diff / 86400000)}d`
}

export default {
  id: ID,
  name: 'Git Tasks',
  register(ctx) {
    pluginCtx = ctx
    loadPersisted(ctx)
    ctx.register({
      id: 'pane', area: PANES_AREA_LIT, title: 'Tasks',
      data: { placement: 'right', dock: { pane: 'workspace', pos: 'right' }, width: '460px' },
      render: () => jsx(TasksPane, {})
    })
    ctx.register({ id: 'route-tasks', area: ROUTES_AREA_LIT, data: { path: TASKS_ROUTE }, render: () => jsx(TasksPage, {}) })
    ctx.register({ id: 'nav-tasks', area: SIDEBAR_NAV_LIT, order: 14, data: { path: TASKS_ROUTE, label: 'Tasks', codicon: 'project' } })
    ctx.register({ id: 'palette-open', area: PALETTE_AREA_LIT, data: { id: 'git-tasks.open', label: 'Git Tasks: Open', keywords: ['tasks', 'issues', 'prs', 'github'], run: () => host.navigate(TASKS_ROUTE) } })
    const settings = [
      { id: 'repos', title: 'Repositories', icon: 'repo', order: 60, render: () => jsx(RepoSettings, {}) },
      { id: 'clone-roots', title: 'Clone folders', icon: 'folder', order: 61, render: () => jsx(CloneRootsSettings, {}) },
    ]
    if (typeof ctx.registerSettingsPage === 'function') {
      ctx.registerSettingsPage({ id: 'git-tasks', title: 'Git Tasks', icon: 'project', children: settings })
    } else {
      for (const s of settings) ctx.register({ id: `settings-${s.id}`, area: SETTINGS_PLUGINS_AREA_LIT, title: `Git Tasks — ${s.title}`, render: s.render })
    }
    ctx.register({ id: 'status', area: STATUSBAR_RIGHT_LIT, order: 90, render: () => jsx(TasksStatusChip, {}) })
  },
}
