#!/usr/bin/env node
/**
 * Engine test: exercise the patch engine against a synthetic bundle that carries the same five anchors,
 * so CI can verify anchor handling, insertion, idempotence and syntax gating without a DSH install.
 */

import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readSnippet, buildPatchedText, checkSyntax, countOccurrences, isPatched, PatchError, main } from '../src/patch.mjs'
import { PATCH_MARKER } from '../src/anchors.mjs'
import { candidateResourceDirs, BUNDLE_SUBPATH, packageVersionOf, resolveBundle } from '../src/bundle.mjs'
import {
  ACCOUNT_BUNDLE_IN_ASAR,
  applyAsarBundle,
  encodeHeaderBlock,
  findAsarEntry,
  findEntryPathBySuffix,
  integrityFor,
  listAsarBackups,
  planAsarOverride,
  readAsarEntry,
  readAsarIndex,
  resolveAccountEntries,
  revertAsarBundle,
  splitAsarPath,
  unpackedPathOf,
} from '../src/asar.mjs'

/** A minimal but syntactically valid bundle carrying every anchor this patch targets. */
const FIXTURE = `window.__ModuleLoader__.load({
	id: "@deepseek-ai/dsh-client-ui-settings-account",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		let react_jsx_runtime = require("react/jsx-runtime");
		let react = require("react");
		const en = {
			quotaTopUp: "Top up",
			bonusNoticeTitle: "Bonus credited"
		};
		const zh = {
			quotaTopUp: "充值",
			bonusNoticeTitle: "赠金已到账"
		};
		//#region lib/types/client/AccountSection.js
		function AccountSection({ t, useAccount, useTheme, start, cancel, openPlatformPage, avatarFailed }) {
			return { kind: "section" };
		}
		//#endregion
		function apply(ctx) {
			const t = (key) => key;
			const operations = { start() {} };
			ctx.slots.inject("settings.section", () => {
				let unregister;
				const update = () => {
					if (true) unregister ??= ctx.slots.register({
						name: "settings.section",
						id: "account",
						order: -10,
						label: () => t("nav"),
						locale: "settings.account",
						inject: () => operations
					}, AccountSection);
				};
				update();
				return () => { unregister?.(); };
			});
		}
		exports.apply = apply;
		exports.inject = ["slots"];
		return module.exports;
	}
});
`

const SECTION_INJECT = `\t\t\t\t\t\tlabel: () => t("nav"),
\t\t\t\t\t\tlocale: "settings.account",
\t\t\t\t\t\tinject: () => operations
\t\t\t\t\t}, AccountSection);`

let failures = 0
function check(name, condition, detail = '') {
  if (condition) console.log(`ok   ${name}`)
  else {
    failures += 1
    console.error(`FAIL ${name}${detail === '' ? '' : `\n     ${detail}`}`)
  }
}
function expectPatchError(name, run, pattern) {
  try {
    run()
    failures += 1
    console.error(`FAIL ${name}: expected a PatchError, nothing thrown`)
  } catch (error) {
    if (!(error instanceof PatchError)) {
      failures += 1
      console.error(`FAIL ${name}: threw ${error?.name ?? typeof error}, expected PatchError`)
    } else if (pattern !== undefined && !pattern.test(error.message)) {
      failures += 1
      console.error(`FAIL ${name}: message did not match ${pattern}\n     ${error.message}`)
    } else {
      console.log(`ok   ${name}`)
    }
  }
}

const snippet = readSnippet()

// 1. clean bundle: not patched, every anchor present once
check('clean fixture is not patched', isPatched(FIXTURE) === false)
for (const [name, anchor] of Object.entries({
  'dictionary-en': '\t\t\tbonusNoticeTitle: "Bonus credited"',
  'dictionary-zh': '\t\t\tbonusNoticeTitle: "赠金已到账"',
  'component-insert': '\t\t//#region lib/types/client/AccountSection.js',
  'component-rename': 'function AccountSection({ t, useAccount, useTheme, start, cancel, openPlatformPage, avatarFailed }) {',
  'section-inject': SECTION_INJECT,
})) {
  check(`anchor ${name} occurs once`, countOccurrences(FIXTURE, anchor) === 1, `count=${countOccurrences(FIXTURE, anchor)}`)
}

