/**
 * asar-packaged installs: DSH NEXT ships its client UI inside `<resources>/app.asar` instead of an
 * unpacked `<resources>/app/` tree, so the loose-file patch cannot edit the bundle in place.
 *
 * Instead of unpacking and repacking the whole 190 MB archive, this module uses Electron's own
 * "unpacked" mechanism: an entry flagged `unpacked: true` in the archive header is read from
 * `<resources>/app.asar.unpacked/<path>` at runtime (that is how native modules are shipped). We
 * therefore
 *   1. write the patched bundle to the corresponding `app.asar.unpacked` path, and
 *   2. rewrite only the header: flag the entry `unpacked`, refresh its `size`, and drop its stale
 *      `integrity` block.
 *
 * The archive's data region is never moved, which keeps the write to ~5 MB instead of ~190 MB and
 * lets `revert` restore the original archive byte-for-byte from a small header backup.
 *
 * asar framing (as written by @electron/asar and read by Electron):
 *   [UInt32 4][UInt32 headerSize]                        pickle holding the header size
 *   [UInt32 payloadSize][UInt32 stringLength][JSON][pad] header pickle, `headerSize` bytes long
 *   file data, addressed by header entries `offset` (relative to the data region) and `size`
 *   dataStart = 8 + headerSize
 */

import { createHash } from 'node:crypto'
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { PatchError } from './errors.mjs'

/** Electron `resources` directory member that holds the packaged app. */
export const ASAR_NAME = 'app.asar'

/** Suffix of the directory Electron reads `unpacked: true` entries from. */
export const UNPACKED_SUFFIX = '.unpacked'

/**
 * Archive-relative path of the account-settings client bundle in the classic asar layout (the archive
 * root holds `node_modules`, `package.json`, ...). Newer builds nest the whole runtime under a `dsh/`
 * directory, so this constant is only a fallback — {@link resolveAccountEntries} finds the entry
 * wherever it lives.
 */
export const ACCOUNT_BUNDLE_IN_ASAR = 'node_modules/@deepseek-ai/dsh-client-ui-settings-account/lib/client.js'

/** Archive-relative path of the patched package's manifest (version lookup); fallback, see above. */
export const ACCOUNT_PACKAGE_IN_ASAR = 'node_modules/@deepseek-ai/dsh-client-ui-settings-account/package.json'

/** Path suffix that identifies the client bundle, independent of the archive's directory layout. */
export const ACCOUNT_BUNDLE_SUFFIX = ACCOUNT_BUNDLE_IN_ASAR

/** Path suffix that identifies the patched package's manifest. */
export const ACCOUNT_PACKAGE_SUFFIX = ACCOUNT_PACKAGE_IN_ASAR

/** Block size used by the asar integrity manifest (Electron's default). */
const INTEGRITY_BLOCK_SIZE = 4 * 1024 * 1024

/** Fixed framing before the header JSON: 8 bytes of outer pickle + 8 bytes of header pickle. */
const FRAMING_BYTES = 16

/** Copy buffer for whole-archive fallbacks. */
const COPY_CHUNK = 4 * 1024 * 1024

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

/** True when some path segment is an `app.asar` (i.e. the path itself is the archive). */
export function isAsarArchivePath(target) {
  return typeof target === 'string' && /(^|[\\/])app\.asar[\\/]?$/i.test(target)
}

/**
 * Split a path like `.../resources/app.asar/node_modules/x/lib/client.js` into the archive path and
 * the archive-relative entry path. Returns null when the path is not inside an `app.asar`. When the
 * path *is* the archive, `relPath` is `''`: the caller still has to find the account entry inside it
 * (the archive's inner directory prefix differs between builds).
 * @param {string} target
 * @param {string} [fallbackEntry] entry used when the path is the archive itself; defaults to `''`
 * @returns {{ asarPath: string, relPath: string } | null}
 */
