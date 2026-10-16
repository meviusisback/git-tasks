
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  sq, repoOk, parseRepoList, remoteToRepo, parseCloneRoots, expandRoot, DEFAULT_CLONE_ROOTS,
  buildCloneScanCommand, buildListScript, parseListOutput, filterItems, sortItems, groupByRepo,
  deriveBranchName, formatSeedMessage, itemRef, stateColor, deriveChunkOffsets,
  formatCheckoutCmd, formatViewCmd, formatStateCmd, formatWorktreeRemoveCmd, buildCommentCmd,
  readChunksConcurrently, pickLocalClone, parseCloneScanOutput, buildWorktreeCommand,
  STORAGE_KEY_REPOS, STORAGE_KEY_CLONE_ROOTS,
} from '../desktop/plugin.js'

test('sq single-quotes and escapes embedded single quotes', () => {
  assert.equal(sq('hello'), "'hello'")
  assert.equal(sq("it's"), "'it'\\''s'")
})

test('repoOk accepts owner/repo and rejects junk', () => {
  assert.equal(repoOk('meviusisback/omarchy-ai-subs'), true)
  assert.equal(repoOk('a/b'), true)
  assert.equal(repoOk('no-slash'), false)
  assert.equal(repoOk('a/b/c'), false)
  assert.equal(repoOk(''), false)
  assert.equal(repoOk(null), false)
  assert.equal(repoOk('../etc/passwd'), false)
})

test('parseRepoList normalizes, dedupes (case-insensitive) and drops invalid entries', () => {
  const out = parseRepoList(`
    meviusisback/omarchy-ai-subs
    MEVIUSISBACK/omarchy-ai-subs
    meviusisback/agent-orchestr   # trailing comment
    not-a-repo
    https://github.com/meviusisback/modelforge
  `)
  assert.deepEqual(out, ['meviusisback/omarchy-ai-subs', 'meviusisback/agent-orchestr', 'meviusisback/modelforge'])
})

test('parseRepoList returns [] for empty input', () => {
  assert.deepEqual(parseRepoList(''), [])
  assert.deepEqual(parseRepoList(null), [])
})

test('remoteToRepo extracts owner/repo from git remote URL shapes', () => {
  assert.equal(remoteToRepo('https://github.com/meviusisback/omarchy-ai-subs.git'), 'meviusisback/omarchy-ai-subs')
  assert.equal(remoteToRepo('https://github.com/meviusisback/omarchy-hw-monitor'), 'meviusisback/omarchy-hw-monitor')
  assert.equal(remoteToRepo('git@github.com:meviusisback/botty.git'), 'meviusisback/botty')
  assert.equal(remoteToRepo('ssh://git@github.com/meviusisback/supermarkets.git'), 'meviusisback/supermarkets')
  assert.equal(remoteToRepo('https://gitlab.com/foo/bar.git'), null)
  assert.equal(remoteToRepo(''), null)
})

test('parseCloneRoots trims, drops comments/empties and dedupes', () => {
  const out = parseCloneRoots(`
    ~/repo
    ~/repos    # main clones
    /abs/path

    ~/repo
  `)
  assert.deepEqual(out, ['~/repo', '~/repos', '/abs/path'])
})

test('parseCloneRoots falls back to defaults when empty', () => {
  assert.deepEqual(parseCloneRoots(''), DEFAULT_CLONE_ROOTS)
  assert.deepEqual(parseCloneRoots('# only a comment'), DEFAULT_CLONE_ROOTS)
})

test('parseCloneRoots rejects roots that would break out of the shell or the path', () => {
  const out = parseCloneRoots("~/ok\n; rm -rf /\n$(whoami)\n`id`\n~/a b")
  assert.deepEqual(out, ['~/ok', '~/a b'])
})

test('expandRoot swaps a leading ~ for the home directory', () => {
  assert.equal(expandRoot('~/repo', '/home/alberto'), '/home/alberto/repo')
  assert.equal(expandRoot('~', '/home/alberto'), '/home/alberto')
  assert.equal(expandRoot('/abs/path', '/home/alberto'), '/abs/path')
  assert.equal(expandRoot('~/repo', ''), '~/repo')
})

test('buildCloneScanCommand expands roots, quotes them and prints path<TAB>remote', () => {
  const c = buildCloneScanCommand(['~/repo', '/abs/path'], '/home/alberto')
  assert.match(c, /'\/home\/alberto\/repo'/)
  assert.match(c, /'\/abs\/path'/)
  assert.match(c, /remote get-url origin/)
  assert.match(c, /\\t/)
  assert.ok(!c.includes('rm -rf'))
})

