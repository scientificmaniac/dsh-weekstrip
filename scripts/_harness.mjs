/**
 * Shared test harness: locate a DSH install, materialize the patched bundle text (applying the patch
 * in memory when the install is still clean), and evaluate it the way the DSH web shell does.
 *
 * Nothing here writes to the install; tests operate on an in-memory copy. Both layouts work: a loose
 * `<resources>/app/...client.js` and a DSH NEXT `app.asar` (the entry is read through the archive, or
 * through its unpacked override once patched).
 */

import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { readAsarEntry, readAsarIndex } from '../src/asar.mjs'
import { missingBundleMessage, resolveBundle } from '../src/bundle.mjs'
import { buildPatchedText, isPatched, readSnippet } from '../src/patch.mjs'

/** Resolve the target bundle; exiting 0 with a skip notice keeps CI green when no DSH install exists. */
export function loadBundleForTests(argv = process.argv.slice(2)) {
  const found = resolveBundle({ argv })
  if (found === null) {
    console.log('skip: no DSH Desktop / DSH NEXT install found on this machine.')
    console.log('      set DSH_ACCOUNT_BUNDLE / DSH_ASAR / DSH_RESOURCES_ROOT or pass --resources <dir>.')
    console.log('')
    console.log(missingBundleMessage())
    process.exit(0)
  }
  let raw
  let displayPath
  if (found.kind === 'asar') {
    const index = readAsarIndex(found.asarPath)
    raw = readAsarEntry(index, found.relPath).buffer.toString('utf8')
    displayPath = `${found.asarPath}!${found.relPath}`
  } else {
    raw = readFileSync(found.path, 'utf8')
    displayPath = found.path
  }
  const state = isPatched(raw) ? 'patched' : 'rebuilt-from-clean'
  const text = state === 'patched' ? raw : buildPatchedText(raw, readSnippet())
  return { target: { ...found, path: displayPath }, text, state }
}

/** Minimal React: only what the injected module uses outside a real render. */
export function createReactShim() {
  class Component {
    constructor(props) {
      this.props = props ?? {}
      this.state = {}
    }
    setState(update) {
      this.state = typeof update === 'function' ? { ...this.state, ...update(this.state) } : { ...this.state, ...update }
    }
  }
  const Fragment = Symbol.for('react.fragment')
  const createElement = (type, props, ...children) => {
    const flat = []
    const push = (value) => {
      if (Array.isArray(value)) value.forEach(push)
      else flat.push(value)
    }
    push(children)
    return { type, props: { ...(props ?? {}), children: flat.length === 1 ? flat[0] : flat } }
  }
  const React = {
    Fragment,
    createElement,
    createRef: () => ({ current: null }),
    useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
    useEffect: () => {},
    useLayoutEffect: () => {},
    useMemo: (fn) => fn(),
    useRef: (init) => ({ current: init }),
    useCallback: (fn) => fn,
    useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
    Component,
  }
  return { React, Fragment, Component }
}

/** Loose module stand-in for platform modules the bundle only touches during a real mount. */
export function proxyModule(name) {
  const fn = function () { return proxyModule(name) }
  return new Proxy(fn, {
    get(target, key) {
      if (key === 'prototype') return target.prototype
      if (key === Symbol.toPrimitive || key === 'then' || key === Symbol.iterator || key === 'toJSON') return undefined
      return proxyModule(name + '.' + String(key))
    },
    apply() { return proxyModule(name + '()') },
    construct() { return proxyModule('new ' + name) },
  })
}

/**
 * Evaluate the (patched) bundle through the shell's `__ModuleLoader__` protocol and return its exports,
 * with the injected internals exposed under `__test`.
 * @param {string} text patched bundle text
 * @param {{ exports?: string[], filename?: string }} [options] names to expose from module scope
 */
export function evaluateBundle(text, options = {}) {
  const names = options.exports ?? []
  let source = text
  const anchor = '\t\texports.apply = apply;'
  if (!source.includes(anchor)) throw new Error('bundle does not export apply where expected (unsupported build)')
  if (names.length > 0) {
    source = source.replace(anchor, `${anchor}\n\t\texports.__test = { ${names.join(', ')} };`)
  }
  const rows = []
  const context = vm.createContext({
    window: { __ModuleLoader__: { load: (row) => { rows.push(row) } } },
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    URL,
    TextEncoder,
    TextDecoder,
    fetch: () => Promise.reject(new Error('network disabled in tests')),
  })
  context.globalThis = context
  vm.runInContext(source, context, { filename: options.filename ?? 'client.js' })
  if (rows.length !== 1) throw new Error(`expected 1 module factory, got ${rows.length}`)
  const { React, Fragment } = createReactShim()
  const requireStub = (name) => {
    if (name === 'react') return React
    if (name === 'react/jsx-runtime') {
      return { jsx: React.createElement, jsxs: React.createElement, Fragment }
    }
    return proxyModule(name)
  }
  // The 0.2.2-rc.1 shell added `require.asset(id)` for plugin images (the account settings bundle now
  // ships an onboarding flow). Only a stable URL is needed here: the tests never load the image.
  requireStub.asset = (id) => `asset://${id}`
  const exports = rows[0].factory(requireStub)
  return { exports, moduleId: rows[0].id }
}
