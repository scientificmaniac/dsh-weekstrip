<div align="center">

![dsh-weekstrip banner](docs/banner.en.png)

# dsh-weekstrip

An unofficial patch for **DSH Desktop** / **DSH NEXT** / the **official 0.2.1-rc.5 client** (DeepSeek
Harness) that puts a local usage panel under **Settings → Account & balance**: token usage, last 7 days,
and activity.

![License: MIT](https://img.shields.io/badge/License-MIT-blue) ![DSH Desktop / NEXT](https://img.shields.io/badge/DSH%20Desktop%20%2F%20NEXT-0.2.1--rc.2%20%7C%20rc.4%20%7C%20rc.5-4D6BFE) ![Node.js](https://img.shields.io/badge/Node.js-18%2B-339933) ![Platform](https://img.shields.io/badge/Platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey)

English · [简体中文](README.md)

</div>

> [!NOTE]
> This is a community patch, not a DeepSeek product. It only edits the account-settings bundle inside
> your own DSH installation: **loose installations** (older DSH Desktop) keep it as a plain
> `resources/app/...` file; **asar installations** (DSH NEXT from rc.4, and the official client from
> rc.5) pack the app into `resources/app.asar`, so the patch writes an `app.asar.unpacked` override and
> performs a small header rewrite. The path inside the archive varies by build (`node_modules/...` or
> `dsh/node_modules/...`) and is found by suffix. Upgrading the app replaces those files (re-run
> `apply`); `revert` restores them byte for byte.

Static preview in light and dark themes: [`docs/preview.html`](docs/preview.html) — download and open it in a browser.

## Screenshots

![English UI screenshot](docs/screenshot.en.png)

## What you get

| Card | Contents | Source |
| --- | --- | --- |
| **Token usage** | Lifetime billed tokens, four-bucket composition bar (input / cache read / cache write / output) with shares, model request count | Official `tokenUsage` session projection; falls back to the `contextActivity` day ledger |
| **Last 7 days** | One bar per local calendar day, 7-day total and daily average | `contextActivity.days` (per-day ledger registered by dsh-context) |
| **Activity** | Last 7 days as intensity cells, active days x/7, current streak, turns and tool calls | Same ledger (`requests` / `turns` / `toolCalls`) |

- Scope is **all sessions** listed by the harness (subagent sessions included, counted once).
- Days are **browser-local**; the window re-computes at midnight without reloading.
- Everything is read from the local session store — the panel itself makes no network calls. The only
  request is a same-origin `POST api/dsh-context/backfill` to an *optional* dsh-context route (see below).

## Requirements

| | |
| --- | --- |
| DSH Desktop / DSH NEXT / official client | Installed desktop app. Anchor set verified against **0.2.1-rc.2** (loose layout), **0.2.1-rc.4** (DSH NEXT, asar layout) and **0.2.1-rc.5** (official client, runtime nested under `dsh/` inside the asar) |
| Node.js | **18 or newer** (the patch scripts only) |
| dsh-context plugin | Optional. Without it: lifetime tokens still work; the per-day window/activity may stay empty |

## Install

Both installation layouts are supported:

| Layout | Target | How it is written |
| --- | --- | --- |
| loose (older DSH Desktop) | `<resources>/app/node_modules/@deepseek-ai/dsh-client-ui-settings-account/lib/client.js` | backup, then replace that file in place |
| asar (DSH NEXT / official 0.2.1-rc.5 client) | the same entry inside `<resources>/app.asar`, at the archive root or under `dsh/` — located by suffix | patched bundle goes to `<resources>/app.asar.unpacked/...`; only the archive header is rewritten to flag the entry `unpacked` (the data region is never moved) |

Pass the `resources` directory, the `app.asar` path, or set an env var:

```powershell
# Windows: normally %LOCALAPPDATA%\Programs\...; for a custom folder (e.g. E:\DSHDesktop) pass its resources dir
node src/patch.mjs status --resources "<install>/resources"   # detects either layout
node src/patch.mjs verify --resources "<install>/resources"   # anchors + syntax, writes nothing
node src/patch.mjs apply  --resources "<install>/resources"   # backup, then patch
```

```powershell
# or target the bundle directly
node src/patch.mjs apply --asar "<install>/resources/app.asar"          # asar layout
node src/patch.mjs apply --bundle "<...>/lib/client.js"                # loose layout (or a path inside the asar)

# or use environment variables
$env:DSH_RESOURCES_ROOT = "<install>/resources"   # PowerShell
$env:DSH_ASAR = "<install>/resources/app.asar"
$env:DSH_ACCOUNT_BUNDLE = "<...>/lib/client.js"
```

`apply` is idempotent: an already patched bundle is left alone. Every write is backed up to
`backups/` first, and the candidate text must pass `node --check` before it is installed. In the asar
layout, if the header slot cannot fit the new header (e.g. an archive without integrity manifests), the
tool falls back to rewriting the whole archive — fully quit DSH first in that case.

Then **fully quit and relaunch DSH** (the web shell snapshots plugin bundles at host start — a page
refresh does not pick up the change) and open **Settings → Account & balance**.

### Custom install locations

The automatic probe covers default locations (Windows `%LOCALAPPDATA%\Programs\DSH Desktop` and
`DSH NEXT`, `Program Files`; macOS `/Applications`; Linux `/opt`, `/usr/lib`, `~/.local/share`). If
`status` reports that the bundle could not be located, pass `--resources` / `--asar` / `--bundle` as
above.

If you run DSH from source or a global npm install instead of the Desktop app, point `--bundle` at that
installation's `node_modules/@deepseek-ai/dsh-client-ui-settings-account/lib/client.js`.

## Revert and upgrades

```powershell
node src/patch.mjs revert --resources "<install>/resources"   # restores the most recent backup
```

- Backups live in `backups/` (git-ignored):
  - loose layout: `client.js.<timestamp>.bak` (the whole bundle file);
  - asar layout: `app.asar.<timestamp>.hdr` + `.json` (the original archive header — the data region is
    never modified, so revert makes the archive **byte-identical** to the pre-patch file). A full
    `app.asar.<timestamp>.bak` is kept when the whole-archive rewrite was needed.
- Revert also deletes the `app.asar.unpacked` override the patch created.
- If the installation was replaced after patching (revert compares archive sizes), the revert is
  refused so an old header is never written into a newer archive — reinstall/update and run `apply`.
- An app update replaces the installation files (the asar layout replaces `app.asar` entirely), so the
  patch disappears — run `apply` again.
- If a future release changes the bundle, the anchors stop matching: `apply` aborts with
  `anchor "<name>" matched 0 time(s)` **without touching the file**. Add the new anchor set (or send a
  PR) rather than force-applying.

## How it works

The account settings page is a `settings.section` slot entry with no sub-slot of its own, so the panel
is inserted by editing the shipped client bundle at five anchor points:

1. `en` / `zh` account dictionaries gain the panel copy.
2. A self-contained module (`src/snippet.js`) is inserted before the `AccountSection` region.
3. The original component is renamed `AccountSectionMain`.
4. A new `AccountSection` renders `AccountSectionMain` plus the usage panel in a fragment.
5. The `settings.section` registration injects `refreshSessions` (used to re-read the session list
   after a backfill).

The panel reads the harness's standard `useSessions` hook (root-scope standard kit), is wrapped in its
own error boundary (a broken panel never takes the account cards down with it), and renders nothing
when the hook is absent.

### Packaging: loose layout vs asar layout

The account-settings bundle is stored differently by the builds, and `apply` picks the write strategy
from the layout:

- **loose** (older DSH Desktop) ships an unpacked `resources/app/` tree, so the bundle file is backed up
  and rewritten in place.
- **asar** (DSH NEXT, and the official client since 0.2.1-rc.5) packs the app into `resources/app.asar`.
  Electron's asar reader serves entries flagged `unpacked: true` from
  `resources/app.asar.unpacked/<path>` (that is how native modules are shipped), so the patch (1) writes
  the patched bundle to that `.unpacked` path and (2) rewrites only the archive header (~5 MB) to flag the
  entry, refresh its `size` and drop the stale `integrity`. The data region is never moved, so revert
  writes the original header back and the archive becomes **byte-identical** to the pre-patch file.
- The directory prefix inside the archive is not fixed: `0.2.1-rc.4` (DSH NEXT) keeps `node_modules/...`
  at the archive root, while `0.2.1-rc.5` (official client) nests the runtime under `dsh/`
  (`dsh/node_modules/...`). The patch walks the header and matches the
  `node_modules/@deepseek-ai/dsh-client-ui-settings-account/lib/client.js` suffix, so both layouts work.
  If the archive contains **two** copies of the bundle, the patch aborts and lists them, asking for an
  explicit `--bundle "<install>/resources/app.asar/<path>"` instead of guessing.

This relies on Electron's own asar semantics and was verified on a real install: the official 0.2.1-rc.5
client starts its host as `DeepSeek Harness.exe` with `ELECTRON_RUN_AS_NODE=1`, reads the client bundle
through Electron's asar shim, and resolves `readFileSync` / `stat` to the `.unpacked` override. That
client relies on the asar `unpacked` mechanism but does **not** enable
`EnableEmbeddedAsarIntegrityValidation`, so the header rewrite does not trip an integrity check.

## Development

```powershell
npm run check          # CI gate: syntax + patch-engine test + aggregation test (no install needed)
npm run engine-test    # anchor handling, insertion, idempotence, refusal paths, path detection, asar round-trips
npm run logic-test     # window/streak/four-bucket math, hostile-data degradation
npm run load-test      # executes the patched bundle through the shell's __ModuleLoader__ (needs an install)
npm run render-test    # renders the panel with a minimal React shim and asserts the copy/figures
npm run preview        # regenerates docs/preview.html (light + dark, zh); add -- --locale en for English
```

Tests that need a real installation skip with exit code 0 when none is found. For an asar-layout install,
pass `-- --resources "<install>/resources"` to load/render tests; the bundle is read from inside
`app.asar` (or from its patched `.unpacked` override). Verified versions live in `src/anchors.mjs`
(`VERIFIED_VERSIONS`).

## Compatibility

| DSH release | Status |
| --- | --- |
| `0.2.1-rc.2` | verified (loose layout, anchors tested end to end) |
| `0.2.1-rc.4` | verified (DSH NEXT, asar layout, including the override and a byte-identical revert round trip) |
| `0.2.1-rc.5` | verified (official client, asar layout with the runtime under `dsh/`, including the override and a byte-identical revert round trip) |
| other releases | attempted, aborts safely if anchors moved |

## Legal and privacy

- License: [MIT](LICENSE). Not affiliated with DeepSeek; “DeepSeek Harness”, “DSH” and DSH marks belong
  to their owners.
- The patch edits **your local installation only**. It ships no DSH code, no modified bundles and no
  binaries.
- No telemetry, no remote storage: the panel only reads session projections already held in the
  browser and (optionally) calls the same-origin backfill route of a locally installed plugin.
- Third-party attributions: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Acknowledgements

- [dsh-context](https://github.com/bowenliang123/dsh-context) for the per-day activity projection, the
  backfill route and the visual language this panel follows.
- The DSH team for publishing the client packages and their source layouts (MIT).

Contributing: [CONTRIBUTING_en.md](CONTRIBUTING_en.md)