// 2. build the patched text
const patched = buildPatchedText(FIXTURE, snippet)
check('patched text carries the marker', patched.includes(PATCH_MARKER))
check('patched text is detected as patched', isPatched(patched) === true)
check('inserted module is present', patched.includes('function AccountUsageStatsSection'))
check('aggregation is present', patched.includes('function accountStatsOf'))
check('original component renamed', patched.includes('function AccountSectionMain({ t, useAccount, useTheme, start, cancel, openPlatformPage, avatarFailed, useSessions, refreshSessions })'))
check('wrapper component added', patched.includes('function AccountSection(props)'))
check('wrapper renders both halves', patched.includes('react.createElement(AccountSectionMain, props)') && patched.includes('react.createElement(AccountUsageStatsSection, props)'))
check('registration injects refreshSessions', patched.includes('refreshSessions: () =>') && patched.includes('ctx.get("sessions")'))
check('english copy added', patched.includes('statsTokenTitle: "Token usage"') && patched.includes('statsEmpty: "No local usage data yet. Usage from your sessions will appear here."'))
check('chinese copy added', patched.includes('statsTokenTitle: "Token 统计"') && patched.includes('statsEmpty: "暂无本地用量数据，会话产生用量后会在此显示。"'))
check('exports untouched', patched.includes('exports.apply = apply;') && patched.includes('exports.inject = ["slots"];'))
check('patched text grew', patched.split('\n').length > FIXTURE.split('\n').length)
check('anchor text survives insertion', patched.includes('\t\t//#region lib/types/client/AccountSection.js'))

// 3. syntax gate accepts it
try {
  checkSyntax(patched)
  console.log('ok   node --check accepts the patched text')
} catch (error) {
  failures += 1
  console.error(`FAIL node --check rejected the patched text: ${error.message}`)
}

// 4. refusal paths
expectPatchError('re-applying a patched bundle is refused', () => buildPatchedText(patched, snippet), /matched 0 time/)
expectPatchError('a missing anchor is refused', () => buildPatchedText(FIXTURE.replace(SECTION_INJECT, SECTION_INJECT.replace('inject: () => operations', 'inject: () => ({})')), snippet), /section-inject/)
expectPatchError('a duplicated anchor is refused', () => buildPatchedText(`${FIXTURE}\n${SECTION_INJECT}\n`, snippet), /matched 2 time/)
expectPatchError('an unrelated bundle is refused', () => buildPatchedText('console.log("not a dsh bundle")\n', snippet), /dictionary-en/)

// 5. install-path detection (pure, platform-parameterized)
const windowsDirs = candidateResourceDirs('win32', { LOCALAPPDATA: 'C:/Users/x/AppData/Local', PROGRAMFILES: 'C:/Program Files' }, 'C:/Users/x')
check('windows candidates include the local install', windowsDirs.some((dir) => dir.replace(/\\/g, '/') === 'C:/Users/x/AppData/Local/Programs/DSH Desktop/resources'))
check('windows candidates include the local DSH NEXT install', windowsDirs.some((dir) => dir.replace(/\\/g, '/') === 'C:/Users/x/AppData/Local/Programs/DSH NEXT/resources'))
check('windows candidates include program files', windowsDirs.some((dir) => dir.replace(/\\/g, '/') === 'C:/Program Files/DSH Desktop/resources'))
check('bundle subpath points at the account package', BUNDLE_SUBPATH.replace(/\\/g, '/') === 'app/node_modules/@deepseek-ai/dsh-client-ui-settings-account/lib/client.js')
const macDirs = candidateResourceDirs('darwin', {}, '/Users/x')
check('macOS candidates include /Applications', macDirs.includes('/Applications/DSH Desktop.app/Contents/Resources'))
const linuxDirs = candidateResourceDirs('linux', {}, '/home/x')
check('linux candidates include /opt', linuxDirs.includes('/opt/DSH Desktop/resources'))

