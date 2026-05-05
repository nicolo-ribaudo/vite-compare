export interface ManifestEntry {
  file: string;
  name?: string;
  src?: string;
  isEntry?: boolean;
  isDynamicEntry?: boolean;
  imports?: string[];
  dynamicImports?: string[];
  css?: string[];
  assets?: string[];
  [extra: string]: unknown;
}

export type Manifest = Record<string, ManifestEntry>;

export interface BundleStatsModule {
  id: string;
  renderedLength: number;
  originalLength: number;
  removedExports: string[];
  renderedExports: string[];
  /** Added in plugin v1.1; older stats files may omit. */
  importedIds?: string[];
  /** Added in plugin v1.1; older stats files may omit. */
  dynamicallyImportedIds?: string[];
}

export interface BundleStatsChunk {
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
   * Authoritative chunk size in bytes (post-minification). Plugin v1.2+;
   * older stats files lack this and fall back to summing module renderedLengths,
   * which over-reports under Rolldown (Vite 8) because Rolldown captures
   * per-module sizes before chunk-level minification.
   */
  renderedLength?: number;
  modules: BundleStatsModule[];
}

/** Authoritative chunk size: prefers chunk.renderedLength (plugin v1.2+), else sums modules. */
export function chunkSize(ch: BundleStatsChunk): number {
  if (typeof ch.renderedLength === 'number') return ch.renderedLength;
  let s = 0;
  for (const m of ch.modules) s += m.renderedLength;
  return s;
}

export interface BundleStats {
  version: 2;
  /** Vite version that produced this stats file (from the plugin). */
  viteVersion?: string;
  /** Free-form label set via plugin options. */
  label?: string;
  generatedAt: string;
  chunks: BundleStatsChunk[];
}

export type DetectedFormat = 'stats' | 'unknown';

export function detectFormat(parsed: unknown): DetectedFormat {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return 'unknown';
  }
  const obj = parsed as Record<string, unknown>;
  if (obj.version === 2 && Array.isArray(obj.chunks)) return 'stats';
  return 'unknown';
}

export interface ModuleEntry {
  id: string;
  chunk: string;
  size: number;
}

export interface MovedModule {
  id: string;
  fromChunk: string;
  toChunk: string;
  sizeA: number;
  sizeB: number;
}

export interface ModuleComparisonResult {
  totalA: number;
  totalB: number;
  onlyA: ModuleEntry[];
  onlyB: ModuleEntry[];
  moved: MovedModule[];
  same: ModuleEntry[];
}

export function compareModules(
  a: BundleStats,
  b: BundleStats,
  /**
   * Optional rename pairs: each [aChunkName, bChunkName] tells the diff that
   * a module appearing in chunk `aChunkName` on side A and chunk `bChunkName`
   * on side B is the same logical chunk — not a "moved" module.
   */
  renamedChunks: Array<[string, string]> = [],
): ModuleComparisonResult {
  const aMap = indexModules(a);
  const bMap = indexModules(b);

  const renamed = new Map<string, string>();
  for (const [aName, bName] of renamedChunks) renamed.set(aName, bName);

  const onlyA: ModuleEntry[] = [];
  const onlyB: ModuleEntry[] = [];
  const moved: MovedModule[] = [];
  const same: ModuleEntry[] = [];

  const allIds = new Set<string>([...aMap.keys(), ...bMap.keys()]);
  for (const id of allIds) {
    const ai = aMap.get(id);
    const bi = bMap.get(id);
    if (ai && !bi) {
      onlyA.push({ id, chunk: ai.chunk, size: ai.size });
    } else if (!ai && bi) {
      onlyB.push({ id, chunk: bi.chunk, size: bi.size });
    } else if (ai && bi) {
      if (ai.chunk === bi.chunk || renamed.get(ai.chunk) === bi.chunk) {
        same.push({ id, chunk: ai.chunk, size: bi.size });
      } else {
        moved.push({
          id,
          fromChunk: ai.chunk,
          toChunk: bi.chunk,
          sizeA: ai.size,
          sizeB: bi.size,
        });
      }
    }
  }

  const byId = (x: { id: string }, y: { id: string }) =>
    x.id.localeCompare(y.id);
  onlyA.sort(byId);
  onlyB.sort(byId);
  moved.sort(byId);
  same.sort(byId);

  return {
    totalA: aMap.size,
    totalB: bMap.size,
    onlyA,
    onlyB,
    moved,
    same,
  };
}

/** Map of manifest key → total chunk size in bytes. */
export function chunkSizeByKey(stats: BundleStats): Map<string, number> {
  const m = new Map<string, number>();
  for (const ch of stats.chunks) m.set(ch.key, chunkSize(ch));
  return m;
}

