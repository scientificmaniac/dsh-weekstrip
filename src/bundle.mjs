/**
 * Locate the DSH account-settings client bundle on this machine.
 *
 * Two install layouts are supported:
 *   - `loose`  — DSH Desktop ships `<resources>/app/` unpacked (edit the bundle file in place).
 *   - `asar`   — DSH NEXT ships `<resources>/app.asar` (the bundle lives inside the archive, so the
 *                patch writes an `app.asar.unpacked` override and flags the entry).
 *
 * Resolution order:
 *   1. `--bundle <path>`            explicit client.js path (inside an app.asar is also accepted)
 *   2. `--asar <path>`              explicit app.asar path
 *   3. `--resources <dir>`          Electron `resources` directory (either layout)
 *   4. `DSH_ACCOUNT_BUNDLE`         env: explicit client.js path
 *   5. `DSH_ASAR`                   env: explicit app.asar path
 *   6. `DSH_RESOURCES_ROOT`         env: Electron `resources` directory
 *   7. well-known install locations for DSH Desktop / DSH NEXT on Windows / macOS / Linux
 *
 * Nothing here writes; callers get a descriptor or null and print their own guidance.
 */

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  ACCOUNT_BUNDLE_IN_ASAR,
  ACCOUNT_PACKAGE_IN_ASAR,
  ASAR_NAME,
  findAsarEntry,
  isAsarArchivePath,
  readAsarEntry,
  readAsarIndex,
  resolveAccountEntries,
  splitAsarPath,
} from './asar.mjs'
import { PatchError } from './errors.mjs'

/** Path from an Electron `resources` directory to the loose bundle (DSH Desktop layout). */
export const BUNDLE_SUBPATH = join(
  'app',
  'node_modules',
  '@deepseek-ai',
  'dsh-client-ui-settings-account',
  'lib',
  'client.js',
)


function flagValue(argv, name) {
  for (let index = 0; index < argv.length; index++) {
    const item = argv[index]
    if (item === `--${name}`) return argv[index + 1]
    if (item.startsWith(`--${name}=`)) return item.slice(name.length + 3)
  }
  return undefined
}

/** Candidate Electron `resources` directories, most likely first; missing entries are filtered by the caller. */
export function candidateResourceDirs(platform = process.platform, env = process.env, home = homedir()) {
  const dirs = []
  if (platform === 'win32') {
    for (const root of [env.LOCALAPPDATA, env['PROGRAMFILES'], env['PROGRAMFILES(X86)']]) {
      if (!root) continue
      dirs.push(join(root, 'Programs', 'DSH Desktop', 'resources'))
      dirs.push(join(root, 'Programs', 'DSH NEXT', 'resources'))
      dirs.push(join(root, 'DSH Desktop', 'resources'))
      dirs.push(join(root, 'DSH NEXT', 'resources'))
    }
    if (env.USERPROFILE) {
      dirs.push(join(env.USERPROFILE, 'AppData', 'Local', 'DSH Desktop', 'resources'))
      dirs.push(join(env.USERPROFILE, 'AppData', 'Local', 'DSH NEXT', 'resources'))
    }
  } else if (platform === 'darwin') {
    dirs.push('/Applications/DSH Desktop.app/Contents/Resources')
    dirs.push('/Applications/DSH NEXT.app/Contents/Resources')
    dirs.push(join(home, 'Applications', 'DSH Desktop.app', 'Contents', 'Resources'))
    dirs.push(join(home, 'Applications', 'DSH NEXT.app', 'Contents', 'Resources'))
  } else {
    dirs.push('/opt/DSH Desktop/resources')
    dirs.push('/usr/lib/dsh-desktop/resources')
    dirs.push(join(home, '.local', 'share', 'DSH Desktop', 'resources'))
    dirs.push('/opt/dsh-next/resources')
    dirs.push(join(home, '.local', 'share', 'DSH NEXT', 'resources'))
  }
  return dirs
}

/**
 * Best-effort discovery of the account entries inside an archive. Layouts differ: older builds keep
 * `node_modules` at the archive root, newer ones (0.2.1-rc.5) nest the runtime under `dsh/`. Failure
 * is not fatal — callers fall back to the classic path and the read itself reports the problem.
 * @param {string} asarPath
 * @returns {{ bundleRelPath: string, packageRelPath: string | null } | null}
 */
function accountEntriesOf(asarPath) {
  try {
    return resolveAccountEntries(readAsarIndex(asarPath).header)
  } catch (error) {
    // An ambiguous archive (two copies of the package) is a real answer, not a discovery failure:
    // surface it so the user can pick one with --bundle instead of silently patching a guess.
    if (error instanceof PatchError) throw error
    return null
  }
}

/** `.../lib/client.js` → `.../package.json`, for archives where discovery did not run. */
function derivePackageRelPath(relPath) {
  return typeof relPath === 'string' && relPath.endsWith('/lib/client.js')
    ? `${relPath.slice(0, -'/lib/client.js'.length)}/package.json`
    : null
}

/**
 * Build the asar descriptor. The archive-relative bundle path is resolved in this order: an explicit
 * path (a `--bundle ...app.asar/<path>` hint) if that entry actually exists, then the entry discovered
 * by suffix, then the classic archive-root path. This is what makes `--asar <app.asar>` work on
 * builds that nest the runtime under `dsh/` — the archive path alone carries no entry path.
 */