export function splitAsarPath(target, fallbackEntry = '') {
  if (typeof target !== 'string') return null
  const match = /^(.*?[\\/]app\.asar)(?:[\\/](.*))?$/i.exec(target.trim())
  if (match === null) return null
  const relPath = match[2] === undefined || match[2] === '' ? fallbackEntry : match[2].replace(/[\\/]+/g, '/')
  return { asarPath: match[1], relPath }
}

/** Read exactly `length` bytes at `position`; throws when the file is shorter. */
function readExactly(fd, length, position) {
  const buffer = Buffer.alloc(length)
  if (length === 0) return buffer
  let done = 0
  while (done < length) {
    const got = readSync(fd, buffer, done, length - done, position + done)
    if (got <= 0) throw new PatchError('unexpected end of file while reading the asar archive')
    done += got
  }
  return buffer
}

/**
 * Read and validate the archive index (8-byte pickle prefix + header pickle + JSON header).
 * Never writes; throws {@link PatchError} when the file is not a readable asar archive.
 * @param {string} asarPath
 */
export function readAsarIndex(asarPath) {
  if (!existsSync(asarPath)) throw new PatchError(`asar archive not found: ${asarPath}`)
  let fd
  try {
    fd = openSync(asarPath, 'r')
  } catch (error) {
    throw new PatchError(`cannot open asar archive: ${asarPath} (${error.code ?? error.message})`)
  }
  try {
    const fileSize = statSync(asarPath).size
    const prefix = readExactly(fd, 8, 0)
    if (prefix.readUInt32LE(0) !== 4) {
      throw new PatchError(`not an asar archive (unexpected prefix): ${asarPath}`)
    }
    const headerSize = prefix.readUInt32LE(4)
    if (headerSize < FRAMING_BYTES || 8 + headerSize > fileSize) {
      throw new PatchError(`not an asar archive (bad header size ${headerSize}): ${asarPath}`)
    }
    const headerBuf = readExactly(fd, headerSize, 8)
    const payloadSize = headerBuf.readUInt32LE(0)
    const stringLength = headerBuf.readUInt32LE(4)
    const paddedStringLength = payloadSize - 4
    if (paddedStringLength < stringLength || paddedStringLength % 4 !== 0 || 8 + paddedStringLength > headerSize) {
      throw new PatchError(`malformed asar header framing: ${asarPath}`)
    }
    const headerString = headerBuf.subarray(8, 8 + stringLength).toString('utf8')
    // The pickle pads the JSON to a 4-byte boundary. @electron/asar writes NUL bytes; older versions
    // of this patch wrote spaces. Accept both, reject anything else so a corrupted header is caught
    // here instead of surfacing as a confusing JSON error later.
    for (let at = 8 + stringLength; at < 8 + paddedStringLength; at++) {
      if (headerBuf[at] !== 0x00 && headerBuf[at] !== 0x20) {
        throw new PatchError(`malformed asar header padding at byte ${at}: ${asarPath}`)
      }
    }
    let header
    try {
      header = JSON.parse(headerString)
    } catch (error) {
      throw new PatchError(`malformed asar header JSON: ${error.message}`)
    }
    return {
      asarPath,
      header,
      headerString,
      headerSize,
      payloadSize,
      stringLength,
      paddedStringLength,
      /** Where file data starts; entry `offset` values are relative to this. */
      dataStart: 8 + headerSize,
      fileSize,
    }
  } finally {
    closeSync(fd)
  }
}

/**
 * Walk the header tree for one archive-relative path (forward slashes, no leading slash).
 * @param {object} header parsed asar header
 * @param {string} relPath
 * @returns {object | null} the entry (`{ files }` for directories), or null
 */
export function findAsarEntry(header, relPath) {
  const parts = String(relPath).split('/').filter((part) => part !== '')
  let cursor = header
  for (const part of parts) {
    if (cursor === null || typeof cursor !== 'object' || cursor.files === undefined) return null
    cursor = cursor.files[part]
    if (cursor === undefined) return null
  }
  return cursor
}