// 6. CLI command parsing (help / unknown / flags before the command word)
function quietly(run) {
  const { log, error } = console
  console.log = () => {}
  console.error = () => {}
  try {
    return run()
  } finally {
    console.log = log
    console.error = error
  }
}
check('help exits 0', quietly(() => main(['help'])) === 0)
check('unknown command exits 2', quietly(() => main(['nope'])) === 2)
check('flags before the command are skipped', quietly(() => main(['--bundle', 'x', 'help'])) === 0)
check('no arguments defaults to status parser path', quietly(() => main(['--resources', 'x', 'unknown'])) === 2)

// 7. asar layout (DSH NEXT): framing, entry reads, unpacked override, revert, growth fallback.
//    Synthetic archives mirror what @electron/asar writes; the real-install probe lives in
//    scripts/load-test.mjs / render-test.mjs (`--resources <dir>`).

/**
 * Build a small asar archive on disk: natural-size header pickle followed by the file data, entries
 * addressed by data-region-relative offsets (string offsets mirror the DSH NEXT build). `rootPrefix`
 * nests every entry one directory deeper, mirroring 0.2.1-rc.5 builds that ship the runtime under `dsh/`.
 */
function buildArchive(dir, { bundle, withIntegrity, offsetAsString, rootPrefix = '' }) {
  const resources = join(dir, 'resources')
  mkdirSync(resources, { recursive: true })
  const asarPath = join(resources, 'app.asar')
  const prefix = rootPrefix === '' ? '' : `${rootPrefix}/`
  const files = [
    { path: `${prefix}${ACCOUNT_BUNDLE_IN_ASAR}`, data: Buffer.from(bundle, 'utf8') },
    {
      path: `${prefix}node_modules/@deepseek-ai/dsh-client-ui-settings-account/package.json`,
      data: Buffer.from('{"name":"@deepseek-ai/dsh-client-ui-settings-account","version":"0.0.0-test"}\n'),
    },
    { path: `${prefix}node_modules/other/index.js`, data: Buffer.from('module.exports = 1;\n') },
  ]
  const header = { files: {} }
  let offset = 0
  for (const file of files) {
    const entry = { size: file.data.length, offset: offsetAsString ? String(offset) : offset }
    if (withIntegrity) entry.integrity = integrityFor(file.data)
    const parts = file.path.split('/')
    const parent = parts.slice(0, -1).reduce((node, part) => {
      node.files[part] ??= { files: {} }
      return node.files[part]
    }, header)
    parent.files[parts[parts.length - 1]] = entry
    offset += file.data.length
  }
  const block = encodeHeaderBlock(header).block
  writeFileSync(asarPath, Buffer.concat([block, ...files.map((file) => file.data)]))
  return { asarPath, resources }
}

function dataRegionDigest(asarPath) {
  const index = readAsarIndex(asarPath)
  return createHash('sha256').update(readFileSync(asarPath).subarray(index.dataStart)).digest('hex')
}