function indexModules(
  stats: BundleStats,
): Map<string, { chunk: string; size: number }> {
  const map = new Map<string, { chunk: string; size: number }>();
  for (const ch of stats.chunks) {
    const chunkName = ch.name || ch.fileName;
    for (const m of ch.modules) {
      map.set(m.id, { chunk: chunkName, size: m.renderedLength });
    }
  }
  return map;
}

export function parseBundleStats(raw: string): BundleStats {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Invalid JSON: ${(err as Error).message}`);
  }
  if (detectFormat(data) !== 'stats') {
    throw new Error(
      'Not a bundle-stats.json (expected { version: 2, chunks: [...] }). Rebuild with the latest plugin.',
    );
  }
  return data as BundleStats;
}

/** Derive a Manifest (used by chunk diff) from a v2 bundle-stats file. */
export function bundleStatsToManifest(stats: BundleStats): Manifest {
  const keyByFile = new Map<string, string>();
  for (const ch of stats.chunks) keyByFile.set(ch.fileName, ch.key);
  const manifest: Manifest = {};
  for (const ch of stats.chunks) {
    const entry: ManifestEntry = {
      file: ch.fileName,
      name: ch.name,
    };
    if (ch.src) entry.src = ch.src;
    if (ch.isEntry) entry.isEntry = true;
    if (ch.isDynamicEntry) entry.isDynamicEntry = true;
    const importKeys = uniqueKeys(ch.imports, keyByFile);
    if (importKeys.length) entry.imports = importKeys;
    const dynamicKeys = uniqueKeys(ch.dynamicImports, keyByFile);
    if (dynamicKeys.length) entry.dynamicImports = dynamicKeys;
    if (ch.css.length) entry.css = ch.css;
    if (ch.assets.length) entry.assets = ch.assets;
    manifest[ch.key] = entry;
  }
  return manifest;
}

function uniqueKeys(
  fileNames: string[],
  keyByFile: Map<string, string>,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const f of fileNames) {
    const k = keyByFile.get(f) ?? f;
    if (!seen.has(k)) {
      seen.add(k);
      out.push(k);
    }
  }
  return out;
}

export type DiffStatus = 'same' | 'changed' | 'only-a' | 'only-b';

export interface EntryDiff {
  key: string;
  /** Distinct manifest key on side A when the chunk was re-keyed (e.g., facade moved). */
  aKey?: string;
  /** Distinct manifest key on side B when the chunk was re-keyed. */
  bKey?: string;
  status: DiffStatus;
  changes: string[];
  a?: ManifestEntry;
  b?: ManifestEntry;
}

export interface ComparisonResult {
  totalA: number;
  totalB: number;
  entryCountA: number;
  entryCountB: number;
  dynamicEntryCountA: number;
  dynamicEntryCountB: number;
  onlyA: EntryDiff[];
  onlyB: EntryDiff[];
  changed: EntryDiff[];
  same: EntryDiff[];
}


/**
 * Build chunk-level diff. When both bundle stats are passed, additionally
 * detect renamed/re-keyed chunks: pairs (one only-A, one only-B) that share a
 * `name` 1:1, or whose module sets overlap by Jaccard ≥ `renameThreshold`
 * (default 0.5). Detected pairs are routed into `same` (when fully identical)
 * or `changed` (when content differs), with `aKey`/`bKey` set on the entry so
 * the UI can show the rename.
 */
export function compare(
  a: Manifest,
  b: Manifest,
  statsA?: BundleStats,
  statsB?: BundleStats,
  renameThreshold = 0.5,
): ComparisonResult {
  const keysA = new Set(Object.keys(a));
  const keysB = new Set(Object.keys(b));
  const allKeys = new Set([...keysA, ...keysB]);

  const onlyA: EntryDiff[] = [];
  const onlyB: EntryDiff[] = [];
  const changed: EntryDiff[] = [];
  const same: EntryDiff[] = [];

  for (const key of allKeys) {
    const inA = keysA.has(key);
    const inB = keysB.has(key);
    if (inA && !inB) {
      onlyA.push({ key, status: 'only-a', changes: [], a: a[key] });
    } else if (!inA && inB) {
      onlyB.push({ key, status: 'only-b', changes: [], b: b[key] });
    } else {
      const changes = diffEntry(a[key], b[key]);
      const entry: EntryDiff = {
        key,
        status: changes.length === 0 ? 'same' : 'changed',
        changes,
        a: a[key],
        b: b[key],
      };
      if (entry.status === 'same') same.push(entry);
      else changed.push(entry);
    }
  }

  // Pair leftover only-A and only-B by chunk name (1:1 matches). Same-name
  // chunks with different keys (e.g., entry's facadeModuleId moved from
  // main.ts → main.tsx) are the same logical chunk and belong in `changed`.
  const modsA = statsA ? chunkModuleIdsByKey(statsA) : undefined;
  const modsB = statsB ? chunkModuleIdsByKey(statsB) : undefined;
  const nameMatched = pairBySharedName(onlyA, onlyB, modsA, modsB);
  changed.push(...nameMatched.changed);
  same.push(...nameMatched.same);
  let onlyAAfterName = nameMatched.onlyA;
  let onlyBAfterName = nameMatched.onlyB;

  const byKey = (x: EntryDiff, y: EntryDiff) => x.key.localeCompare(y.key);
  onlyAAfterName.sort(byKey);
  onlyBAfterName.sort(byKey);
  changed.sort(byKey);
  same.sort(byKey);

  let onlyAFinal = onlyAAfterName;
  let onlyBFinal = onlyBAfterName;
  if (statsA && statsB) {
    const detected = detectRenames(
      onlyAAfterName,
      onlyBAfterName,
      statsA,
      statsB,
      renameThreshold,
    );
    same.push(...detected.same);
    changed.push(...detected.changed);
    same.sort(byKey);
    changed.sort(byKey);
    onlyAFinal = detected.onlyA;
    onlyBFinal = detected.onlyB;
  }

  return {
    totalA: keysA.size,
    totalB: keysB.size,
    entryCountA: countWhere(a, (e) => !!e.isEntry),
    entryCountB: countWhere(b, (e) => !!e.isEntry),
    dynamicEntryCountA: countWhere(a, (e) => !!e.isDynamicEntry),
    dynamicEntryCountB: countWhere(b, (e) => !!e.isDynamicEntry),
    onlyA: onlyAFinal,
    onlyB: onlyBFinal,
    changed,
    same,
  };
}

/**
 * Pair only-A and only-B entries that share a chunk `name` (1:1 only — names
 * with multiple candidates on either side are left for rename detection).
 * Same-name pairs are reclassified as `changed` (or `same` if module sets
 * happen to be identical) and carry both keys for size lookup.
 */
function pairBySharedName(
  onlyA: EntryDiff[],
  onlyB: EntryDiff[],
  modsA: Map<string, Set<string>> | undefined,
  modsB: Map<string, Set<string>> | undefined,
): {
  onlyA: EntryDiff[];
  onlyB: EntryDiff[];
  changed: EntryDiff[];
  same: EntryDiff[];
} {
  const aByName = new Map<string, EntryDiff[]>();
  const bByName = new Map<string, EntryDiff[]>();
  for (const a of onlyA) {
    const n = a.a?.name;
    if (!n) continue;
    const arr = aByName.get(n) ?? [];
    arr.push(a);
    aByName.set(n, arr);
  }
  for (const b of onlyB) {
    const n = b.b?.name;
    if (!n) continue;
    const arr = bByName.get(n) ?? [];
    arr.push(b);
    bByName.set(n, arr);
  }
  const claimedA = new Set<EntryDiff>();
  const claimedB = new Set<EntryDiff>();
  const changed: EntryDiff[] = [];
  const same: EntryDiff[] = [];
  for (const [name, aArr] of aByName) {
    if (aArr.length !== 1) continue;
    const bArr = bByName.get(name);
    if (!bArr || bArr.length !== 1) continue;
    const ad = aArr[0];
    const bd = bArr[0];
    const cs = diffEntry(ad.a!, bd.b!);
    const aMods = modsA?.get(ad.key);
    const bMods = modsB?.get(bd.key);
    if (aMods && bMods) {
      const moduleChanges = describeModuleSetDiff(aMods, bMods);
      if (moduleChanges) cs.push(moduleChanges);
    }
    const status: DiffStatus = cs.length === 0 ? 'same' : 'changed';
    const merged: EntryDiff = {
      key: name,
      aKey: ad.key,
      bKey: bd.key,
      status,
      changes: cs,
      a: ad.a,
      b: bd.b,
    };
    if (status === 'same') same.push(merged);
    else changed.push(merged);
    claimedA.add(ad);
    claimedB.add(bd);
  }
  return {
    onlyA: onlyA.filter((x) => !claimedA.has(x)),
    onlyB: onlyB.filter((x) => !claimedB.has(x)),
    changed,
    same,
  };
}

function detectRenames(
  onlyA: EntryDiff[],
  onlyB: EntryDiff[],
  statsA: BundleStats,
  statsB: BundleStats,
  threshold: number,
): {
  same: EntryDiff[];
  changed: EntryDiff[];
  onlyA: EntryDiff[];
  onlyB: EntryDiff[];
} {
  const modsA = chunkModuleIdsByKey(statsA);
  const modsB = chunkModuleIdsByKey(statsB);

  const candidates: { ai: number; bi: number; score: number }[] = [];
  for (let ai = 0; ai < onlyA.length; ai++) {
    const aMods = modsA.get(onlyA[ai].key);
    if (!aMods || aMods.size === 0) continue;
    for (let bi = 0; bi < onlyB.length; bi++) {
      const bMods = modsB.get(onlyB[bi].key);
      if (!bMods || bMods.size === 0) continue;
      const score = jaccard(aMods, bMods);
      if (score >= threshold) candidates.push({ ai, bi, score });
    }
  }
  candidates.sort((x, y) => y.score - x.score);

  const claimedA = new Set<number>();
  const claimedB = new Set<number>();
  const same: EntryDiff[] = [];
  const changed: EntryDiff[] = [];
  for (const c of candidates) {
    if (claimedA.has(c.ai) || claimedB.has(c.bi)) continue;
    claimedA.add(c.ai);
    claimedB.add(c.bi);
    const aDiff = onlyA[c.ai];
    const bDiff = onlyB[c.bi];
    const ae = aDiff.a!;
    const be = bDiff.b!;
    const fromName = ae.name || ae.file;
    const toName = be.name || be.file;
    const cs = diffEntry(ae, be);
    const aMods = modsA.get(aDiff.key);
    const bMods = modsB.get(bDiff.key);
    if (aMods && bMods) {
      const moduleChanges = describeModuleSetDiff(aMods, bMods);
      if (moduleChanges) cs.push(moduleChanges);
    }
    const merged: EntryDiff = {
      key: `${fromName} → ${toName}`,
      aKey: aDiff.key,
      bKey: bDiff.key,
      status: cs.length === 0 ? 'same' : 'changed',
      changes: cs,
      a: ae,
      b: be,
    };
    if (merged.status === 'same') same.push(merged);
    else changed.push(merged);
  }

  return {
    same,
    changed,
    onlyA: onlyA.filter((_, i) => !claimedA.has(i)),
    onlyB: onlyB.filter((_, i) => !claimedB.has(i)),
  };
}

function describeModuleSetDiff(a: Set<string>, b: Set<string>): string | null {
  let added = 0;
  let removed = 0;
  for (const x of a) if (!b.has(x)) removed++;
  for (const x of b) if (!a.has(x)) added++;
  if (added === 0 && removed === 0) return null;
  const parts: string[] = [];
  if (removed) parts.push(`-${removed} module${removed === 1 ? '' : 's'}`);
  if (added) parts.push(`+${added} module${added === 1 ? '' : 's'}`);
  return `modules: ${parts.join(', ')}`;
}

function chunkModuleIdsByKey(stats: BundleStats): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  for (const ch of stats.chunks) {
    const set = new Set<string>();
    for (const m of ch.modules) set.add(m.id);
    map.set(ch.key, set);
  }
  return map;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const x of small) if (large.has(x)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

function countWhere(m: Manifest, pred: (e: ManifestEntry) => boolean): number {
  let n = 0;
  for (const e of Object.values(m)) if (pred(e)) n++;
  return n;
}

const HASHED_FIELDS = new Set(['css', 'assets']);
const SKIP_FIELDS = new Set(['file']);

function diffEntry(a: ManifestEntry, b: ManifestEntry): string[] {
  const changes: string[] = [];
  const allKeys = new Set([...Object.keys(a), ...Object.keys(b)]);

  for (const key of allKeys) {
    if (SKIP_FIELDS.has(key)) continue;
    const av = a[key];
    const bv = b[key];

    if (Array.isArray(av) || Array.isArray(bv)) {
      const aArr = (Array.isArray(av) ? av : []).map(String).sort();
      const bArr = (Array.isArray(bv) ? bv : []).map(String).sort();
      if (arrEq(aArr, bArr)) continue;
      if (HASHED_FIELDS.has(key)) {
        changes.push(`${key} count: ${aArr.length} → ${bArr.length}`);
        continue;
      }
      const added = bArr.filter((x) => !aArr.includes(x));
      const removed = aArr.filter((x) => !bArr.includes(x));
      if (added.length) changes.push(`+${key}: ${added.join(', ')}`);
      if (removed.length) changes.push(`-${key}: ${removed.join(', ')}`);
      continue;
    }

    if (av !== bv) {
      changes.push(`${key}: ${fmt(av)} → ${fmt(bv)}`);
    }
  }

  return changes;
}

function arrEq(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function fmt(v: unknown): string {
  if (v === undefined) return '∅';
  return JSON.stringify(v);
}