/**
 * Walk the header tree and return every file entry whose path is `suffix` or ends with `/<suffix>`,
 * shallowest first. Lets the patch follow layout moves (e.g. the runtime nested under `dsh/` in newer
 * builds) without hard-coding the directory prefix. Directories whose *name* happens to end with the
 * suffix are not matched.
 * @param {object} header parsed asar header
 * @param {string} suffix forward-slash path suffix
 * @returns {string[]}
 */
export function findEntryPathsBySuffix(header, suffix) {
  const wanted = String(suffix).replace(/^\/+/, '')
  const matches = []
  const stack = [['', header]]
  while (stack.length > 0) {
    const [prefix, node] = stack.pop()
    if (node === null || typeof node !== 'object' || node.files === undefined) continue
    for (const [name, child] of Object.entries(node.files)) {
      const path = prefix === '' ? name : `${prefix}/${name}`
      if (child !== null && typeof child === 'object' && child.files !== undefined) {
        stack.push([path, child])
        continue
      }
      if (path === wanted || path.endsWith(`/${wanted}`)) matches.push(path)
    }
  }
  return matches.sort((left, right) => left.length - right.length || left.localeCompare(right))
}

/**
 * First matching file entry path; kept for callers that only need one candidate.
 * @param {object} header parsed asar header
 * @param {string} suffix forward-slash path suffix
 * @returns {string | null}
 */
export function findEntryPathBySuffix(header, suffix) {
  return findEntryPathsBySuffix(header, suffix)[0] ?? null
}

/**
 * Locate the patched package inside an archive: the client bundle plus its manifest, wherever the
 * build puts them (archive root, or nested under `dsh/`, ...).
 *
 * More than one copy is ambiguous — the patch edits exactly one bundle, and guessing could edit a
 * copy the host never loads — so that case throws and asks for an explicit `--bundle` path.
 * @param {object} header parsed asar header
 * @returns {{ bundleRelPath: string, packageRelPath: string | null } | null}
 */
export function resolveAccountEntries(header) {
  const bundles = findEntryPathsBySuffix(header, ACCOUNT_BUNDLE_SUFFIX)
  if (bundles.length === 0) return null
  if (bundles.length > 1) {
    throw new PatchError(
      `found ${bundles.length} copies of the account-settings bundle inside the archive; nothing was written.\n`
      + `Pass --bundle "<install>/resources/app.asar/<path>" with the copy the app actually loads:\n  ${bundles.join('\n  ')}`,
    )
  }
  const bundleRelPath = bundles[0]
  const derivedPackage = `${bundleRelPath.slice(0, -'/lib/client.js'.length)}/package.json`
  const packageRelPath = findAsarEntry(header, derivedPackage) !== null
    ? derivedPackage
    : findEntryPathBySuffix(header, ACCOUNT_PACKAGE_SUFFIX)
  return { bundleRelPath, packageRelPath }
}

/** Filesystem path of the unpacked override for an entry inside `asarPath`. */
export function unpackedPathOf(asarPath, relPath) {
  return join(`${asarPath}${UNPACKED_SUFFIX}`, ...String(relPath).split('/').filter((part) => part !== ''))
}

/**
 * Read one entry's effective bytes: the unpacked override when the header says `unpacked`, else the
 * bytes stored in the archive. Used for both `status` and the `apply` input, so applying twice is safe.
 * @param {ReturnType<typeof readAsarIndex>} index
 * @param {string} relPath
 * @returns {{ entry: object, buffer: Buffer, source: 'packed' | 'unpacked' }}
 */