test('buildCloneScanCommand ignores roots that escape into metacharacters', () => {
  const c = buildCloneScanCommand(['~/ok', '$(whoami)'], '/home/alberto')
  assert.ok(!c.includes('whoami'))
  assert.match(c, /'\/home\/alberto\/ok'/)
})

test('buildListScript emits one PR and one issue block per valid repo', () => {
  const s = buildListScript(['meviusisback/omarchy-ai-subs', 'meviusisback/agent-orchestr'], { state: 'open', limit: 20 })
  assert.equal((s.match(/@@R /g) || []).length, 4)
  assert.match(s, /@@R meviusisback\/omarchy-ai-subs pr/)
  assert.match(s, /@@R meviusisback\/agent-orchestr issue/)
  assert.match(s, /--state open/)
  assert.match(s, /--limit 20/)
})

test('buildListScript drops invalid repo names and escapes quoting', () => {
  const s = buildListScript(['ok/repo', 'bad', "we'ird/repo"], {})
  assert.equal((s.match(/@@R /g) || []).length, 4)
  assert.ok(!s.includes('@@R bad '))
  assert.match(s, /'we'\\''ird\/repo'/)
})

test('buildListScript never emits a bare eval and never uses rm', () => {
  const s = buildListScript(['a/b'], {})
  assert.ok(s.startsWith('set -o pipefail;'))
  assert.ok(!/\brm\b/.test(s))
})

test('parseListOutput flattens marked blocks into unified items', () => {
  const raw = readFileSync(new URL('./fixtures/list-script-output.txt', import.meta.url), 'utf8')
  const items = parseListOutput(raw)
  assert.equal(items.length, 2)
  assert.deepEqual(items[0], {
    kind: 'pr', repo: 'meviusisback/omarchy-ai-subs', number: 9,
    title: 'feat(deepseek): pricing clock', state: 'MERGED', isDraft: false,
    author: 'meviusisback', createdAt: '2026-10-12T20:04:44Z',
    updatedAt: '2026-10-12T20:08:27Z', labels: [],
    url: 'https://github.com/meviusisback/omarchy-ai-subs/pull/9',
  })
  assert.equal(items[1].repo, 'meviusisback/omarchy-hw-monitor')
})

test('parseListOutput tolerates empty, malformed and non-JSON blocks', () => {
  assert.deepEqual(parseListOutput(''), [])
  assert.deepEqual(parseListOutput('garbage without markers'), [])
  assert.deepEqual(parseListOutput('@@R a/b pr\nnot json'), [])
})


const SAMPLE = [
  { kind: 'pr', repo: 'a/one', number: 1, title: 'Add login', state: 'OPEN', isDraft: false, author: 'x', labels: [{ name: 'bug' }], url: 'u1' },
  { kind: 'pr', repo: 'a/two', number: 2, title: 'Fix crash', state: 'MERGED', isDraft: false, author: 'y', labels: [], url: 'u2' },
  { kind: 'issue', repo: 'a/two', number: 3, title: 'Login broken', state: 'OPEN', isDraft: false, author: 'z', labels: [{ name: 'bug' }, { name: 'p1' }], url: 'u3' },
  { kind: 'issue', repo: 'b/three', number: 4, title: 'Docs', state: 'CLOSED', isDraft: false, author: 'x', labels: [], url: 'u4' },
]

test('filterItems by state=open keeps OPEN only', () => {
  assert.deepEqual(filterItems(SAMPLE, { state: 'open' }).map(i => i.number), [1, 3])
})
test('filterItems by kind', () => {
  assert.deepEqual(filterItems(SAMPLE, { kind: 'pr' }).map(i => i.number), [1, 2])
  assert.deepEqual(filterItems(SAMPLE, { kind: 'issue' }).map(i => i.number), [3, 4])
})
test('filterItems by source repo (exact)', () => {
  assert.deepEqual(filterItems(SAMPLE, { repos: ['a/two'] }).map(i => i.number), [2, 3])
  assert.deepEqual(filterItems(SAMPLE, { repos: ['a/two', 'b/three'] }).map(i => i.number), [2, 3, 4])
})
test('filterItems text search hits title, number, author and labels', () => {
  assert.deepEqual(filterItems(SAMPLE, { query: 'login' }).map(i => i.number), [1, 3])
  assert.deepEqual(filterItems(SAMPLE, { query: '#2' }).map(i => i.number), [2])
  assert.deepEqual(filterItems(SAMPLE, { query: 'p1' }).map(i => i.number), [3])
  assert.deepEqual(filterItems(SAMPLE, { query: 'nope' }), [])
})
test('filterItems with no criteria returns everything', () => {
  assert.equal(filterItems(SAMPLE, {}).length, 4)
})

const ROWS = [
  { number: 1, repo: 'a/one', updatedAt: '2026-10-01T00:00:00Z', createdAt: '2026-09-01T00:00:00Z' },
  { number: 2, repo: 'b/two', updatedAt: '2026-10-12T00:00:00Z', createdAt: '2026-09-02T00:00:00Z' },
  { number: 3, repo: 'a/one', updatedAt: '2026-10-05T00:00:00Z', createdAt: '2026-09-03T00:00:00Z' },
]
test('sortItems newest-updated first by default', () => {
  assert.deepEqual(sortItems(ROWS, 'updated').map(r => r.number), [2, 3, 1])
})
test('sortItems by repo then number', () => {
  assert.deepEqual(sortItems(ROWS, 'repo').map(r => r.number), [1, 3, 2])
})
test('sortItems does not mutate the input', () => {
  const before = ROWS.map(r => r.number)
  sortItems(ROWS, 'updated')
  assert.deepEqual(ROWS.map(r => r.number), before)
})
test('groupByRepo preserves first-seen repo order and buckets rows', () => {
  const g = groupByRepo(ROWS)
  assert.deepEqual(g.map(b => b.repo), ['a/one', 'b/two'])
  assert.deepEqual(g[0].items.map(r => r.number), [1, 3])
})

test('deriveBranchName slugs the title and prefixes the kind', () => {
  assert.equal(deriveBranchName({ kind: 'issue', repo: 'a/one', number: 42, title: 'Login broken on Wayland' }), 'issue/42-login-broken-on-wayland')
  assert.equal(deriveBranchName({ kind: 'pr', repo: 'a/one', number: 7, title: 'Fix: probe() crashes (idle dGPU!)' }), 'pr/7-fix-probe-crashes-idle-dgpu')
})
test('deriveBranchName never emits spaces or empty tails', () => {
  const out = deriveBranchName({ kind: 'issue', repo: 'a/b', number: 1, title: '!!!   ' })
  assert.equal(out, 'issue/1-task')
  assert.ok(!/\s/.test(out))
  assert.ok(out.length <= 80)
})
test('formatSeedMessage embeds repo, number, title and url', () => {
  const msg = formatSeedMessage({ kind: 'issue', repo: 'a/one', number: 42, title: 'Login broken', url: 'https://x/42' })
  assert.match(msg, /a\/one#42/)
  assert.match(msg, /Login broken/)
  assert.match(msg, /https:\/\/x\/42/)
  assert.match(msg, /issue/)
})
test('itemRef renders repo#number', () => {
  assert.equal(itemRef({ repo: 'a/b', number: 3 }), 'a/b#3')
})

test('formatCheckoutCmd differs for pr and issue', () => {
  assert.equal(formatCheckoutCmd({ kind: 'pr', repo: 'a/b', number: 4 }), 'gh pr checkout 4 --repo a/b')
  assert.match(formatCheckoutCmd({ kind: 'issue', repo: 'a/b', number: 5, title: 'Fix it' }), /git switch -c issue\/5-fix-it/)
})
test('formatViewCmd reads the right entity as JSON', () => {
  assert.equal(formatViewCmd({ kind: 'pr', repo: 'a/b', number: 4 }), "gh pr view 4 --repo 'a/b' --json number,title,body,state,author,createdAt,url,comments")
  assert.match(formatViewCmd({ kind: 'issue', repo: 'a/b', number: 5 }), /^gh issue view 5/)
})
test('formatStateCmd maps close/reopen per kind', () => {
  assert.equal(formatStateCmd({ kind: 'issue', repo: 'a/b', number: 5 }, 'close'), "gh issue close 5 --repo 'a/b'")
  assert.equal(formatStateCmd({ kind: 'issue', repo: 'a/b', number: 5 }, 'reopen'), "gh issue reopen 5 --repo 'a/b'")
  assert.equal(formatStateCmd({ kind: 'pr', repo: 'a/b', number: 4 }, 'close'), "gh pr close 4 --repo 'a/b'")
  assert.throws(() => formatStateCmd({ kind: 'issue', repo: 'a/b', number: 5 }, 'nuke'))
})
test('formatWorktreeRemoveCmd uses git worktree remove, never rm -rf', () => {
  const c = formatWorktreeRemoveCmd('/home/alberto/repo/x', 'issue/42-login-broken')
  assert.match(c, /worktree remove .*'\.worktrees\/issue-42-login-broken'/)
  assert.ok(!/\brm\b/.test(c))
})
test('buildCommentCmd targets issue or pr', () => {
  assert.match(buildCommentCmd({ kind: 'issue', repo: 'a/b', number: 5 }), /^gh issue comment 5 --repo 'a\/b'/)
  assert.match(buildCommentCmd({ kind: 'pr', repo: 'a/b', number: 4 }), /^gh pr comment 4 --repo 'a\/b'/)
})

test('deriveChunkOffsets returns 1-based byte offsets', () => {
  assert.deepEqual(deriveChunkOffsets(0), [])
  assert.deepEqual(deriveChunkOffsets(3800), [1])
  assert.deepEqual(deriveChunkOffsets(3801), [1, 3801])
  assert.deepEqual(deriveChunkOffsets(10000), [1, 3801, 7601])
})
test('deriveChunkOffsets rejects invalid input', () => {
  assert.throws(() => deriveChunkOffsets(-1))
  assert.throws(() => deriveChunkOffsets(1.5))
})

test('stateColor maps states to theme variables, never hex', () => {
  assert.equal(stateColor('OPEN', false), 'var(--ui-accent)')
  assert.equal(stateColor('MERGED', false), 'var(--ui-text-secondary)')
  assert.equal(stateColor('OPEN', true), 'var(--ui-text-tertiary)')
  for (const s of ['OPEN', 'MERGED', 'CLOSED', '']) assert.match(stateColor(s, false), /^var\(--ui-/)
})


const CLONES = [
  { path: '/home/alberto/repo/agent-orchestr', remote: 'https://github.com/meviusisback/agent-orchestr.git' },
  { path: '/home/alberto/repo/omarchy-hw-monitor', remote: 'https://github.com/meviusisback/omarchy-hw-monitor' },
  { path: '/home/alberto/orca/omalaunch', remote: 'https://github.com/daniellemky/omalaunch' },
]

test('pickLocalClone matches owner/repo case-insensitively', () => {
  assert.equal(pickLocalClone(CLONES, 'meviusisback/agent-orchestr'), '/home/alberto/repo/agent-orchestr')
  assert.equal(pickLocalClone(CLONES, 'MEVIUSISBACK/OMARCHY-HW-MONITOR'), '/home/alberto/repo/omarchy-hw-monitor')
})
test('pickLocalClone returns null when nothing matches', () => {
  assert.equal(pickLocalClone(CLONES, 'nobody/nothing'), null)
  assert.equal(pickLocalClone([], 'a/b'), null)
})
test('parseCloneScanOutput parses tab-separated rows and skips blanks', () => {
  const out = parseCloneScanOutput('/a/b\tgit@github.com:o/r.git\n\n/c/d\t\n')
  assert.deepEqual(out, [{ path: '/a/b', remote: 'git@github.com:o/r.git' }, { path: '/c/d', remote: '' }])
})

test('buildWorktreeCommand uses .worktrees/ and a slash-free dir name', () => {
  const c = buildWorktreeCommand('/home/alberto/repo/x', 'issue/42-login-broken')
  assert.match(c, /worktree add '\.worktrees\/issue-42-login-broken' -b 'issue\/42-login-broken'/)
  assert.match(c, /fetch --prune origin/)
})
test('buildWorktreeCommand can branch from a base ref and never uses rm', () => {
  const c = buildWorktreeCommand('/r', 'issue/1-a', 'origin/main')
  assert.match(c, /'origin\/main'$/)
  assert.ok(!/\brm\b/.test(c))
})

test('repo and clone-root selections round-trip through their parsers', () => {
  const fake = { d: {}, get(k, def) { return k in this.d ? this.d[k] : def }, set(k, v) { this.d[k] = v } }
  fake.set(STORAGE_KEY_REPOS, ['a/b', 'C/D'])
  assert.deepEqual(parseRepoList(fake.get(STORAGE_KEY_REPOS).join('\n')), ['a/b', 'C/D'])
  fake.set(STORAGE_KEY_CLONE_ROOTS, ['~/repo', '~/work'])
  assert.deepEqual(parseCloneRoots(fake.get(STORAGE_KEY_CLONE_ROOTS).join('\n')), ['~/repo', '~/work'])
})

test('readChunksConcurrently joins chunks in order with concurrency', async () => {
  const got = await readChunksConcurrently(10, async off => String(off), { chunkSize: 4, concurrency: 2 })
  assert.equal(got, '159')
})

test('parseCloneScanOutput trims trailing slashes on paths', () => {
  const out = parseCloneScanOutput('/a/b/\tgit@github.com:o/r.git\n')
   assert.equal(out[0].path, '/a/b')
})
