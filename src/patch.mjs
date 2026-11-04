#!/usr/bin/env node
/**
 * dsh-weekstrip — patch engine and CLI.
 *
 * Appends a local usage panel (tokens / last 7 days / activity) under Settings → Account in DSH,
 * by inserting one self-contained module into the account-settings client bundle.
 *
 * Two install layouts are supported:
 *   - DSH Desktop: `<resources>/app/node_modules/@deepseek-ai/dsh-client-ui-settings-account/lib/client.js`
 *     is a loose file and is edited in place.
 *   - DSH NEXT: the same bundle lives inside `<resources>/app.asar`. There, the patched bundle is
 *     written to `<resources>/app.asar.unpacked/...` and the archive header is rewritten so that
 *     Electron reads the override (see src/asar.mjs). No data region is moved.
 *
 * Commands:
 *   node src/patch.mjs status    show target, layout, patched state, anchor hits, backups
 *   node src/patch.mjs verify    anchors + syntax check, writes nothing
 *   node src/patch.mjs apply     back up, then patch (idempotent)
 *   node src/patch.mjs revert    restore the most recent backup
 *
 * The bundle is located by src/bundle.mjs (flag → env → well-known install paths).
 */

import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PATCH_MARKER, VERIFIED_VERSIONS, textPatches } from './anchors.mjs'
import { missingBundleMessage, packageVersionOf, resolveBundle } from './bundle.mjs'
import { applyAsarBundle, listAsarBackups, planAsarOverride, readAsarEntry, readAsarIndex, revertAsarBundle } from './asar.mjs'
import { PatchError } from './errors.mjs'

export { PatchError }

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..')
export const SNIPPET_PATH = join(HERE, 'snippet.js')
export const BACKUP_DIR = join(REPO_ROOT, 'backups')
const SIMULATED_NAME = 'client.simulated.js'
const LOOSE_BACKUP_PATTERN = /^client\.js\.\d{14}\.bak$/

/** Read the module text that is appended to the bundle. */
export function readSnippet(snippetPath = SNIPPET_PATH) {
  if (!existsSync(snippetPath)) throw new PatchError(`snippet not found: ${snippetPath}`)
  return readFileSync(snippetPath, 'utf8').replace(/\r\n/g, '\n')
}

export function countOccurrences(haystack, needle) {
  if (needle === '') return 0
  let count = 0
  let from = 0
  for (;;) {
    const at = haystack.indexOf(needle, from)
    if (at === -1) return count
    count += 1
    from = at + needle.length
  }
}

export function isPatched(text) {
  return text.includes(PATCH_MARKER)
}

/**
 * Produce the patched bundle. Every anchor must occur exactly once; anchors that do not match mean the
 * target comes from another DSH release, so nothing is written and the caller sees which anchor failed.
 * @param {string} text original bundle text
 * @param {string} snippet module text inserted before the AccountSection region
 */
export function buildPatchedText(text, snippet) {
  let next = text
  for (const patch of textPatches(snippet)) {
    const hits = countOccurrences(next, patch.find)
    if (hits !== 1) {
      throw new PatchError(
        `anchor "${patch.name}" matched ${hits} time(s), expected exactly 1. `
        + 'The target bundle is from an unsupported DSH release; nothing was written.',
      )
    }
    const replacement = patch.replace ?? `${snippet}${patch.find}`
    next = next.replace(patch.find, replacement)
  }
  return next
}

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function looseStamp() {
  return new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14)
}

function listLooseBackups() {
  if (!existsSync(BACKUP_DIR)) return []
  return readdirSync(BACKUP_DIR).filter((name) => LOOSE_BACKUP_PATTERN.test(name)).sort()
}

/** Syntax gate on a candidate text: written to a scratch file and checked by `node --check`. */
export function checkSyntax(text) {
  mkdirSync(BACKUP_DIR, { recursive: true })
  const probe = join(BACKUP_DIR, SIMULATED_NAME)
  try {
    writeFileSync(probe, text, 'utf8')
    const result = spawnSync(process.execPath, ['--check', probe], { stdio: 'inherit' })
    if (result.status !== 0) {
      throw new PatchError(`syntax check failed for the patched bundle (node --check exit ${result.status ?? 'null'})`)
    }
  } finally {
    try { rmSync(probe, { force: true }) } catch { /* scratch file cleanup is best effort */ }
  }
}

/**
 * Resolve the target install and validate that it is reachable.
 * @param {string[]} argv
 * @returns {{kind: 'loose'|'asar', version: string|null, path: string, asarPath?: string, relPath?: string, origin: string}}
 */
