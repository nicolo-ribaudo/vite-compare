import path from 'node:path';
import { createRequire } from 'node:module';
import type { Plugin } from 'vite';
import type { OutputChunk } from 'rollup';

const viteVersion: string = (
  createRequire(import.meta.url)('vite/package.json') as { version: string }
).version;

export interface BundleStatsOptions {
  /** Output path within the build's outDir. Defaults to `.vite/bundle-stats.json`. */
  fileName?: string;
  /** Free-form label embedded in the snapshot to identify it in the UI (e.g. "vite-7 baseline", "before refactor"). */
  label?: string;
}

export interface BundleStatsModule {
  id: string;
  renderedLength: number;
  originalLength: number;
  removedExports: string[];
  renderedExports: string[];
  importedIds: string[];
  dynamicallyImportedIds: string[];
}

export interface BundleStatsChunk {
  /** Stable identifier across builds. Source path for entry/dynamic chunks; `_<name>.js` otherwise. */
  key: string;
  fileName: string;
  src: string | null;
  name: string;
  isEntry: boolean;
  isDynamicEntry: boolean;
  facadeModuleId: string | null;
  imports: string[];
  dynamicImports: string[];
  css: string[];
  assets: string[];
  moduleCount: number;
  /**
   * Byte length of the emitted chunk file (post-minification). Authoritative
   * chunk size — Rolldown's per-module `renderedLength` is captured before
   * chunk-level minification and over-reports if summed.
   */
  renderedLength: number;
  modules: BundleStatsModule[];
}

export interface BundleStats {
  version: 2;
  viteVersion: string;
  label?: string;
  generatedAt: string;
  chunks: BundleStatsChunk[];
}

interface ViteChunkMetadata {
  importedAssets?: Set<string>;
  importedCss?: Set<string>;
}
type ViteOutputChunk = OutputChunk & { viteMetadata?: ViteChunkMetadata };

export function bundleStats(options: BundleStatsOptions = {}): Plugin {
  const fileName = options.fileName ?? '.vite/bundle-stats.json';
  const label = options.label;
  let root = process.cwd();

  return {
    name: 'bundle-stats',
    apply: 'build',
    enforce: 'post',
    configResolved(config) {
      root = config.root;
    },
    generateBundle(_outputOpts, bundle) {
      const chunks: BundleStatsChunk[] = [];
      for (const item of Object.values(bundle)) {
        if (item.type !== 'chunk') continue;
        const chunk = item as ViteOutputChunk;
        const meta = chunk.viteMetadata;
        const modules: BundleStatsModule[] = Object.entries(chunk.modules).map(
          ([id, mod]) => {
            const info = this.getModuleInfo(id);
            return {
              id: relativize(id, root),
              renderedLength: mod.renderedLength,
              originalLength: mod.originalLength,
              removedExports: mod.removedExports,
              renderedExports: mod.renderedExports,
              importedIds: (info?.importedIds ?? []).map((x) =>
                relativize(x, root),
              ),
              dynamicallyImportedIds: (info?.dynamicallyImportedIds ?? []).map(
                (x) => relativize(x, root),
              ),
            };
          },
        );
        chunks.push({
          key: makeKey(chunk, root),
          fileName: chunk.fileName,
          src:
            chunk.isEntry && chunk.facadeModuleId
              ? relativize(chunk.facadeModuleId, root)
              : null,
          name: chunk.name,
          isEntry: chunk.isEntry,
          isDynamicEntry: chunk.isDynamicEntry,
          facadeModuleId: chunk.facadeModuleId
            ? relativize(chunk.facadeModuleId, root)
            : null,
          imports: chunk.imports,
          dynamicImports: chunk.dynamicImports,
          css: meta?.importedCss ? [...meta.importedCss] : [],
          assets: meta?.importedAssets ? [...meta.importedAssets] : [],
          moduleCount: modules.length,
          renderedLength: utf8ByteLength(chunk.code),
          modules,
        });
      }
      const payload: BundleStats = {
        version: 2,
        viteVersion,
        ...(label ? { label } : {}),
        generatedAt: new Date().toISOString(),
        chunks,
      };
      this.emitFile({
        type: 'asset',
        fileName,
        source: JSON.stringify(payload, null, 2),
      });
    },
  };
}

function makeKey(chunk: ViteOutputChunk, root: string): string {
  if (chunk.facadeModuleId) return relativize(chunk.facadeModuleId, root);
  return `_${chunk.name}.js`;
}

const textEncoder = new TextEncoder();
function utf8ByteLength(s: string): number {
  return textEncoder.encode(s).length;
}

function relativize(id: string, root: string): string {
  if (id.startsWith('\0')) return id;
  if (!path.isAbsolute(id)) return id;
  const rel = path.relative(root, id);
  if (rel.startsWith('..')) return id;
  return rel.split(path.sep).join('/');
}
