# vite-compare

A web tool for comparing two builds of a Vite app side-by-side, working with both Rollup and Rolldown (rolldown-vite) as the underlying bundler: chunk diff, per-entry size analysis, module diff, and an interactive chunk/module graph with import-path tracing.

**Live: <https://nicolo-ribaudo.github.io/vite-compare>**

> :warning: This tool has been enteirely auto-generated, I have not reviewed the code for correctness at all. It may have bugs.

## Privacy

The UI runs entirely in your browser. Uploaded `bundle-stats.json` files stay on your machine — they're parsed locally and persisted only to the browser's IndexedDB. **Nothing is uploaded to any server.**

## How to use it

You need to generate one `bundle-stats.json` per build you want to compare (e.g. before and after a refactor, or two different Vite versions).

### 1. Drop the plugin in your project

Copy [`plugins/vite-plugin-bundle-stats.ts`](./plugins/vite-plugin-bundle-stats.ts) into your project (anywhere — the `plugins/` directory is conventional but not required), then register it in your `vite.config.ts`:

```ts
import { defineConfig } from 'vite';
import { bundleStats } from './plugins/vite-plugin-bundle-stats.ts';

export default defineConfig({
  plugins: [
    bundleStats({
      // Optional. Free-form label embedded in the file, shown in the UI.
      label: 'before refactor',
      // Optional. Output path within the build's outDir.
      // Defaults to '.vite/bundle-stats.json'.
      fileName: 'bundle-stats.json',
    }),
  ],
});
```

Both options are optional:

- **`label`** — free-form string shown in the UI under the upload box, useful when comparing more than two builds (e.g. `'vite-7 baseline'`, `'after refactor'`).
- **`fileName`** — where to write the stats file inside the build's `outDir`. Defaults to `.vite/bundle-stats.json`. Set it to e.g. `'bundle-stats.json'` to write directly to `dist/bundle-stats.json`.

The plugin only runs on `vite build` (not in dev). It uses the Rollup-/Rolldown-compatible `generateBundle` hook plus `chunk.viteMetadata`, so it works the same way on either bundler — no other config changes are required.

### 2. Build and upload

```sh
# In your project
pnpm build   # or npm/yarn build
```

Then open <https://nicolo-ribaudo.github.io/vite-compare>, drop one `bundle-stats.json` into each side ("A" and "B"). To compare two builds, build your app twice (e.g. once on each branch) and save the file from each.

## Features

- **Entry analysis**: per-entry initial / lazy chunk and size totals; static entries always shown, dynamically-loaded entrypoints surfaced via search. Works correctly even with Rolldown's `groups` codeSplitting, where dynamic chunks are still detected from the import graph.
- **Chunk diff**: chunks added, removed, changed, and identical. Renamed/re-keyed chunks are auto-paired (by name first, then by ≥50% module-set Jaccard) and folded into Changed/Identical.
- **Module diff**: source modules added, removed, moved between chunks, or unchanged.
- **Graph**: force-directed chunk-level graph with module squares inside each cluster. Search to highlight modules; right-click a chunk to hide its incoming/outgoing edges or hide the whole chunk; "why included" inspector enumerates all import paths from any entry.

All view state (uploaded files, hidden chunks, graph view side, etc.) persists across reloads in the browser's local storage.

## Local development

```sh
pnpm install
pnpm dev        # http://localhost:5173
pnpm build      # production build into dist/
pnpm typecheck
```