function asarTarget(asarPath, origin, explicitRelPath) {
  let index = null
  try {
    index = readAsarIndex(asarPath)
  } catch {
    // Let the caller fail later with the real read error (status/verify report it nicely).
  }
  const found = index === null ? null : accountEntriesOf(asarPath)
  const candidates = [explicitRelPath, found?.bundleRelPath, ACCOUNT_BUNDLE_IN_ASAR]
    .filter((value) => typeof value === 'string' && value !== '')
  const relPath = index === null
    ? candidates[0] ?? ACCOUNT_BUNDLE_IN_ASAR
    : candidates.find((candidate) => findAsarEntry(index.header, candidate) !== null) ?? candidates[0] ?? ACCOUNT_BUNDLE_IN_ASAR
  const packageRelPath = derivePackageRelPath(relPath) ?? found?.packageRelPath ?? ACCOUNT_PACKAGE_IN_ASAR
  return { kind: 'asar', path: asarPath, asarPath, relPath, packageRelPath, origin }
}

/** Build the descriptor for one install layout; the loose layout wins when both exist. */
function targetFromResources(resourcesDir, origin) {
  const loose = join(resourcesDir, BUNDLE_SUBPATH)
  if (existsSync(loose)) return { kind: 'loose', path: loose, resourcesDir, origin }
  const asarPath = join(resourcesDir, ASAR_NAME)
  if (existsSync(asarPath)) return { ...asarTarget(asarPath, origin), resourcesDir }
  return null
}

/** Descriptor for an explicit path: an `app.asar` (or a path inside one) becomes an asar target. */
function targetFromExplicitPath(rawPath, origin) {
  const inside = splitAsarPath(rawPath)
  if (inside !== null) return asarTarget(inside.asarPath, origin, inside.relPath)
  if (isAsarArchivePath(rawPath)) return asarTarget(rawPath, origin)
  return { kind: 'loose', path: rawPath, origin }
}

/** Descriptor for an explicit `--asar` argument (file or its `resources` directory). */
function targetFromAsarPath(rawPath, origin) {
  const inside = splitAsarPath(rawPath)
  if (inside !== null) return asarTarget(inside.asarPath, origin, inside.relPath)
  const asarPath = isAsarArchivePath(rawPath) ? rawPath : join(rawPath, ASAR_NAME)
  return asarTarget(asarPath, origin)
}

/**
 * @param {{ argv?: string[], env?: Record<string, string | undefined>, platform?: string }} [options]
 * @returns {null | { kind: 'loose', path: string, origin: string, resourcesDir?: string }
 *   | { kind: 'asar', path: string, asarPath: string, relPath: string, origin: string, resourcesDir?: string }}
 */
export function resolveBundle(options = {}) {
  const argv = options.argv ?? process.argv.slice(2)
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform

  const explicitBundle = flagValue(argv, 'bundle') ?? env.DSH_ACCOUNT_BUNDLE
  if (explicitBundle) return targetFromExplicitPath(explicitBundle, 'explicit bundle path')

  const explicitAsar = flagValue(argv, 'asar') ?? env.DSH_ASAR
  if (explicitAsar) return targetFromAsarPath(explicitAsar, 'explicit asar path')

  const resources = flagValue(argv, 'resources') ?? env.DSH_RESOURCES_ROOT
  if (resources) {
    const found = targetFromResources(resources, 'resources directory')
    if (found !== null) return found
    // Nothing at that location yet: report the loose path the user probably meant.
    return { kind: 'loose', path: join(resources, BUNDLE_SUBPATH), origin: 'resources directory' }
  }

  for (const dir of candidateResourceDirs(platform, env)) {
    const found = targetFromResources(dir, `detected install (${dir})`)
    if (found !== null) return found
  }
  return null
}

/** Read the patched package's version, or null when it cannot be read. */
export function packageVersionOf(target) {
  try {
    if (typeof target === 'string') return readLooseVersion(target)
    if (target === null || typeof target !== 'object') return null
    if (target.kind === 'asar') {
      const index = readAsarIndex(target.asarPath)
      const packageRelPath = target.packageRelPath ?? ACCOUNT_PACKAGE_IN_ASAR
      const entry = findAsarEntry(index.header, packageRelPath)
      if (entry === null || entry.files !== undefined) return null
      const { buffer } = readAsarEntry(index, packageRelPath)
      const json = JSON.parse(buffer.toString('utf8'))
      return typeof json.version === 'string' ? json.version : null
    }
    return readLooseVersion(target.path)
  } catch {
    return null
  }
}

function readLooseVersion(bundlePath) {
  const manifest = join(bundlePath, '..', '..', 'package.json')
  const json = JSON.parse(readFileSync(manifest, 'utf8'))
  return typeof json.version === 'string' ? json.version : null
}

/** Human-readable guidance when no bundle could be located. */
export function missingBundleMessage() {
  return [
    'Could not locate the DSH account-settings client bundle.',
    '',
    'Pass it explicitly (any of these works):',
    '  node src/patch.mjs status --resources "<install>/resources"',
    '  node src/patch.mjs status --asar "<install>/resources/app.asar"',
    '  node src/patch.mjs status --bundle "<install>/resources/app/node_modules/@deepseek-ai/dsh-client-ui-settings-account/lib/client.js"',
    '  $env:DSH_RESOURCES_ROOT="<install>/resources"; node src/patch.mjs status',
    '',
    'DSH Desktop keeps the bundle under: <install>/resources/app/node_modules/...',
    'asar layout (DSH NEXT / official client): <install>/resources/app.asar (--asar or --resources)',
    'On this machine the install root may be a custom folder, e.g. E:\\DSHDesktop.',
  ].join('\n')
}