export function readAsarEntry(index, relPath) {
  const entry = findAsarEntry(index.header, relPath)
  if (entry === null || entry.files !== undefined) {
    throw new PatchError(`bundle not found inside ${basename(index.asarPath)}: ${relPath}`)
  }
  if (entry.unpacked === true) {
    const unpackedPath = unpackedPathOf(index.asarPath, relPath)
    if (!existsSync(unpackedPath)) {
      throw new PatchError(
        `the archive marks this bundle as unpacked but the override file is missing:\n  ${unpackedPath}\n`
        + 'run `revert` (or reinstall DSH) to get back to a clean archive, then apply again.',
      )
    }
    return { entry, buffer: readFileSync(unpackedPath), source: 'unpacked' }
  }
  const size = Number(entry.size)
  const offset = Number(entry.offset)
  if (!Number.isInteger(size) || !Number.isInteger(offset) || size < 0 || offset < 0) {
    throw new PatchError(`unsupported asar entry descriptor for ${relPath} (offset/size missing)`)
  }
  if (index.dataStart + offset + size > index.fileSize) {
    throw new PatchError(`asar entry ${relPath} points beyond the end of the archive`)
  }
  const fd = openSync(index.asarPath, 'r')
  try {
    return { entry, buffer: readExactly(fd, size, index.dataStart + offset), source: 'packed' }
  } finally {
    closeSync(fd)
  }
}

/**
 * Recompute an asar integrity block for `buffer`, mirroring the archive's own convention:
 * SHA-256 over the whole file plus SHA-256 over each fixed-size block (the last block is hashed
 * as-is, not zero-padded). Not used by `apply` — that *drops* the stale integrity block instead of
 * recomputing it (Electron reads unpacked entries from disk) — but kept for the tests that build
 * synthetic archives shaped like real ones.
 * @param {Buffer} buffer
 * @param {{algorithm?: string, blockSize?: number}} [template] existing block to copy the shape from
 */
export function integrityFor(buffer, template = {}) {
  const algorithm = template.algorithm ?? 'SHA256'
  const blockSize = Number(template.blockSize ?? INTEGRITY_BLOCK_SIZE)
  if (algorithm !== 'SHA256') throw new PatchError(`unsupported asar integrity algorithm: ${algorithm}`)
  if (!Number.isInteger(blockSize) || blockSize <= 0) throw new PatchError(`unsupported asar integrity block size: ${blockSize}`)
  const blocks = []
  for (let at = 0; at < buffer.length; at += blockSize) {
    blocks.push(sha256(buffer.subarray(at, Math.min(at + blockSize, buffer.length))))
  }
  return { algorithm, hash: sha256(buffer), blockSize, blocks }
}

/**
 * Encode a header object back into the archive's framing.
 *
 * `options.headerSize` pins the output to an exact pickle length so the archive's data region does
 * not move; the JSON is padded with spaces (valid trailing whitespace for JSON.parse) when the new
 * header is shorter. When the new header does not fit, `block` is null and the caller must grow the
 * archive instead.
 * @param {object} header
 * @param {{ headerSize?: number }} [options]
 * @returns {{ block: Buffer | null, headerSize: number, requiredHeaderSize: number, slack: number }}
 */
export function encodeHeaderBlock(header, options = {}) {
  const json = JSON.stringify(header)
  const stringLength = Buffer.byteLength(json, 'utf8')
  const paddedStringLength = Math.ceil(stringLength / 4) * 4
  const requiredHeaderSize = 8 + paddedStringLength
  const targetHeaderSize = options.headerSize
  if (targetHeaderSize !== undefined) {
    const room = targetHeaderSize - 8
    if (room < stringLength || room % 4 !== 0) {
      return { block: null, headerSize: targetHeaderSize, requiredHeaderSize, slack: room - stringLength }
    }
    return { block: encodePickle(json, stringLength, room), headerSize: targetHeaderSize, requiredHeaderSize, slack: room - stringLength }
  }
  return {
    block: encodePickle(json, stringLength, paddedStringLength),
    headerSize: requiredHeaderSize,
    requiredHeaderSize,
    slack: 0,
  }
}