const tempRoot = mkdtempSync(join(tmpdir(), 'dsh-weekstrip-asar-'))
try {
  const patchedText = buildPatchedText(FIXTURE, snippet)
  const backupDir = join(tempRoot, 'backups')

  // 7a. Archive with integrity manifests (the DSH NEXT shape): the header shrinks, so the data region
  //     must not move and the write happens in place.
  const integrityArchive = buildArchive(join(tempRoot, 'integrity'), { bundle: FIXTURE, withIntegrity: true, offsetAsString: true })
  const index = readAsarIndex(integrityArchive.asarPath)
  check('asar: header parses', index.header?.files !== undefined && index.headerSize > 0)
  check('asar: data region starts right after the header', index.dataStart === index.headerSize + 8)
  check('asar: bundle entry is found', findAsarEntry(index.header, ACCOUNT_BUNDLE_IN_ASAR) !== null)
  check('asar: packed bundle reads back', readAsarEntry(index, ACCOUNT_BUNDLE_IN_ASAR).buffer.toString('utf8') === FIXTURE)
  check('asar: string offsets are accepted', typeof findAsarEntry(index.header, ACCOUNT_BUNDLE_IN_ASAR).offset === 'string')
  check('asar: paths inside an archive are split', splitAsarPath(join(integrityArchive.asarPath, 'node_modules', 'x.js'))?.relPath === 'node_modules/x.js')
  check('asar: the archive path alone carries no entry path', splitAsarPath(integrityArchive.asarPath)?.relPath === '')

  const plan = planAsarOverride(index, ACCOUNT_BUNDLE_IN_ASAR, Buffer.from(patchedText, 'utf8'))
  check('asar: header rewrite fits the original slot', plan.fits === true, `slack=${plan.pinned.slack}`)

  const beforeImage = readFileSync(integrityArchive.asarPath)
  const beforeData = dataRegionDigest(integrityArchive.asarPath)
  const applied = applyAsarBundle({ asarPath: integrityArchive.asarPath, relPath: ACCOUNT_BUNDLE_IN_ASAR, content: patchedText, backupDir })
  check('asar: apply used the in-place header rewrite', applied.mode === 'header')
  check('asar: archive size is unchanged', readFileSync(integrityArchive.asarPath).length === beforeImage.length)
  check('asar: data region is untouched', dataRegionDigest(integrityArchive.asarPath) === beforeData)

  const afterIndex = readAsarIndex(integrityArchive.asarPath)
  const afterEntry = findAsarEntry(afterIndex.header, ACCOUNT_BUNDLE_IN_ASAR)
  check('asar: entry is flagged unpacked', afterEntry.unpacked === true)
  check('asar: stale integrity block is dropped', afterEntry.integrity === undefined)
  check('asar: entry size is refreshed', afterEntry.size === Buffer.byteLength(patchedText, 'utf8'))
  const overridePath = unpackedPathOf(integrityArchive.asarPath, ACCOUNT_BUNDLE_IN_ASAR)
  check('asar: override file is written', existsSync(overridePath))
  const effective = readAsarEntry(afterIndex, ACCOUNT_BUNDLE_IN_ASAR)
  check('asar: effective bundle comes from the override', effective.source === 'unpacked' && isPatched(effective.buffer.toString('utf8')))
  expectPatchError('asar: re-applying an unpacked entry is refused', () => {
    applyAsarBundle({ asarPath: integrityArchive.asarPath, relPath: ACCOUNT_BUNDLE_IN_ASAR, content: patchedText, backupDir })
  }, /already unpacked/)

  const reverted = revertAsarBundle({ asarPath: integrityArchive.asarPath, backupDir })
  check('asar: revert removed the override', reverted.removedOverride === true && !existsSync(overridePath))
  check('asar: revert restored the packed bundle', readAsarEntry(readAsarIndex(integrityArchive.asarPath), ACCOUNT_BUNDLE_IN_ASAR).buffer.toString('utf8') === FIXTURE)
  check('asar: revert makes the archive byte-identical', readFileSync(integrityArchive.asarPath).equals(beforeImage))

  // 7b. Archive without integrity manifests: the header grows past its slot, so apply must fall back to
  //     a full-image rewrite (and revert must restore from the full backup).
  const growArchive = buildArchive(join(tempRoot, 'grow'), { bundle: FIXTURE, withIntegrity: false, offsetAsString: false })
  const growIndex = readAsarIndex(growArchive.asarPath)
  const growPlan = planAsarOverride(growIndex, ACCOUNT_BUNDLE_IN_ASAR, Buffer.from(patchedText, 'utf8'))
  check('asar: header without integrity does not fit', growPlan.fits === false, `required=${growPlan.pinned.requiredHeaderSize}`)
  const growBefore = readFileSync(growArchive.asarPath)
  const growApplied = applyAsarBundle({ asarPath: growArchive.asarPath, relPath: ACCOUNT_BUNDLE_IN_ASAR, content: patchedText, backupDir })
  check('asar: growth fallback reports a full rewrite', growApplied.mode === 'full')
  const grownIndex = readAsarIndex(growArchive.asarPath)
  check('asar: patched entry reads from the override after growth', isPatched(readAsarEntry(grownIndex, ACCOUNT_BUNDLE_IN_ASAR).buffer.toString('utf8')))
  check('asar: untouched entries still read after growth', readAsarEntry(grownIndex, 'node_modules/other/index.js').buffer.toString('utf8') === 'module.exports = 1;\n')
  revertAsarBundle({ asarPath: growArchive.asarPath, backupDir })
  check('asar: growth revert restores the byte-identical archive', readFileSync(growArchive.asarPath).equals(growBefore))
  check('asar: backups are listed per archive', listAsarBackups(backupDir, growArchive.asarPath).length === 1, `grow=${listAsarBackups(backupDir, growArchive.asarPath).length}`)
  check('asar: backups for another archive stay separate', listAsarBackups(backupDir, integrityArchive.asarPath).length === 1, `integrity=${listAsarBackups(backupDir, integrityArchive.asarPath).length} all=${listAsarBackups(backupDir).length}`)

  // 7d. Nested runtime (0.2.1-rc.5 official build ships everything under `dsh/`): the account entries
  //     are discovered by suffix, so `--resources` works without knowing the archive's inner prefix.
  check('asar: suffix lookup handles nested entries', findEntryPathBySuffix({ files: { a: { files: { 'x.js': { size: 1, offset: 0 } } } } }, 'x.js') === 'a/x.js')
  check('asar: suffix lookup returns null when absent', findEntryPathBySuffix({ files: {} }, 'x.js') === null)
  const nestedArchive = buildArchive(join(tempRoot, 'nested'), { bundle: FIXTURE, withIntegrity: true, offsetAsString: false, rootPrefix: 'dsh' })
  const nestedEntries = resolveAccountEntries(readAsarIndex(nestedArchive.asarPath).header)
  check('asar: nested bundle is discovered by suffix', nestedEntries?.bundleRelPath === `dsh/${ACCOUNT_BUNDLE_IN_ASAR}`)
  check('asar: nested manifest is discovered by suffix', nestedEntries?.packageRelPath === 'dsh/node_modules/@deepseek-ai/dsh-client-ui-settings-account/package.json')
  check('asar: empty archive resolves to no entries', resolveAccountEntries({ files: {} }) === null)
  const nestedTarget = resolveBundle({ argv: ['--resources', nestedArchive.resources], env: {}, platform: 'win32' })
  check('asar: --resources finds the nested layout', nestedTarget?.kind === 'asar' && nestedTarget.relPath === `dsh/${ACCOUNT_BUNDLE_IN_ASAR}`)
  check('asar: version lookup follows the discovered manifest', packageVersionOf(nestedTarget) === '0.0.0-test')
  const nestedApplied = applyAsarBundle({ asarPath: nestedArchive.asarPath, relPath: nestedTarget.relPath, content: patchedText, backupDir })
  check('asar: nested layout applies the header rewrite', nestedApplied.mode === 'header')
  check('asar: nested override reads back patched', isPatched(readAsarEntry(readAsarIndex(nestedArchive.asarPath), nestedTarget.relPath).buffer.toString('utf8')))

  // 7e. Entry-path resolution for the nested layout. Passing only the archive path must still find the
  //     bundle under `dsh/`; a hint that does not exist must fall back to discovery, not fail.
  const asarOnly = resolveBundle({ argv: ['--asar', nestedArchive.asarPath], env: {}, platform: 'win32' })
  check('asar: --asar <app.asar> discovers the nested bundle', asarOnly?.relPath === `dsh/${ACCOUNT_BUNDLE_IN_ASAR}`, `relPath=${asarOnly?.relPath}`)
  check('asar: --asar <app.asar> resolves the version', packageVersionOf(asarOnly) === '0.0.0-test')
  const asarEnv = resolveBundle({ argv: [], env: { DSH_ASAR: nestedArchive.asarPath }, platform: 'win32' })
  check('asar: DSH_ASAR archive path discovers the nested bundle', asarEnv?.relPath === `dsh/${ACCOUNT_BUNDLE_IN_ASAR}`)
  const asarAsBundle = resolveBundle({ argv: ['--bundle', nestedArchive.asarPath], env: {}, platform: 'win32' })
  check('asar: --bundle <app.asar> discovers the nested bundle', asarAsBundle?.kind === 'asar' && asarAsBundle.relPath === `dsh/${ACCOUNT_BUNDLE_IN_ASAR}`)
  const hinted = resolveBundle({ argv: ['--bundle', join(nestedArchive.asarPath, 'node_modules', '@deepseek-ai', 'dsh-client-ui-settings-account', 'lib', 'client.js')], env: {}, platform: 'win32' })
  check('asar: a stale explicit hint falls back to the discovered entry', hinted?.relPath === `dsh/${ACCOUNT_BUNDLE_IN_ASAR}`)

  // Ambiguity must be reported, not guessed.
  const ambiguous = { files: {} }
  for (const prefix of ['', 'dsh/']) {
    const parts = `${prefix}${ACCOUNT_BUNDLE_IN_ASAR}`.split('/')
    const parent = parts.slice(0, -1).reduce((node, part) => {
      node.files[part] ??= { files: {} }
      return node.files[part]
    }, ambiguous)
    parent.files[parts[parts.length - 1]] = { size: 0, offset: 0 }
  }
  expectPatchError('asar: two copies of the bundle are refused', () => resolveAccountEntries(ambiguous), /found 2 copies/)

  // 7f. Header framing is byte-level compatible with @electron/asar: raw JSON length in the pickle,
  //     NUL padding to a 4-byte boundary. Built by hand so the encoder cannot vouch for itself, and the
  //     JSON length is chosen to be *not* 4-byte aligned so the padding is actually exercised.
  let rawHeader = null
  let rawJson = ''
  let rawLength = 0
  for (const name of ['a.js', 'ab.js', 'abc.js']) {
    rawHeader = { files: { [name]: { size: 0, offset: 0 } } }
    rawJson = JSON.stringify(rawHeader)
    rawLength = Buffer.byteLength(rawJson, 'utf8')
    if (rawLength % 4 !== 0) break
  }
  const paddedLength = Math.ceil(rawLength / 4) * 4
  check('asar: framing fixture JSON is not 4-byte aligned', paddedLength !== rawLength, `raw=${rawLength}`)
  const payloadSize = 4 + paddedLength
  const pickle = Buffer.alloc(4 + payloadSize)
  pickle.writeUInt32LE(payloadSize, 0)
  pickle.writeUInt32LE(rawLength, 4)
  Buffer.from(rawJson, 'utf8').copy(pickle, 8)
  const frame = Buffer.alloc(8 + pickle.length)
  frame.writeUInt32LE(4, 0)
  frame.writeUInt32LE(pickle.length, 4)
  pickle.copy(frame, 8)
  const framedArchive = join(tempRoot, 'framed', 'app.asar')
  mkdirSync(join(tempRoot, 'framed'), { recursive: true })
  writeFileSync(framedArchive, frame)
  const framedIndex = readAsarIndex(framedArchive)
  check('asar: hand-built pickle parses', framedIndex.header?.files?.[Object.keys(rawHeader.files)[0]] !== undefined)
  check('asar: pickle stringLength is the raw JSON length', framedIndex.stringLength === rawLength)
  check('asar: pickle payloadSize counts the padded string', framedIndex.payloadSize === 4 + paddedLength)
  const encoded = encodeHeaderBlock(rawHeader)
  check('asar: encoder writes the raw JSON length', encoded.block.readUInt32LE(12) === rawLength)
  check('asar: encoder NUL-pads', encoded.block.subarray(16 + rawLength, encoded.block.length).every((byte) => byte === 0x00))
  check('asar: encoder block length matches the header size', encoded.block.length === 8 + encoded.headerSize)
  expectPatchError('asar: corrupted header padding is rejected', () => {
    const broken = Buffer.from(frame)
    broken[broken.length - 1] = 0x41
    const brokenPath = join(tempRoot, 'framed', 'broken.asar')
    writeFileSync(brokenPath, broken)
    return readAsarIndex(brokenPath)
  }, /malformed asar header padding/)

  // 7g. revert refuses a stale backup: if the archive changed after the patch (e.g. an app update
  //     replaced it), restoring the old header would corrupt the new install.
  const staleArchive = buildArchive(join(tempRoot, 'stale'), { bundle: FIXTURE, withIntegrity: true, offsetAsString: false })
  applyAsarBundle({ asarPath: staleArchive.asarPath, relPath: ACCOUNT_BUNDLE_IN_ASAR, content: patchedText, backupDir })
  const patchedSize = readFileSync(staleArchive.asarPath).length
  appendFileSync(staleArchive.asarPath, Buffer.from([0]))
  expectPatchError('asar: revert refuses a replaced archive', () => revertAsarBundle({ asarPath: staleArchive.asarPath, backupDir }), /changed since the patch/)
  truncateSync(staleArchive.asarPath, patchedSize)
  revertAsarBundle({ asarPath: staleArchive.asarPath, backupDir })
  check('asar: revert works again once the archive is intact', !isPatched(readAsarEntry(readAsarIndex(staleArchive.asarPath), ACCOUNT_BUNDLE_IN_ASAR).buffer.toString('utf8')))

  // 7h. Two installs patched back-to-back must keep independent revert receipts.
  const firstArchive = buildArchive(join(tempRoot, 'first'), { bundle: FIXTURE, withIntegrity: true, offsetAsString: false })
  const secondArchive = buildArchive(join(tempRoot, 'second'), { bundle: FIXTURE, withIntegrity: true, offsetAsString: false })
  const firstBefore = readFileSync(firstArchive.asarPath)
  applyAsarBundle({ asarPath: firstArchive.asarPath, relPath: ACCOUNT_BUNDLE_IN_ASAR, content: patchedText, backupDir })
  applyAsarBundle({ asarPath: secondArchive.asarPath, relPath: ACCOUNT_BUNDLE_IN_ASAR, content: patchedText, backupDir })
  revertAsarBundle({ asarPath: firstArchive.asarPath, backupDir })
  check('asar: the first install reverts independently', readFileSync(firstArchive.asarPath).equals(firstBefore))
  check('asar: the second install stays patched', isPatched(readAsarEntry(readAsarIndex(secondArchive.asarPath), ACCOUNT_BUNDLE_IN_ASAR).buffer.toString('utf8')))
  revertAsarBundle({ asarPath: secondArchive.asarPath, backupDir })

  revertAsarBundle({ asarPath: nestedArchive.asarPath, backupDir })

  // 7c. Framing helpers
  check('asar: encodeHeaderBlock refuses a slot that is too small', encodeHeaderBlock({ files: {} }, { headerSize: 16 }).block === null)
  check('asar: encodeHeaderBlock pins the requested size', encodeHeaderBlock({ files: {} }, { headerSize: 32 }).block?.length === 40)
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log('\nengine test passed')