function resolveTarget(argv) {
  const found = resolveBundle({ argv })
  if (found === null) {
    console.error(missingBundleMessage())
    process.exit(2)
  }
  const path = found.kind === 'asar' ? found.asarPath : found.path
  if (!existsSync(path)) {
    console.error(`Target not found: ${path}\n\n${missingBundleMessage()}`)
    process.exit(2)
  }
  const target = { ...found, version: packageVersionOf(found) }
  if (target.version !== null && !VERIFIED_VERSIONS.includes(target.version)) {
    console.warn(`note: this anchor set was verified against DSH ${VERIFIED_VERSIONS.join(', ')}; target is ${target.version}.`)
  }
  return target
}

function report(target) {
  if (target.kind === 'asar') {
    console.log(`target     : ${target.asarPath}`)
    console.log(`inside     : ${target.relPath}`)
    console.log('layout     : asar archive (patched bundle goes to app.asar.unpacked)')
  } else {
    console.log(`target     : ${target.path}`)
    console.log('layout     : loose app directory')
  }
  if (target.version !== null) console.log(`dsh version: ${target.version}`)
  console.log(`located by : ${target.origin}`)
}

/** Effective bundle text: the loose file, or the asar entry (its unpacked override once patched). */
function readTargetText(target) {
  if (target.kind === 'loose') return { text: readFileSync(target.path, 'utf8') }
  const index = readAsarIndex(target.asarPath)
  const { entry, buffer, source } = readAsarEntry(index, target.relPath)
  return { text: buffer.toString('utf8'), index, source, entry }
}

function backupsFor(target) {
  return target.kind === 'asar' ? listAsarBackups(BACKUP_DIR, target.asarPath) : listLooseBackups()
}

function status(argv) {
  const target = resolveTarget(argv)
  const { text, index, source, entry } = readTargetText(target)
  const snippet = readSnippet()
  const patches = textPatches(snippet)
  report(target)
  if (target.kind === 'asar') {
    console.log(`entry      : ${entry.unpacked === true ? 'unpacked override' : 'packed in archive'} (${source})`)
    console.log(`size       : ${Buffer.byteLength(text, 'utf8')} bytes (effective bundle)`)
    console.log(`archive    : ${index.fileSize} bytes, header ${index.headerSize} bytes, data at ${index.dataStart}`)
  } else {
    console.log(`size       : ${Buffer.byteLength(text, 'utf8')} bytes`)
  }
  console.log(`state      : ${isPatched(text) ? 'patched' : 'unpatched'}`)
  console.log(`anchors    : ${patches.map((patch) => {
    const hits = countOccurrences(text, patch.find)
    // The two anchors that are replaced (not inserted before) disappear once the patch is in place;
    // showing "0" next to them reads like a mismatch, so say what it actually means.
    return `${patch.name}=${hits}${hits === 0 && patch.replace ? '(replaced)' : ''}`
  }).join(' ')}`)
  const backups = backupsFor(target)
  console.log(`backups    : ${backups.length > 0 ? backups.join(', ') : '(none)'}`)
  return 0
}

function verify(argv) {
  const target = resolveTarget(argv)
  const { text, index } = readTargetText(target)
  report(target)
  if (isPatched(text)) {
    console.log('already patched: skipping candidate build (revert first to re-verify anchors).')
    return 0
  }
  const snippet = readSnippet()
  const next = buildPatchedText(text, snippet)
  console.log(`anchors    : all ${textPatches(snippet).length} matched exactly once`)
  checkSyntax(next)
  console.log(`syntax     : ok (${Buffer.byteLength(next, 'utf8')} bytes); safe to apply`)
  if (target.kind === 'asar' && index !== undefined) {
    const plan = planAsarOverride(index, target.relPath, Buffer.from(next, 'utf8'))
    if (plan.fits) {
      console.log(`asar write : fits the header slot (${plan.pinned.slack} bytes slack) — in-place header rewrite, data region untouched`)
    } else {
      console.log('asar write : header outgrew its slot — apply will rewrite the whole archive (fully quit DSH first)')
    }
  }
  return 0
}