/**
 * Encode the header pickle the way @electron/asar does: `[u32 payloadSize][u32 rawJsonLength][json]
 * [NUL padding]`, wrapped in the outer `[u32 4][u32 pickleLength]` frame. `payloadSize` counts the
 * length field plus the padded JSON; `stringLength` is the *raw* UTF-8 JSON length (not the padded
 * one), and padding is NUL — matching every real archive inspected (Electron, VS Code, ...).
 */
function encodePickle(json, stringLength, paddedStringLength) {
  const payloadSize = 4 + paddedStringLength
  const pickle = Buffer.alloc(4 + payloadSize)
  pickle.writeUInt32LE(payloadSize, 0)
  pickle.writeUInt32LE(stringLength, 4)
  Buffer.from(json, 'utf8').copy(pickle, 8)
  pickle.fill(0x00, 8 + stringLength, 8 + paddedStringLength)
  const block = Buffer.alloc(8 + pickle.length)
  block.writeUInt32LE(4, 0)
  block.writeUInt32LE(pickle.length, 4)
  pickle.copy(block, 8)
  return block
}

/**
 * Work out the header rewrite for one entry without touching the filesystem: flag it `unpacked`,
 * refresh its `size`, drop the stale `integrity`, then check whether the new header still fits the
 * archive's original pickle slot (that decides between an in-place header write and a full rewrite).
 * @param {ReturnType<typeof readAsarIndex>} index
 * @param {string} relPath
 * @param {Buffer} payload patched bundle bytes
 * @returns {{ nextHeader: object, pinned: ReturnType<typeof encodeHeaderBlock>, fits: boolean }}
 */
export function planAsarOverride(index, relPath, payload) {
  const nextHeader = JSON.parse(JSON.stringify(index.header))
  const nextEntry = findAsarEntry(nextHeader, relPath)
  if (nextEntry === null || nextEntry.files !== undefined) {
    throw new PatchError(`bundle not found inside ${basename(index.asarPath)}: ${relPath}`)
  }
  if (nextEntry.unpacked === true) {
    throw new PatchError(`entry is already unpacked in ${basename(index.asarPath)}; run revert first to re-apply from a clean archive.`)
  }
  nextEntry.unpacked = true
  nextEntry.size = payload.length
  // The packed bytes stay where they are, so their integrity manifest no longer describes the
  // effective file; the entry is unpacked now and Electron reads it from disk instead.
  delete nextEntry.integrity
  const pinned = encodeHeaderBlock(nextHeader, { headerSize: index.headerSize })
  return { nextHeader, pinned, fits: pinned.block !== null && pinned.headerSize === index.headerSize }
}

/**
 * Filesystem-safe timestamp shared by the asar backups of one run: `yyyyMMddHHmmssSSS`. Milliseconds
 * matter because a machine can hold more than one install, and two applies in the same second must not
 * overwrite each other's `.json` meta.
 */
export function stampOf(date = new Date()) {
  return date.toISOString().replace(/[^0-9]/g, '').slice(0, 17)
}

/** Base name (no extension) for this run's asar backups: `app.asar.<stamp>`. */
export function backupName(stamp) {
  return `${ASAR_NAME}.${stamp}`
}

