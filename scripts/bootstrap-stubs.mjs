#!/usr/bin/env node
/**
 * Create minimal module stubs so `node --test` works on a fresh clone.
 * The desktop runtime loads plugin.js from a blob URL and rewrites the
 * `@hermes/plugin-sdk` / `react` specifiers to its own in-app shims.
 * Node's test runner has no such rewrite, so these give the imports
 * somewhere to resolve to. They live in repo-local node_modules
 * (gitignored) and are never seen by the desktop loader.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const SDK_STUB = `export const host = {
  state: { activeSessionId: {}, cwd: {}, focusedSessionId: {} },
  request: async () => ({ code: 0, stdout: '', stderr: '' }),
  notify: () => {},
  navigate: () => {},
  openSession: () => {},
  onEvent: () => () => {},
}
export const atom = (init) => ({ get: () => init, set: () => {} })
export const useValue = () => null
export const useQuery = () => ({ isLoading: false, isError: false, data: null, refetch: () => {} })
export const useMutation = () => ({ mutate: () => {}, isPending: false, error: null })
export const queryClient = { invalidateQueries: () => Promise.resolve() }
export const haptic = () => {}
export const usePluginI18n = () => (key) => String(key)
export const pluginSettingsHref = (id, page) => '/settings?tab=plugins&plugin=' + id + (page ? '&ppage=' + page : '')
const Null = () => null
export const Button = Null
export const Input = Null
export const Textarea = Null
export const Badge = Null
export const CopyButton = Null
export const StatusDot = Null
export const ScrollArea = Null
export const EmptyState = Null
export const ErrorState = Null
export const GlyphSpinner = Null
export const Skeleton = Null
export const SearchField = Null
export const SegmentedControl = Null
export const Separator = Null
export const Checkbox = Null
export const Select = Null
export const SelectContent = Null
export const SelectItem = Null
export const SelectTrigger = Null
export const SelectValue = Null
export const Popover = Null
export const PopoverTrigger = Null
export const PopoverContent = Null
export const Dialog = Null
export const DialogContent = Null
export const DialogTrigger = Null
export const DialogHeader = Null
export const DialogTitle = Null
export const DialogDescription = Null
export const DialogFooter = Null
export const ConfirmDialog = Null
export const Codicon = Null
export const Tip = Null
export const icons = {}
export const cn = (...args) => args.filter(Boolean).join(' ')
export const relativeTime = () => ''
export const PALETTE_AREA = 'palette'
export const TITLEBAR_AREAS = { left: 'titlebar.left', center: 'titlebar.center', right: 'titlebar.right' }
export const PANES_AREA = 'panes'
export const ROUTES_AREA = 'routes'
export const SIDEBAR_NAV_AREA = 'sidebar.nav'
export const STATUSBAR_AREAS = { left: 'statusBar.left', right: 'statusBar.right' }
export const SETTINGS_PLUGINS_AREA = 'settings.plugins'
`

const files = {
  'node_modules/@hermes/plugin-sdk/package.json': { name: '@hermes/plugin-sdk', type: 'module', main: './index.js' },
  'node_modules/@hermes/plugin-sdk/index.js': SDK_STUB,
  'node_modules/react/package.json': {
    name: 'react', type: 'module', main: './index.js',
    exports: { '.': './index.js', './jsx-runtime': './jsx-runtime.js' },
  },
  'node_modules/react/index.js': `export const useState = (init) => [init, () => {}]
export const useEffect = () => {}
export const useMemo = (fn) => fn()
export const useRef = (init) => ({ current: init })
export const useCallback = (fn) => fn
export default { useState, useEffect, useMemo, useRef, useCallback }
`,
  'node_modules/react/jsx-runtime.js': `export const jsx = (type, props, key) => ({ type, props, key })
export const jsxs = (type, props, key) => ({ type, props, key })
export const Fragment = Symbol.for('react.fragment')
`,
}

for (const [rel, content] of Object.entries(files)) {
  const p = join(root, rel)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, typeof content === 'string' ? content : JSON.stringify(content, null, 2) + '\n')
}
console.log('stubs OK')