function apply(argv) {
  const target = resolveTarget(argv)
  const { text } = readTargetText(target)
  report(target)
  if (isPatched(text)) {
    console.log('already patched: nothing to do (run revert first to re-apply from a clean bundle).')
    return 0
  }
  const next = buildPatchedText(text, readSnippet())
  checkSyntax(next)
  if (target.kind === 'asar') {
    const result = applyAsarBundle({
      asarPath: target.asarPath,
      relPath: target.relPath,
      content: next,
      backupDir: BACKUP_DIR,
    })
    console.log(`write      : ${result.mode === 'header' ? 'header rewrite in place (data region untouched)' : 'full archive rewrite'}`)
    console.log(`backup     : ${result.backup}`)
    console.log(`override   : ${result.unpackedPath}`)
    console.log(`sha256     : ${sha256(text)} -> ${sha256(next)}`)
    console.log('')
    console.log('Applied. Fully quit and relaunch DSH (the client bundle is snapshotted at host start),')
    console.log('then open Settings → Account. A plain page refresh does NOT pick up the change.')
    console.log('Rollback with: node src/patch.mjs revert --resources "<install>/resources"')
    return 0
  }
  mkdirSync(BACKUP_DIR, { recursive: true })
  const backup = join(BACKUP_DIR, `client.js.${looseStamp()}.bak`)
  copyFileSync(target.path, backup)
  writeFileSync(target.path, next, 'utf8')
  console.log(`backup     : ${backup}`)
  console.log(`sha256     : ${sha256(text)} -> ${sha256(next)}`)
  console.log('')
  console.log('Applied. Fully quit and relaunch DSH (the client bundle is snapshotted at host start),')
  console.log('then open Settings → Account. A plain page refresh does NOT pick up the change.')
  return 0
}

function revert(argv) {
  const target = resolveTarget(argv)
  report(target)
  if (target.kind === 'asar') {
    const result = revertAsarBundle({ asarPath: target.asarPath, backupDir: BACKUP_DIR })
    console.log(`restored   : ${result.backup} (${result.mode === 'header' ? 'header block' : 'full archive'})`)
    if (result.removedOverride) console.log(`override   : ${result.unpackedPath} (removed)`)
    console.log('Relaunch DSH for the revert to take effect.')
    return 0
  }
  const backups = listLooseBackups()
  if (backups.length === 0) throw new PatchError(`no backups found in ${BACKUP_DIR}`)
  const latest = join(BACKUP_DIR, backups[backups.length - 1])
  copyFileSync(latest, target.path)
  console.log(`restored   : ${latest}`)
  console.log('Relaunch DSH for the revert to take effect.')
  return 0
}

function help() {
  console.log(`dsh-weekstrip - patch engine

usage: node src/patch.mjs <command> [--resources <resources dir>] [--asar <app.asar>] [--bundle <client.js>]

commands
  status    show target bundle, layout, patched state, anchor hits and backups
  verify    anchor + syntax check, writes nothing
  apply     back up the bundle, then insert the usage panel (idempotent)
  revert    restore the most recent backup
  help      this text

environment
  DSH_ACCOUNT_BUNDLE   explicit path to .../dsh-client-ui-settings-account/lib/client.js
  DSH_ASAR             explicit path to .../resources/app.asar (asar layout)
  DSH_RESOURCES_ROOT   Electron "resources" directory of the DSH install

layouts
  loose        <resources>/app/node_modules/.../lib/client.js is edited in place
  asar         <resources>/app.asar (DSH NEXT / official 0.2.1-rc.5+ client): the patched bundle
               becomes an app.asar.unpacked override; the entry is found by path suffix

After apply/revert, fully quit and relaunch DSH.`)
  return 0
}

const COMMANDS = { status, verify, apply, revert, help }
/** Flags that consume the following argv item, so that item is not mistaken for a command word. */
const VALUE_FLAGS = new Set(['--bundle', '--resources', '--asar'])

/** Positional words only: flags and their values are skipped (`--bundle <path> apply` → `apply`). */
function positionalArgs(argv) {
  const words = []
  for (let index = 0; index < argv.length; index++) {
    const item = argv[index]
    if (VALUE_FLAGS.has(item)) {
      index += 1
      continue
    }
    if (item.startsWith('-')) continue
    words.push(item)
  }
  return words
}

export function main(argv = process.argv.slice(2)) {
  const command = positionalArgs(argv)[0] ?? 'status'
  if (!Object.hasOwn(COMMANDS, command)) {
    console.error(`unknown command "${command}"`)
    help()
    return 2
  }
  try {
    return COMMANDS[command](argv)
  } catch (error) {
    if (error instanceof PatchError) {
      console.error(`error: ${error.message}`)
      return 1
    }
    throw error
  }
}

const invokedDirectly = process.argv[1] !== undefined
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedDirectly) {
  process.exitCode = main()
}
