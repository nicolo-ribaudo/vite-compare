import { chunkSize, type BundleStats, type BundleStatsChunk } from './compare';

export interface EntryAnalysis {
  entry: string;
  facadeModuleId: string | null;
  /** Whether this entrypoint is a static entry (true) or a dynamic-import root (false). */
  isStatic: boolean;
  initialChunks: number;
  initialSize: number;
  lazyChunks: number;
  lazySize: number;
}

export interface SideAnalysis {
  totalChunks: number;
  totalSize: number;
  initialChunks: number;
  initialSize: number;
  lazyChunks: number;
  lazySize: number;
  entries: EntryAnalysis[];
}

export function analyze(stats: BundleStats): SideAnalysis {
  const chunkByFile = new Map(stats.chunks.map((c) => [c.fileName, c]));
  const sizeFor = (ch: BundleStatsChunk) => chunkSize(ch);

  // Some bundlers (e.g. rolldown with groups codeSplitting) don't set
  // isDynamicEntry on chunks that are still referenced from another chunk's
  // dynamicImports. Treat such chunks as dynamic entrypoints so they show up
  // in the entry analysis the same way they would under regular splitting.
  const dynamicallyImported = new Set<string>();
  for (const ch of stats.chunks) {
    for (const imp of ch.dynamicImports) dynamicallyImported.add(imp);
  }
  const isEntrypoint = (ch: BundleStatsChunk) =>
    ch.isEntry || ch.isDynamicEntry || dynamicallyImported.has(ch.fileName);

  const entryAnalyses: EntryAnalysis[] = [];
  const allInitial = new Set<string>();
  const allLazy = new Set<string>();

  for (const ch of stats.chunks) {
    if (!isEntrypoint(ch)) continue;
    const { initial, lazy } = reachable(chunkByFile, ch.fileName);
    let initialSize = 0;
    for (const f of initial) {
      const c = chunkByFile.get(f);
      if (c) initialSize += sizeFor(c);
    }
    let lazySize = 0;
    for (const f of lazy) {
      const c = chunkByFile.get(f);
      if (c) lazySize += sizeFor(c);
    }
    entryAnalyses.push({
      entry: ch.name || ch.fileName,
      facadeModuleId: ch.facadeModuleId,
      isStatic: ch.isEntry,
      initialChunks: initial.size,
      initialSize,
      lazyChunks: lazy.size,
      lazySize,
    });
    // Only static entries contribute to the global initial/lazy totals — dynamic
    // entrypoints are themselves lazy-loaded, so rolling their reachability into
    // "initial" would double-count them as if they were main-bundle chunks.
    if (ch.isEntry) {
      for (const f of initial) allInitial.add(f);
      for (const f of lazy) allLazy.add(f);
    }
  }

  for (const f of allInitial) allLazy.delete(f);

  let totalSize = 0;
  for (const ch of stats.chunks) totalSize += sizeFor(ch);
  let initialSize = 0;
  for (const f of allInitial) {
    const c = chunkByFile.get(f);
    if (c) initialSize += sizeFor(c);
  }
  let lazySize = 0;
  for (const f of allLazy) {
    const c = chunkByFile.get(f);
    if (c) lazySize += sizeFor(c);
  }

  entryAnalyses.sort((a, b) => a.entry.localeCompare(b.entry));

  return {
    totalChunks: stats.chunks.length,
    totalSize,
    initialChunks: allInitial.size,
    initialSize,
    lazyChunks: allLazy.size,
    lazySize,
    entries: entryAnalyses,
  };
}

function reachable(
  chunkByFile: Map<string, BundleStatsChunk>,
  entryFile: string,
): { initial: Set<string>; lazy: Set<string> } {
  const initial = new Set<string>([entryFile]);
  const queue = [entryFile];
  while (queue.length) {
    const cur = queue.shift()!;
    const ch = chunkByFile.get(cur);
    if (!ch) continue;
    for (const imp of ch.imports) {
      if (!initial.has(imp)) {
        initial.add(imp);
        queue.push(imp);
      }
    }
  }

  const lazy = new Set<string>();
  const lazyQueue: string[] = [];
  for (const f of initial) {
    const ch = chunkByFile.get(f);
    if (!ch) continue;
    for (const imp of ch.dynamicImports) {
      if (!initial.has(imp) && !lazy.has(imp)) {
        lazy.add(imp);
        lazyQueue.push(imp);
      }
    }
  }
  while (lazyQueue.length) {
    const cur = lazyQueue.shift()!;
    const ch = chunkByFile.get(cur);
    if (!ch) continue;
    for (const imp of ch.imports) {
      if (!initial.has(imp) && !lazy.has(imp)) {
        lazy.add(imp);
        lazyQueue.push(imp);
      }
    }
    for (const imp of ch.dynamicImports) {
      if (!initial.has(imp) && !lazy.has(imp)) {
        lazy.add(imp);
        lazyQueue.push(imp);
      }
    }
  }

  return { initial, lazy };
}