function readNames(dir) {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

/**
 * Allocate a backup stamp that is not taken yet. Milliseconds already make collisions unlikely; this
 * guard makes them impossible, so two installs patched back-to-back can never overwrite each other's
 * meta (which would make the first one impossible to revert).
 */
function uniqueStamp(backupDir, date = new Date()) {
  for (let bump = 0; bump < 1000; bump++) {
    const stamp = stampOf(new Date(date.getTime() + bump))
    const taken = ['.json', '.hdr', '.bak'].some((ext) => existsSync(join(backupDir, `${ASAR_NAME}.${stamp}${ext}`)))
    if (!taken) return stamp
  }
  throw new PatchError(`could not allocate a unique backup name in ${backupDir}`)
}

/**
 * Write the patched bundle as an unpacked override and flag it in the archive header.
 *
 * Two write strategies, in order of preference:
 *   - `header` — the new header fits the original pickle length, so only the first ~5 MB of the
 *     archive are rewritten and the data region never moves.
 *   - `full` — the header outgrew its slot: build a new archive image and replace the file, with the
 *     whole original archive kept as the backup (needs DSH fully quit on Windows).
 *
 * Ordering is deliberate: the override is written first (the header may point at it), then the
 * backup, then the meta — the meta is a *revert receipt* and must exist before the archive is
 * touched. A failure after the archive was modified keeps the override and tells the user to
 * `revert`, instead of leaving a header that points at a file we just deleted.
 *
 * @param {object} params
 * @param {string} params.asarPath
 * @param {string} params.relPath archive-relative path of the bundle
 * @param {string} params.content patched bundle text (UTF-8)
 * @param {string} params.backupDir directory that receives the backup
 * @returns {{ mode: 'header' | 'full', stamp: string, backup: string, meta: string, unpackedPath: string }}
 */
export function applyAsarBundle({ asarPath, relPath, content, backupDir }) {
  const index = readAsarIndex(asarPath)
  const entry = findAsarEntry(index.header, relPath)
  if (entry === null || entry.files !== undefined) {
    throw new PatchError(`bundle not found inside ${basename(asarPath)}: ${relPath}`)
  }
  if (entry.unpacked === true) {
    throw new PatchError(`entry is already unpacked in ${basename(asarPath)}; run revert first to re-apply from a clean archive.`)
  }

  const payload = Buffer.from(content, 'utf8')
  const plan = planAsarOverride(index, relPath, payload)

  mkdirSync(backupDir, { recursive: true })
  const stamp = uniqueStamp(backupDir)
  const name = backupName(stamp)
  const metaPath = join(backupDir, `${name}.json`)
  const unpackedPath = unpackedPathOf(asarPath, relPath)
  const unpackedExisted = existsSync(unpackedPath)

  // The override file must exist before the header starts pointing at it.
  try {
    mkdirSync(dirname(unpackedPath), { recursive: true })
    writeFileSync(unpackedPath, payload)
  } catch (error) {
    throw new PatchError(
      `cannot write the unpacked override (${error.code ?? error.message}):\n  ${unpackedPath}\n`
      + 'Fully quit DSH and run apply again.',
    )
  }

  const meta = {
    kind: 'dsh-weekstrip-asar-backup',
    createdAt: new Date().toISOString(),
    mode: plan.fits ? 'header' : 'full',
    asarPath,
    asarSize: index.fileSize,
    patchedAsarSize: null,
    headerSize: index.headerSize,
    dataStart: index.dataStart,
    relPath,
    unpackedPath,
    unpackedCreated: !unpackedExisted,
    stamp,
  }
  let archiveTouched = false

  try {
    if (plan.fits) {
      // Header-only rewrite: back up the original header block, record the receipt, then overwrite.
      const headerBackup = join(backupDir, `${name}.hdr`)
      const fd = openSync(asarPath, 'r')
      try {
        writeFileSync(headerBackup, readExactly(fd, index.dataStart, 0))
      } finally {
        closeSync(fd)
      }
      meta.patchedAsarSize = index.fileSize
      writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`)
      archiveTouched = true
      writeAsarHeader(asarPath, plan.pinned.block, index.fileSize)
      return { mode: 'header', stamp, backup: headerBackup, meta: metaPath, unpackedPath }
    }

    // Grow the archive: new header (natural size) followed by the untouched data region.
    const grown = encodeHeaderBlock(plan.nextHeader)
    const tempPath = join(dirname(asarPath), `${basename(asarPath)}.weekstrip-tmp`)
    rmSync(tempPath, { force: true })
    writeAsarImage({ source: asarPath, dataStart: index.dataStart, fileSize: index.fileSize, headerBlock: grown.block, target: tempPath })
    const fullBackup = join(backupDir, `${name}.bak`)
    copyFileSync(asarPath, fullBackup)
    meta.patchedAsarSize = grown.block.length + (index.fileSize - index.dataStart)
    writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`)
    try {
      archiveTouched = true
      renameSync(tempPath, asarPath)
    } catch (error) {
      rmSync(tempPath, { force: true })
      archiveTouched = false
      throw new PatchError(
        `could not replace ${basename(asarPath)} (${error.code ?? error.message}).\n`
        + 'Fully quit DSH and run apply again — Windows keeps the archive open while DSH is running.',
      )
    }
    return { mode: 'full', stamp, backup: fullBackup, meta: metaPath, unpackedPath }
  } catch (error) {
    if (archiveTouched) {
      // The archive may already point at the override: keep it, and point the user at the receipt.
      throw new PatchError(
        `${error.message}\n\nThe archive was modified before this failed. Run 'node src/patch.mjs revert --resources "<install>/resources"'`
        + ` or restore it from ${join(backupDir, name)}.`,
      )
    }
    if (!unpackedExisted) rmSync(unpackedPath, { force: true })
    rmSync(metaPath, { force: true })
    throw error
  }
}

/** Overwrite the archive header block in place; the file length must not change. */
function writeAsarHeader(asarPath, block, expectedFileSize) {
  const size = statSync(asarPath).size
  if (size !== expectedFileSize) {
    throw new PatchError(`${basename(asarPath)} changed while patching (size ${size} != ${expectedFileSize}); nothing was written`)
  }
  let fd
  try {
    fd = openSync(asarPath, 'r+')
  } catch (error) {
    throw new PatchError(
      `cannot open ${basename(asarPath)} for writing (${error.code ?? error.message}).\n`
      + 'Fully quit DSH and retry — Windows keeps the archive open while DSH is running.',
    )
  }
  try {
    if (writeSync(fd, block, 0, block.length, 0) !== block.length) {
      throw new PatchError(`short write on ${basename(asarPath)} header`)
    }
  } finally {
    closeSync(fd)
  }
}

/** Build a new archive image: `headerBlock` followed by the source archive's data region. */
function writeAsarImage({ source, dataStart, fileSize, headerBlock, target }) {
  const headerBytes = headerBlock.length
  const dataLength = fileSize - dataStart
  const fd = openSync(source, 'r')
  let out
  try {
    out = openSync(target, 'w')
    if (writeSync(out, headerBlock, 0, headerBytes, 0) !== headerBytes) throw new PatchError('short write on archive header')
    const chunk = Buffer.alloc(COPY_CHUNK)
    let copied = 0
    while (copied < dataLength) {
      const want = Math.min(chunk.length, dataLength - copied)
      const got = readSync(fd, chunk, 0, want, dataStart + copied)
      if (got <= 0) throw new PatchError('unexpected end of asar data region while copying')
      if (writeSync(out, chunk, 0, got, headerBytes + copied) !== got) throw new PatchError('short write on asar data region')
      copied += got
    }
  } finally {
    if (out !== undefined) closeSync(out)
    closeSync(fd)
  }
}

/**
 * Backup stamps recorded in `backupDir`, oldest first (a `.json` meta file marks a complete backup).
 * When `asarPath` is given, only backups made for that archive are returned — a machine can hold
 * several installs (e.g. DSH NEXT and the official client), and their backups must not be mixed up.
 * @param {string} backupDir
 * @param {string} [asarPath]
 */
export function listAsarBackups(backupDir, asarPath) {
  const wanted = typeof asarPath === 'string' ? normalize(asarPath) : null
  const stamps = []
  for (const name of readNames(backupDir)) {
    const match = /^app\.asar\.(\d{14,17})\.json$/.exec(name)
    if (match === null) continue
    if (wanted !== null) {
      try {
        const meta = JSON.parse(readFileSync(join(backupDir, name), 'utf8'))
        if (normalize(meta.asarPath) !== wanted) continue
      } catch {
        continue
      }
    }
    stamps.push(match[1])
  }
  return stamps.sort()
}

/**
 * Restore the newest archive backup recorded in `backupDir` and delete the unpacked override.
 *
 * The archive is validated against the receipt first: if the file changed size since the patch (an
 * app update replaced it, or someone tampered with it), restoring an old header would corrupt the
 * new install, so that case is refused instead of written.
 * @param {{ asarPath: string, backupDir: string }} params
 * @returns {{ mode: 'header' | 'full', backup: string, unpackedPath: string | undefined, removedOverride: boolean }}
 */
export function revertAsarBundle({ asarPath, backupDir }) {
  const stamps = listAsarBackups(backupDir, asarPath)
  let meta = null
  for (let at = stamps.length - 1; at >= 0 && meta === null; at--) {
    const candidate = join(backupDir, `${ASAR_NAME}.${stamps[at]}.json`)
    const parsed = JSON.parse(readFileSync(candidate, 'utf8'))
    if (normalize(parsed.asarPath) === normalize(asarPath)) meta = parsed
  }
  if (meta === null) {
    throw new PatchError(
      `no asar backup for this archive in ${backupDir}\n  archive: ${asarPath}\n`
      + 'Nothing to revert: either the patch was never applied from this checkout, or the app update removed it.',
    )
  }
  const name = backupName(meta.stamp ?? '')
  const currentSize = statSync(asarPath).size
  const expectedPatchedSize = typeof meta.patchedAsarSize === 'number' ? meta.patchedAsarSize : meta.asarSize
  if (typeof expectedPatchedSize === 'number' && expectedPatchedSize !== currentSize) {
    throw new PatchError(
      `${basename(asarPath)} changed since the patch (size ${currentSize} != ${expectedPatchedSize}); refusing to restore a stale header.\n`
      + 'The app was probably updated — reinstall/update DSH and run apply again instead of revert.',
    )
  }
  if (meta.mode === 'header') {
    const headerBackup = join(backupDir, `${name}.hdr`)
    if (!existsSync(headerBackup)) throw new PatchError(`header backup missing: ${headerBackup}`)
    const headerBytes = readFileSync(headerBackup)
    if (headerBytes.length !== meta.dataStart) {
      throw new PatchError(`header backup has unexpected size (${headerBytes.length} != ${meta.dataStart}): ${headerBackup}`)
    }
    writeAsarHeader(asarPath, headerBytes, meta.asarSize)
  } else {
    const fullBackup = join(backupDir, `${name}.bak`)
    if (!existsSync(fullBackup)) throw new PatchError(`archive backup missing: ${fullBackup}`)
    try {
      copyFileSync(fullBackup, asarPath)
    } catch (error) {
      throw new PatchError(
        `could not restore ${basename(asarPath)} (${error.code ?? error.message}).\n`
        + 'Fully quit DSH and run revert again.',
      )
    }
  }
  let removedOverride = false
  if (meta.unpackedCreated === true && typeof meta.unpackedPath === 'string' && existsSync(meta.unpackedPath)) {
    rmSync(meta.unpackedPath, { force: true })
    removedOverride = true
    // Drop the directories we created (lib/ and the package dir) when nothing else lives there.
    for (const dir of [dirname(meta.unpackedPath), dirname(dirname(meta.unpackedPath))]) {
      if (readNames(dir).length === 0) {
        try { rmSync(dir, { recursive: false, force: true }) } catch { /* best effort */ }
      }
    }
  }
  return { mode: meta.mode, backup: join(backupDir, `${name}.${meta.mode === 'full' ? 'bak' : 'hdr'}`), unpackedPath: meta.unpackedPath, removedOverride }
}

function normalize(value) {
  if (typeof value !== 'string') return ''
  try {
    return resolve(value).toLowerCase()
  } catch {
    return value.replace(/[\\/]+/g, sep).toLowerCase()
  }
}
