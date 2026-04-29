import type { BundleStats } from './compare';

export type ImportKind = 'static' | 'dynamic';

export interface ImportEdge {
  from: string;
  to: string;
  kind: ImportKind;
}

export interface TracePath {
  rootEntry: string;
  rootChunk: string;
  edges: ImportEdge[];
}

export interface TraceContext {
  moduleToChunk: Map<string, string>;
  entryModules: Set<string>;
  entryChunkName: Map<string, string>;
  importers: Map<string, { id: string; kind: ImportKind }[]>;
  imports: Map<string, { id: string; kind: ImportKind }[]>;
  hasImportData: boolean;
}

export function buildTraceContext(stats: BundleStats): TraceContext {
  const moduleToChunk = new Map<string, string>();
  const entryModules = new Set<string>();
  const entryChunkName = new Map<string, string>();
  const importers = new Map<string, { id: string; kind: ImportKind }[]>();
  const imports = new Map<string, { id: string; kind: ImportKind }[]>();
  let hasImportData = false;

  for (const ch of stats.chunks) {
    const chunkName = ch.name || ch.fileName;
    if (ch.isEntry && ch.facadeModuleId) {
      entryModules.add(ch.facadeModuleId);
      entryChunkName.set(ch.facadeModuleId, chunkName);
    }
    for (const m of ch.modules) {
      moduleToChunk.set(m.id, chunkName);
    }
  }

  for (const ch of stats.chunks) {
    for (const m of ch.modules) {
      const stat = m.importedIds;
      const dyn = m.dynamicallyImportedIds;
      if (stat || dyn) hasImportData = true;
      const forward: { id: string; kind: ImportKind }[] = [];
      for (const tgt of stat ?? []) {
        if (!moduleToChunk.has(tgt)) continue;
        forward.push({ id: tgt, kind: 'static' });
        addImporter(importers, tgt, m.id, 'static');
      }
      for (const tgt of dyn ?? []) {
        if (!moduleToChunk.has(tgt)) continue;
        forward.push({ id: tgt, kind: 'dynamic' });
        addImporter(importers, tgt, m.id, 'dynamic');
      }
      if (forward.length) imports.set(m.id, forward);
    }
  }

  return {
    moduleToChunk,
    entryModules,
    entryChunkName,
    importers,
    imports,
    hasImportData,
  };
}

function addImporter(
  map: Map<string, { id: string; kind: ImportKind }[]>,
  target: string,
  source: string,
  kind: ImportKind,
) {
  let arr = map.get(target);
  if (!arr) {
    arr = [];
    map.set(target, arr);
  }
  arr.push({ id: source, kind });
}

/**
 * Enumerate import paths from any entry to `target`. Returns up to `maxPaths`
 * simple paths (no node repeats inside a single path) sorted shortest-first.
 *
 * - Backward BFS computes the set of nodes that can reach target; DFS prunes
 *   any branch outside that set.
 * - Each path tracks an `inPath` set so cycles in the import graph cannot loop
 *   forever — the same node never appears twice in one path. Cycles between
 *   different paths are fine; multiple distinct paths through different nodes
 *   are returned.
 */
export function tracePaths(
  ctx: TraceContext,
  target: string,
  maxPaths = 10,
): TracePath[] {
  if (!ctx.moduleToChunk.has(target)) return [];
  if (ctx.entryModules.has(target)) {
    return [
      {
        rootEntry: target,
        rootChunk: ctx.entryChunkName.get(target) ?? '',
        edges: [],
      },
    ];
  }

  const canReach = new Set<string>([target]);
  const queue: string[] = [target];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    for (const imp of ctx.importers.get(cur) ?? []) {
      if (!canReach.has(imp.id)) {
        canReach.add(imp.id);
        queue.push(imp.id);
      }
    }
  }

  const paths: TracePath[] = [];
  for (const entry of ctx.entryModules) {
    if (paths.length >= maxPaths) break;
    if (!canReach.has(entry)) continue;
    enumeratePaths(ctx, entry, target, canReach, maxPaths, paths);
  }

  paths.sort((a, b) => a.edges.length - b.edges.length);
  return paths;
}

function enumeratePaths(
  ctx: TraceContext,
  entry: string,
  target: string,
  canReach: Set<string>,
  maxPaths: number,
  out: TracePath[],
): void {
  const inPath = new Set<string>([entry]);
  const edges: ImportEdge[] = [];
  visit(entry);

  function visit(current: string): void {
    if (out.length >= maxPaths) return;
    if (current === target) {
      out.push({
        rootEntry: entry,
        rootChunk: ctx.entryChunkName.get(entry) ?? '',
        edges: edges.slice(),
      });
      return;
    }
    for (const child of ctx.imports.get(current) ?? []) {
      if (inPath.has(child.id)) continue;
      if (!canReach.has(child.id)) continue;
      inPath.add(child.id);
      edges.push({ from: current, to: child.id, kind: child.kind });
      visit(child.id);
      edges.pop();
      inPath.delete(child.id);
      if (out.length >= maxPaths) return;
    }
  }
}
