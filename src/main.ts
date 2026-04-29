import './style.css';
import {
  parseBundleStats,
  bundleStatsToManifest,
  chunkSizeByKey,
  detectFormat,
  compare,
  compareModules,
  type BundleStats,
  type ComparisonResult,
  type EntryDiff,
  type ManifestEntry,
  type ModuleComparisonResult,
  type ModuleEntry,
  type MovedModule,
} from './compare';
import {
  buildSideGraph,
  renderGraph,
  resetGraphHiding,
  hasGraphHiding,
  getHiddenChunkNames,
  setHiddenChunkNames,
  unhideChunk,
  type SideGraph,
} from './graph';
import {
  loadPersisted,
  savePersisted,
  clearPersisted,
  type PersistedFile,
} from './persist';
import {
  buildTraceContext,
  tracePaths,
  type TraceContext,
  type TracePath,
} from './trace';
import { analyze, type SideAnalysis, type EntryAnalysis } from './analyze';

type Side = 'a' | 'b';

interface Loaded<T> {
  filename: string;
  raw: string;
  data: T;
}

interface SideState {
  stats?: Loaded<BundleStats>;
}

const state: Record<Side, SideState> = { a: {}, b: {} };
let graphView: Side = 'a';
let graphHideUnchanged = false;
let graphModuleSearch = '';
let entryDynamicSearch = '';
const traceCache: Partial<Record<Side, TraceContext>> = {};
/** Renamed chunks (a-name, b-name) — refreshed whenever both stats are loaded. */
let renamedPairs: Array<[string, string]> = [];

function getTraceContext(side: Side): TraceContext | undefined {
  const stats = state[side].stats;
  if (!stats) {
    delete traceCache[side];
    return undefined;
  }
  let ctx = traceCache[side];
  if (!ctx) {
    ctx = buildTraceContext(stats.data);
    traceCache[side] = ctx;
  }
  return ctx;
}

function invalidateTrace(side?: Side) {
  if (side) delete traceCache[side];
  else {
    delete traceCache.a;
    delete traceCache.b;
  }
}

const uploaders = document.querySelectorAll<HTMLDivElement>('.uploader');
for (const el of uploaders) {
  const side = el.dataset.side as Side;
  const input = el.querySelector<HTMLInputElement>('input[type=file]')!;
  const status = el.querySelector<HTMLDivElement>('[data-status]')!;
  const label = el.querySelector<HTMLLabelElement>('label')!;

  input.addEventListener('change', () => {
    if (input.files) void handleFiles(side, input.files, status);
    input.value = '';
  });

  label.addEventListener('dragover', (e) => {
    e.preventDefault();
    el.classList.add('dragover');
  });
  label.addEventListener('dragleave', () => el.classList.remove('dragover'));
  label.addEventListener('drop', (e) => {
    e.preventDefault();
    el.classList.remove('dragover');
    if (e.dataTransfer?.files) {
      void handleFiles(side, e.dataTransfer.files, status);
    }
  });
}

async function handleFiles(
  side: Side,
  files: FileList,
  status: HTMLDivElement,
) {
  const errors: string[] = [];
  for (const file of Array.from(files)) {
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      if (detectFormat(parsed) !== 'stats') {
        errors.push(
          `${file.name}: not a bundle-stats.json (expected version: 2)`,
        );
        continue;
      }
      state[side].stats = {
        filename: file.name,
        raw: text,
        data: parseBundleStats(text),
      };
      invalidateTrace(side);
    } catch (err) {
      errors.push(`${file.name}: ${(err as Error).message}`);
    }
  }
  renderStatus(side, status, errors);
  renderAll();
  void persistState();
}

function renderAll() {
  maybeRenderInstructions();
  maybeRenderResults();
  maybeRenderEntryAnalysis();
  maybeRenderModuleDiff();
  maybeRenderGraph();
  updateSectionNav();
}

function maybeRenderInstructions() {
  const section = document.getElementById('instructions');
  if (!section) return;
  section.hidden = !!(state.a.stats || state.b.stats);
}

function updateSectionNav() {
  const nav = document.getElementById('section-nav');
  if (!nav) return;
  let anyVisible = false;
  for (const item of nav.querySelectorAll<HTMLLIElement>('li')) {
    const a = item.querySelector<HTMLAnchorElement>('a');
    const targetId = a?.dataset.section ?? '';
    if (targetId === 'top') continue;
    const target = document.getElementById(targetId);
    const visible = !!target && !target.hidden;
    item.classList.toggle('nav-disabled', !visible);
    if (visible) anyVisible = true;
  }
  const topItem = nav.querySelector<HTMLLIElement>('li:has(a[data-section="top"])');
  if (topItem) topItem.classList.toggle('nav-disabled', !anyVisible);
  nav.hidden = !anyVisible;
}

function setupSectionScrollSpy() {
  const nav = document.getElementById('section-nav');
  if (!nav) return;
  const ids = ['top', 'entry-analysis', 'results', 'module-diff', 'graph-section'];
  const linkById = new Map<string, HTMLAnchorElement>();
  for (const id of ids) {
    const link = nav.querySelector<HTMLAnchorElement>(
      `a[data-section="${id}"]`,
    );
    if (link) linkById.set(id, link);
  }
  const TRIGGER_Y = 120;
  const update = () => {
    let activeId = 'top';
    for (const id of ids) {
      const target = document.getElementById(id);
      if (!target || target.hidden) continue;
      const rect = target.getBoundingClientRect();
      // Most recently passed: section whose top edge is at or above the trigger line.
      if (rect.top <= TRIGGER_Y) activeId = id;
    }
    for (const [id, link] of linkById) {
      link.classList.toggle('active', id === activeId);
    }
  };
  window.addEventListener('scroll', update, { passive: true });
  window.addEventListener('resize', update);
  update();
}

function persistState() {
  return savePersisted({
    a: toPersisted(state.a),
    b: toPersisted(state.b),
    graphView,
    graphHideUnchanged,
    entryDynamicSearch,
    graphHiddenChunks: getHiddenChunkNames(),
  });
}

function toPersisted(s: SideState): { stats?: PersistedFile } {
  if (!s.stats) return {};
  return { stats: { filename: s.stats.filename, raw: s.stats.raw } };
}

function clearAll() {
  state.a = {};
  state.b = {};
  invalidateTrace();
  closeInspector();
  graphHideUnchanged = false;
  for (const el of uploaders) {
    const side = el.dataset.side as Side;
    const status = el.querySelector<HTMLDivElement>('[data-status]')!;
    renderStatus(side, status, []);
  }
  renderAll();
  void clearPersisted();
}

function renderStatus(side: Side, status: HTMLDivElement, errors: string[]) {
  const s = state[side];
  status.className =
    'uploader-status' + (errors.length ? ' err' : s.stats ? ' ok' : '');
  status.replaceChildren();
  if (s.stats) {
    const totalModules = s.stats.data.chunks.reduce(
      (acc, c) => acc + c.modules.length,
      0,
    );
    const summary = document.createElement('div');
    summary.textContent = `${s.stats.filename} · ${s.stats.data.chunks.length} chunks · ${totalModules} modules`;
    status.appendChild(summary);
    const meta = document.createElement('div');
    meta.className = 'uploader-meta';
    if (s.stats.data.label) {
      const labelEl = document.createElement('span');
      labelEl.className = 'snapshot-label';
      labelEl.textContent = s.stats.data.label;
      meta.appendChild(labelEl);
    }
    if (s.stats.data.viteVersion) {
      const badge = document.createElement('span');
      badge.className = 'vite-version-badge';
      badge.textContent = `vite@${s.stats.data.viteVersion}`;
      meta.appendChild(badge);
    }
    if (meta.children.length) status.appendChild(meta);
  } else {
    const summary = document.createElement('div');
    summary.textContent = 'No file loaded';
    status.appendChild(summary);
  }
  for (const err of errors) {
    const div = document.createElement('div');
    div.className = 'err-line';
    div.textContent = err;
    status.appendChild(div);
  }
}

function maybeRenderResults() {
  const results = document.getElementById('results')!;
  if (!state.a.stats || !state.b.stats) {
    results.hidden = true;
    results.replaceChildren();
    renamedPairs = [];
    return;
  }
  const manifestA = bundleStatsToManifest(state.a.stats.data);
  const manifestB = bundleStatsToManifest(state.b.stats.data);
  const result = compare(
    manifestA,
    manifestB,
    state.a.stats.data,
    state.b.stats.data,
  );
  renamedPairs = collectRenamedPairs(result);
  const sizesA = chunkSizeByKey(state.a.stats.data);
  const sizesB = chunkSizeByKey(state.b.stats.data);
  results.hidden = false;
  results.replaceChildren(
    renderResult(
      result,
      state.a.stats.filename,
      state.b.stats.filename,
      sizesA,
      sizesB,
    ),
  );
}

function collectRenamedPairs(r: ComparisonResult): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const e of [...r.changed, ...r.same]) {
    if (!e.aKey || !e.bKey || e.aKey === e.bKey) continue;
    const aName = e.a?.name;
    const bName = e.b?.name;
    if (!aName || !bName || aName === bName) continue;
    out.push([aName, bName]);
  }
  return out;
}

function maybeRenderEntryAnalysis() {
  const section = document.getElementById('entry-analysis')!;
  const aStats = state.a.stats;
  const bStats = state.b.stats;
  if (!aStats && !bStats) {
    section.hidden = true;
    section.replaceChildren();
    return;
  }
  const a = aStats ? analyze(aStats.data) : undefined;
  const b = bStats ? analyze(bStats.data) : undefined;
  const nonEntryNamesA = collectNonEntryNames(aStats?.data);
  const nonEntryNamesB = collectNonEntryNames(bStats?.data);
  section.hidden = false;
  section.replaceChildren(
    renderEntryAnalysis(a, b, nonEntryNamesA, nonEntryNamesB),
  );
}

function collectNonEntryNames(stats: BundleStats | undefined): Set<string> {
  const out = new Set<string>();
  if (!stats) return out;
  // Mirror analyze.ts: a chunk referenced via someone else's dynamicImports
  // counts as an entrypoint even if isDynamicEntry isn't set on it.
  const dynamicallyImported = new Set<string>();
  for (const ch of stats.chunks) {
    for (const imp of ch.dynamicImports) dynamicallyImported.add(imp);
  }
  for (const ch of stats.chunks) {
    if (ch.isEntry || ch.isDynamicEntry) continue;
    if (dynamicallyImported.has(ch.fileName)) continue;
    out.add(ch.name || ch.fileName);
  }
  return out;
}

function renderEntryAnalysis(
  a: SideAnalysis | undefined,
  b: SideAnalysis | undefined,
  nonEntryNamesA: Set<string>,
  nonEntryNamesB: Set<string>,
): Node {
  const frag = document.createDocumentFragment();

  frag.append(
    el('h2', { class: 'analysis-title' }, 'Entry analysis'),
    el(
      'p',
      { class: 'analysis-note' },
      'Sizes are sums of module rendered lengths (post tree-shake / transform). "Initial" = chunks reachable via static imports from any entry; "Lazy" = additional chunks reachable only via at least one dynamic import.',
    ),
  );

  const totalsTable = el('table', { class: 'analysis-table totals-table' });
  const tbody = el('tbody');
  totalsTable.append(buildTotalsHead(), tbody);
  const totalRows: [string, (s: SideAnalysis) => number, 'count' | 'bytes'][] =
    [
      ['Total chunks', (s) => s.totalChunks, 'count'],
      ['Total size', (s) => s.totalSize, 'bytes'],
      ['Initial chunks', (s) => s.initialChunks, 'count'],
      ['Initial size', (s) => s.initialSize, 'bytes'],
      ['Lazy chunks', (s) => s.lazyChunks, 'count'],
      ['Lazy size', (s) => s.lazySize, 'bytes'],
    ];
  for (const [label, get, kind] of totalRows) {
    tbody.append(buildTotalsRow(label, a, b, get, kind));
  }
  frag.append(totalsTable);

  const allEntries = mergeEntries(a, b);
  if (allEntries.length === 0) {
    frag.append(el('p', { class: 'empty' }, 'No entry chunks detected.'));
    return frag;
  }

  const isStatic = (row: EntryRow) =>
    !!(row.av?.isStatic ?? row.bv?.isStatic);
  const dynamicCount = allEntries.filter((r) => !isStatic(r)).length;
  const query = entryDynamicSearch.trim().toLowerCase();
  const matchesSearch = (row: EntryRow): boolean => {
    if (!query) return false;
    if (row.name.toLowerCase().includes(query)) return true;
    const facade = row.av?.facadeModuleId ?? row.bv?.facadeModuleId ?? '';
    return facade.toLowerCase().includes(query);
  };
  const visible = allEntries.filter((r) => isStatic(r) || matchesSearch(r));

  const subtitleRow = el('div', { class: 'analysis-subtitle-row' });
  subtitleRow.append(el('h3', { class: 'analysis-subtitle' }, 'Per entry'));
  const hint = query
    ? `${visible.length - allEntries.filter(isStatic).length} dynamic match${
        visible.length - allEntries.filter(isStatic).length === 1 ? '' : 'es'
      }`
    : `${dynamicCount} dynamic entrypoint${
        dynamicCount === 1 ? '' : 's'
      } hidden — search to show`;
  subtitleRow.append(el('span', { class: 'analysis-subtitle-hint' }, hint));
  frag.append(subtitleRow);
  frag.append(renderDynamicSearchBox());

  if (visible.length === 0) {
    frag.append(el('p', { class: 'empty' }, 'No entries match.'));
    return frag;
  }
  const list = el('ul', { class: 'entry-list' });
  for (const { name, av, bv } of visible) {
    list.append(
      renderEntryCard(name, av, bv, {
        demotedOnA: !av && nonEntryNamesA.has(name),
        demotedOnB: !bv && nonEntryNamesB.has(name),
      }),
    );
  }
  frag.append(list);
  return frag;
}

function renderDynamicSearchBox(): HTMLElement {
  const wrap = el('div', { class: 'entry-search' });
  const input = document.createElement('input');
  input.type = 'search';
  input.placeholder = 'Search dynamic entrypoints (name or path)';
  input.className = 'entry-search-input';
  input.value = entryDynamicSearch;
  input.addEventListener('input', () => {
    entryDynamicSearch = input.value;
    void persistState();
    maybeRenderEntryAnalysis();
    // Restore focus + caret position after the section was replaced.
    const next = document
      .getElementById('entry-analysis')
      ?.querySelector<HTMLInputElement>('.entry-search-input');
    if (next) {
      next.focus();
      const len = next.value.length;
      next.setSelectionRange(len, len);
    }
  });
  wrap.append(input);
  return wrap;
}

function buildTotalsHead(): HTMLElement {
  const thead = el('thead');
  const tr = el('tr');
  tr.append(
    el('th', {}, ''),
    el('th', { class: 'col-side col-a' }, 'A'),
    el('th', { class: 'col-side col-b' }, 'B'),
    el('th', { class: 'col-delta' }, 'Δ'),
  );
  thead.append(tr);
  return thead;
}

function buildTotalsRow(
  label: string,
  a: SideAnalysis | undefined,
  b: SideAnalysis | undefined,
  get: (s: SideAnalysis) => number,
  kind: 'count' | 'bytes',
): HTMLElement {
  const tr = el('tr');
  const av = a ? get(a) : null;
  const bv = b ? get(b) : null;
  tr.append(
    el('th', { class: 'row-label' }, label),
    el('td', { class: 'col-side col-a' }, av === null ? '—' : fmt(av, kind)),
    el('td', { class: 'col-side col-b' }, bv === null ? '—' : fmt(bv, kind)),
    deltaCell(av, bv, kind),
  );
  return tr;
}

function deltaCell(
  av: number | null,
  bv: number | null,
  kind: 'count' | 'bytes',
): HTMLElement {
  if (av === null || bv === null) {
    return el('td', { class: 'col-delta' }, '—');
  }
  const d = bv - av;
  const cls =
    d === 0 ? 'col-delta zero' : d > 0 ? 'col-delta pos' : 'col-delta neg';
  return el(
    'td',
    { class: cls },
    d === 0
      ? '±0'
      : `${d > 0 ? '+' : '−'}${fmt(Math.abs(d), kind)}`,
  );
}

interface EntryRow {
  name: string;
  av?: EntryAnalysis;
  bv?: EntryAnalysis;
}

function mergeEntries(
  a: SideAnalysis | undefined,
  b: SideAnalysis | undefined,
): EntryRow[] {
  const map = new Map<string, EntryRow>();
  if (a) for (const e of a.entries) map.set(e.entry, { name: e.entry, av: e });
  if (b) {
    for (const e of b.entries) {
      const row = map.get(e.entry);
      if (row) row.bv = e;
      else map.set(e.entry, { name: e.entry, bv: e });
    }
  }
  return [...map.values()].sort((x, y) => x.name.localeCompare(y.name));
}

function renderEntryCard(
  name: string,
  av: EntryAnalysis | undefined,
  bv: EntryAnalysis | undefined,
  demoted: { demotedOnA: boolean; demotedOnB: boolean } = {
    demotedOnA: false,
    demotedOnB: false,
  },
): HTMLElement {
  const li = el('li', { class: 'entry-card' });
  const header = el('div', { class: 'entry-card-header' });
  header.append(el('span', { class: 'entry-card-name' }, name));
  const sample = av ?? bv;
  const kind: 'static' | 'dynamic' = sample?.isStatic ? 'static' : 'dynamic';
  header.append(
    el('span', { class: `entry-card-kind kind-${kind}` }, kind),
  );
  const presenceText = formatEntryPresence(av, bv, demoted);
  header.append(
    el('span', { class: 'entry-card-presence' }, presenceText),
  );
  if ((av ?? bv)?.facadeModuleId) {
    header.append(
      el(
        'code',
        { class: 'entry-card-facade' },
        (av ?? bv)!.facadeModuleId!,
      ),
    );
  }
  li.append(header);

  const tbl = el('table', { class: 'analysis-table entry-table' });
  const tbody = el('tbody');
  tbl.append(buildTotalsHead(), tbody);
  const rows: [string, (e: EntryAnalysis) => number, 'count' | 'bytes'][] = [
    ['Initial chunks', (e) => e.initialChunks, 'count'],
    ['Initial size', (e) => e.initialSize, 'bytes'],
    ['Lazy chunks', (e) => e.lazyChunks, 'count'],
    ['Lazy size', (e) => e.lazySize, 'bytes'],
  ];
  for (const [label, get, kind] of rows) {
    const a = av ? get(av) : null;
    const b = bv ? get(bv) : null;
    const tr = el('tr');
    tr.append(
      el('th', { class: 'row-label' }, label),
      el('td', { class: 'col-side col-a' }, a === null ? '—' : fmt(a, kind)),
      el('td', { class: 'col-side col-b' }, b === null ? '—' : fmt(b, kind)),
      deltaCell(a, b, kind),
    );
    tbody.append(tr);
  }
  li.append(tbl);
  return li;
}

function fmt(n: number, kind: 'count' | 'bytes'): string {
  if (kind === 'count') return String(n);
  return formatBytes(n);
}

function formatEntryPresence(
  av: EntryAnalysis | undefined,
  bv: EntryAnalysis | undefined,
  demoted: { demotedOnA: boolean; demotedOnB: boolean },
): string {
  const aLabel = av ? 'A' : demoted.demotedOnA ? 'A (non-entry)' : null;
  const bLabel = bv ? 'B' : demoted.demotedOnB ? 'B (non-entry)' : null;
  const parts = [aLabel, bLabel].filter(Boolean) as string[];
  return `present on ${parts.join(' & ')}`;
}

function maybeRenderModuleDiff() {
  const section = document.getElementById('module-diff')!;
  const aStats = state.a.stats;
  const bStats = state.b.stats;
  if (!aStats || !bStats) {
    section.hidden = true;
    section.replaceChildren();
    return;
  }
  const result = compareModules(aStats.data, bStats.data, renamedPairs);
  section.hidden = false;
  section.replaceChildren(renderModuleDiff(result));
}

function renderModuleDiff(r: ModuleComparisonResult): Node {
  const frag = document.createDocumentFragment();

  const header = el('div', { class: 'module-diff-header' });
  header.append(el('h2', {}, 'Module diff'));
  header.append(
    el(
      'p',
      { class: 'module-diff-note' },
      'Source modules matched by id across the two bundle-stats files. Moved = present on both sides but landed in differently-named chunks.',
    ),
  );
  frag.append(header);

  const summary = el('section', { class: 'summary' });
  summary.append(
    statCard('Total modules', r.totalA, r.totalB),
    statCard('Only in A', r.onlyA.length, null, 'only-a'),
    statCard('Only in B', null, r.onlyB.length, 'only-b'),
    statCard('Moved', r.moved.length, null, 'changed'),
    statCard('Identical', r.same.length, null, 'same'),
  );
  frag.append(summary);

  const sumSingle = (xs: ModuleEntry[]) =>
    xs.reduce((s, m) => s + m.size, 0);
  const sumMovedA = r.moved.reduce((s, m) => s + m.sizeA, 0);
  const sumMovedB = r.moved.reduce((s, m) => s + m.sizeB, 0);

  frag.append(
    moduleSection(
      'Only in A',
      'only-a',
      r.onlyA,
      false,
      (m) => moduleRow(m, 'A'),
      moduleEntryToMd,
      formatBytes(sumSingle(r.onlyA)),
    ),
    moduleSection(
      'Only in B',
      'only-b',
      r.onlyB,
      false,
      (m) => moduleRow(m, 'B'),
      moduleEntryToMd,
      formatBytes(sumSingle(r.onlyB)),
    ),
    moduleSection(
      'Moved between chunks',
      'changed',
      r.moved,
      false,
      (m) => movedRow(m),
      movedEntryToMd,
      `${formatBytes(sumMovedA)} → ${formatBytes(sumMovedB)}`,
    ),
    moduleSection(
      'Identical',
      'same',
      r.same,
      false,
      (m) => moduleRow(m),
      moduleEntryToMd,
      formatBytes(sumSingle(r.same)),
    ),
  );

  return frag;
}

function moduleSection<T>(
  title: string,
  variant: string,
  items: T[],
  openByDefault: boolean,
  render: (item: T) => HTMLElement,
  toMd: (item: T) => string,
  sizeLabel?: string,
): HTMLElement {
  const details = el('details', {
    class: `section section-${variant}`,
  }) as HTMLDetailsElement;
  if (openByDefault) details.open = true;
  const summary = el('summary');
  summary.append(
    el('span', { class: 'section-title' }, title),
    el('span', { class: 'section-count' }, String(items.length)),
  );
  if (sizeLabel && items.length > 0) {
    summary.append(el('span', { class: 'section-size' }, sizeLabel));
  }
  summary.append(copyMarkdownButton(() => mdList(title, items.map(toMd))));
  details.append(summary);
  if (items.length === 0) {
    details.append(el('p', { class: 'empty' }, 'None.'));
    return details;
  }
  const ul = el('ul', { class: 'module-list' });
  for (const item of items) ul.append(render(item));
  details.append(ul);
  return details;
}

function moduleRow(m: ModuleEntry, side?: 'A' | 'B'): HTMLElement {
  const li = el('li', { class: 'module-row clickable' });
  li.append(el('code', { class: 'module-id' }, m.id));
  const meta = el('span', { class: 'module-meta' });
  if (side) {
    meta.append(el('span', { class: `pill side-${side.toLowerCase()}` }, side));
  }
  meta.append(
    el('span', { class: 'module-chunk' }, `chunk: ${m.chunk}`),
    el('span', { class: 'module-size' }, formatBytes(m.size)),
  );
  li.append(meta);
  const targetSide: Side = side === 'B' ? 'b' : 'a';
  li.addEventListener('click', () => openInspector(targetSide, m.id));
  return li;
}

function movedRow(m: MovedModule): HTMLElement {
  const li = el('li', { class: 'module-row clickable' });
  li.append(el('code', { class: 'module-id' }, m.id));
  const meta = el('span', { class: 'module-meta' });
  meta.append(
    el('span', { class: 'chunk-from' }, m.fromChunk),
    el('span', { class: 'chunk-arrow' }, '→'),
    el('span', { class: 'chunk-to' }, m.toChunk),
    el(
      'span',
      { class: 'module-size' },
      `${formatBytes(m.sizeA)} → ${formatBytes(m.sizeB)}`,
    ),
  );
  li.append(meta);
  li.addEventListener('click', () => openInspector('a', m.id));
  return li;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function moduleEntryToMd(m: ModuleEntry): string {
  return `\`${m.id}\` (chunk: \`${m.chunk}\`, ${formatBytes(m.size)})`;
}

function movedEntryToMd(m: MovedModule): string {
  return `\`${m.id}\`: \`${m.fromChunk}\` → \`${m.toChunk}\` (${formatBytes(m.sizeA)} → ${formatBytes(m.sizeB)})`;
}

function mdList(title: string, lines: string[]): string {
  const header = `## ${title} (${lines.length})`;
  if (lines.length === 0) return `${header}\n\n_None._\n`;
  return `${header}\n\n${lines.map((l) => `- ${l}`).join('\n')}\n`;
}

function copyMarkdownButton(getMarkdown: () => string): HTMLElement {
  const btn = el('button', {
    class: 'copy-md-btn',
    type: 'button',
    title: 'Copy this list as Markdown',
  });
  btn.textContent = 'Copy MD';
  btn.addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    const ok = await copyToClipboard(getMarkdown());
    btn.textContent = ok ? 'Copied' : 'Failed';
    setTimeout(() => {
      btn.textContent = 'Copy MD';
    }, 1200);
  });
  return btn;
}

async function copyToClipboard(text: string): Promise<boolean> {
  if (window.isSecureContext && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // fall through to legacy path
    }
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '0';
    ta.style.left = '0';
    ta.style.width = '1px';
    ta.style.height = '1px';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    ta.setSelectionRange(0, text.length);
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

function maybeRenderGraph() {
  const section = document.getElementById('graph-section')!;
  if (!state.a.stats && !state.b.stats) {
    section.hidden = true;
    section.replaceChildren();
    return;
  }
  section.hidden = false;
  section.replaceChildren(renderGraphSection());
}

function renderGraphSection(): Node {
  const frag = document.createDocumentFragment();
  const header = el('div', { class: 'graph-header' });
  header.append(el('h2', {}, 'Module / chunk graph'));
  header.append(
    el(
      'p',
      { class: 'graph-note' },
      'Each outlined cluster is a chunk; small squares inside are the source modules it bundles. Edges follow chunk-level imports (solid = static, dashed = dynamic). Modules are coloured by status: same chunk on both sides, moved to a different chunk, or only present on this side.',
    ),
  );

  const toolbar = el('div', { class: 'graph-toolbar' });
  toolbar.append(
    sideButton('a', 'Side A', !state.a.stats),
    sideButton('b', 'Side B', !state.b.stats),
    hideUnchangedToggle(),
    moduleSearchBox(),
    resetHiddenButton(),
    el('span', { class: 'graph-legend' }),
  );
  const legend = toolbar.querySelector('.graph-legend')!;
  legend.append(
    legendSwatch('module-same', 'same chunk'),
    legendSwatch('module-moved', 'moved'),
    legendSwatch('module-only-here', 'only on this side'),
  );
  header.append(toolbar);
  frag.append(header);

  const canvas = el('div', { class: 'graph-canvas' });
  frag.append(canvas);
  const hiddenList = el('div', { class: 'hidden-chunks' });
  frag.append(hiddenList);

  const sideStats = state[graphView].stats;
  if (!sideStats) {
    canvas.append(
      el(
        'div',
        { class: 'graph-empty' },
        `No bundle-stats.json loaded for side ${graphView.toUpperCase()}.`,
      ),
    );
    return frag;
  }
  const otherStats = state[graphView === 'a' ? 'b' : 'a'].stats?.data;
  const bothSidesPresent = !!(state.a.stats && state.b.stats);
  const graph: SideGraph = buildSideGraph(
    graphView,
    sideStats.data,
    otherStats,
    1400,
    900,
    {
      hideUnchanged: graphHideUnchanged && bothSidesPresent,
      renamedChunks: bothSidesPresent ? renamedPairs : [],
    },
  );
  renderGraph(canvas, graph, {
    onModuleClick: (moduleId) => openInspector(graphView, moduleId),
  });
  applyGraphSearch();
  renderHiddenChunksList(hiddenList, canvas);
  return frag;
}

function renderHiddenChunksList(host: HTMLElement, canvas: HTMLElement): void {
  host.replaceChildren();
  const names = getHiddenChunkNames();
  if (names.length === 0) return;
  host.append(
    el(
      'div',
      { class: 'hidden-chunks-label' },
      `Hidden chunks (${names.length})`,
    ),
  );
  const list = el('ul', { class: 'hidden-chunks-list' });
  for (const name of names) {
    const li = el('li', { class: 'hidden-chunks-item' });
    li.append(el('code', {}, name));
    const btn = el('button', {
      class: 'hidden-chunks-show',
      type: 'button',
      title: `Show ${name} again`,
    });
    btn.textContent = 'Show';
    btn.addEventListener('click', () => {
      unhideChunk(name, canvas);
    });
    li.append(btn);
    list.append(li);
  }
  host.append(list);
}

function moduleSearchBox(): HTMLElement {
  const wrap = el('div', { class: 'graph-search' });
  const input = document.createElement('input');
  input.type = 'search';
  input.className = 'graph-search-input';
  input.placeholder = 'Find module…';
  input.value = graphModuleSearch;
  const count = el('span', { class: 'graph-search-count' });
  input.addEventListener('input', () => {
    graphModuleSearch = input.value;
    applyGraphSearch();
  });
  wrap.append(input, count);
  return wrap;
}

function applyGraphSearch(): void {
  const canvas = document.querySelector('.graph-canvas') as HTMLElement | null;
  const countEl = document.querySelector(
    '.graph-search-count',
  ) as HTMLElement | null;
  if (!canvas) return;
  const q = graphModuleSearch.trim().toLowerCase();
  const rects = canvas.querySelectorAll<SVGRectElement>('[data-module-id]');
  let matches = 0;
  for (const rect of rects) {
    const id = (rect.getAttribute('data-module-id') ?? '').toLowerCase();
    if (q && id.includes(q)) {
      rect.classList.add('module-match');
      matches++;
    } else {
      rect.classList.remove('module-match');
    }
  }
  if (countEl) {
    countEl.textContent = q
      ? `${matches} match${matches === 1 ? '' : 'es'}`
      : '';
  }
}

function resetHiddenButton(): HTMLElement {
  const btn = el('button', {
    class: 'graph-tab reset-hidden-btn',
    type: 'button',
    title: 'Restore all clusters and edges hidden via right-click',
  });
  btn.textContent = 'Reset manually hidden';
  btn.hidden = !hasGraphHiding();
  btn.addEventListener('click', () => {
    const canvas = document.querySelector('.graph-canvas') as HTMLElement | null;
    if (canvas) resetGraphHiding(canvas);
  });
  return btn;
}

document.addEventListener('graph:hidden-changed', () => {
  const visible = hasGraphHiding();
  document
    .querySelectorAll<HTMLButtonElement>('.reset-hidden-btn')
    .forEach((b) => {
      b.hidden = !visible;
    });
  const host = document.querySelector<HTMLElement>('.hidden-chunks');
  const canvas = document.querySelector<HTMLElement>('.graph-canvas');
  if (host && canvas) renderHiddenChunksList(host, canvas);
  void persistState();
});

function hideUnchangedToggle(): HTMLElement {
  const bothSides = !!(state.a.stats && state.b.stats);
  const btn = el('button', {
    class: `graph-tab toggle${graphHideUnchanged && bothSides ? ' active' : ''}`,
    type: 'button',
    'aria-pressed': String(graphHideUnchanged && bothSides),
  });
  btn.textContent = 'Hide unchanged chunks';
  if (!bothSides) {
    btn.setAttribute('disabled', 'true');
    btn.title =
      'Upload bundle-stats on both sides to compute which chunks are unchanged';
  }
  btn.addEventListener('click', () => {
    if (!bothSides) return;
    graphHideUnchanged = !graphHideUnchanged;
    maybeRenderGraph();
    void persistState();
  });
  return btn;
}

function sideButton(side: Side, label: string, disabled: boolean): HTMLElement {
  const btn = el('button', {
    class: `graph-tab${graphView === side ? ' active' : ''}`,
    type: 'button',
  });
  btn.textContent = label;
  if (disabled) {
    btn.setAttribute('disabled', 'true');
    btn.title = 'No bundle-stats.json uploaded for this side';
  }
  btn.addEventListener('click', () => {
    if (graphView === side) return;
    graphView = side;
    maybeRenderGraph();
    void persistState();
  });
  return btn;
}

function legendSwatch(klass: string, text: string): HTMLElement {
  const span = el('span', { class: 'legend-item' });
  span.append(
    el('span', { class: `legend-swatch ${klass}` }),
    el('span', {}, text),
  );
  return span;
}

function renderResult(
  r: ComparisonResult,
  filenameA: string,
  filenameB: string,
  sizesA: Map<string, number>,
  sizesB: Map<string, number>,
): Node {
  const frag = document.createDocumentFragment();

  const header = el('div', { class: 'chunk-diff-header' });
  header.append(el('h2', {}, 'Chunk diff'));
  header.append(
    el(
      'p',
      { class: 'chunk-diff-note' },
      'Per-chunk comparison between the two bundle-stats files. Renamed/re-keyed chunks are auto-paired and folded into Changed or Identical.',
    ),
  );
  frag.append(header);

  const summary = el('section', { class: 'summary' });
  summary.append(
    statCard('Total chunks', r.totalA, r.totalB),
    statCard('Entry chunks', r.entryCountA, r.entryCountB),
    statCard('Dynamic entries', r.dynamicEntryCountA, r.dynamicEntryCountB),
    statCard('Only in A', r.onlyA.length, null, 'only-a'),
    statCard('Only in B', null, r.onlyB.length, 'only-b'),
    statCard('Changed', r.changed.length, null, 'changed'),
    statCard('Identical', r.same.length, null, 'same'),
  );
  frag.append(summary);

  const filenames = el('div', { class: 'filenames' });
  filenames.append(
    el('span', { class: 'pill side-a' }, `A: ${filenameA}`),
    el('span', { class: 'pill side-b' }, `B: ${filenameB}`),
  );
  frag.append(filenames);

  frag.append(
    section('Only in A', r.onlyA, 'only-a', false, sizesA, sizesB),
    section('Only in B', r.onlyB, 'only-b', false, sizesA, sizesB),
    section('Changed', r.changed, 'changed', false, sizesA, sizesB),
    section('Identical', r.same, 'same', false, sizesA, sizesB),
  );

  return frag;
}

function statCard(
  label: string,
  aValue: number | null,
  bValue: number | null,
  variant?: string,
): HTMLElement {
  const card = el('div', { class: `stat${variant ? ` stat-${variant}` : ''}` });
  card.append(el('div', { class: 'stat-label' }, label));
  if (aValue !== null && bValue !== null) {
    const delta = bValue - aValue;
    const deltaStr = delta === 0 ? '±0' : delta > 0 ? `+${delta}` : `${delta}`;
    const row = el('div', { class: 'stat-row' });
    row.append(
      el('span', { class: 'stat-num side-a' }, String(aValue)),
      el('span', { class: 'stat-arrow' }, '→'),
      el('span', { class: 'stat-num side-b' }, String(bValue)),
      el(
        'span',
        {
          class: `stat-delta ${delta === 0 ? 'zero' : delta > 0 ? 'pos' : 'neg'}`,
        },
        deltaStr,
      ),
    );
    card.append(row);
  } else {
    const value = aValue ?? bValue ?? 0;
    card.append(el('div', { class: 'stat-num' }, String(value)));
  }
  return card;
}

function section(
  title: string,
  entries: EntryDiff[],
  variant: string,
  openByDefault: boolean,
  sizesA: Map<string, number>,
  sizesB: Map<string, number>,
): HTMLElement {
  const details = el('details', {
    class: `section section-${variant}`,
  }) as HTMLDetailsElement;
  if (openByDefault) details.open = true;
  const summary = el('summary');
  let totalA = 0;
  let totalB = 0;
  for (const e of entries) {
    totalA += sizesA.get(e.aKey ?? e.key) ?? 0;
    totalB += sizesB.get(e.bKey ?? e.key) ?? 0;
  }
  const totalLabel = sectionTotalLabel(variant, totalA, totalB);
  summary.append(
    el('span', { class: 'section-title' }, title),
    el('span', { class: 'section-count' }, String(entries.length)),
  );
  if (totalLabel) {
    summary.append(el('span', { class: 'section-size' }, totalLabel));
  }
  summary.append(
    copyMarkdownButton(() =>
      mdList(
        title,
        entries.map((e) => entryDiffToMd(e, sizesA, sizesB)),
      ),
    ),
  );
  details.append(summary);

  if (entries.length === 0) {
    details.append(el('p', { class: 'empty' }, 'None.'));
    return details;
  }

  const list = el('ul', { class: 'entries' });
  for (const entry of entries) list.append(renderEntry(entry, sizesA, sizesB));
  details.append(list);
  return details;
}

function sectionTotalLabel(
  variant: string,
  totalA: number,
  totalB: number,
): string {
  if (variant === 'only-a') return formatBytes(totalA);
  if (variant === 'only-b') return formatBytes(totalB);
  return `${formatBytes(totalA)} → ${formatBytes(totalB)}`;
}

function entryDiffToMd(
  e: EntryDiff,
  sizesA: Map<string, number>,
  sizesB: Map<string, number>,
): string {
  const sizeA = sizesA.get(e.aKey ?? e.key);
  const sizeB = sizesB.get(e.bKey ?? e.key);
  let line =
    e.aKey && e.bKey && e.aKey !== e.bKey
      ? `\`${e.key}\` (\`${e.aKey}\` → \`${e.bKey}\`)`
      : `\`${e.key}\``;
  const sizeStr = formatSizeChange(e.status, sizeA, sizeB);
  if (sizeStr) line += ` (${sizeStr})`;
  if (e.status === 'changed' && e.changes.length) {
    line += ` — ${e.changes.join('; ')}`;
  }
  return line;
}

function formatSizeChange(
  status: 'same' | 'changed' | 'only-a' | 'only-b',
  sizeA: number | undefined,
  sizeB: number | undefined,
): string | null {
  if (status === 'only-a' && sizeA != null) return formatBytes(sizeA);
  if (status === 'only-b' && sizeB != null) return formatBytes(sizeB);
  if (sizeA != null && sizeB != null) {
    if (sizeA === sizeB) return formatBytes(sizeA);
    const delta = sizeB - sizeA;
    const sign = delta > 0 ? '+' : '−';
    return `${formatBytes(sizeA)} → ${formatBytes(sizeB)} (${sign}${formatBytes(Math.abs(delta))})`;
  }
  return null;
}

function renderEntry(
  entry: EntryDiff,
  sizesA: Map<string, number>,
  sizesB: Map<string, number>,
): HTMLElement {
  const li = el('li', { class: `entry entry-${entry.status}` });
  const header = el('div', { class: 'entry-header' });
  header.append(el('code', { class: 'entry-key' }, entry.key));
  if (entry.aKey && entry.bKey && entry.aKey !== entry.bKey) {
    header.append(
      el(
        'span',
        { class: 'entry-meta' },
        `re-keyed: ${entry.aKey} → ${entry.bKey}`,
      ),
    );
  }

  const meta: string[] = [];
  const e = entry.a ?? entry.b;
  if (e?.isEntry) meta.push('entry');
  if (e?.isDynamicEntry) meta.push('dynamic');
  if (e?.name) meta.push(`name=${e.name}`);
  if (meta.length) {
    header.append(el('span', { class: 'entry-meta' }, meta.join(' · ')));
  }
  const sizeStr = formatSizeChange(
    entry.status,
    sizesA.get(entry.aKey ?? entry.key),
    sizesB.get(entry.bKey ?? entry.key),
  );
  if (sizeStr) {
    header.append(el('span', { class: 'entry-size' }, sizeStr));
  }
  li.append(header);

  if (entry.status === 'changed' && entry.changes.length) {
    const ul = el('ul', { class: 'changes' });
    for (const c of entry.changes) ul.append(el('li', {}, c));
    li.append(ul);
  }

  if (entry.a || entry.b) {
    const grid = el('div', { class: 'entry-grid' });
    grid.append(entryColumn('A', entry.a), entryColumn('B', entry.b));
    li.append(grid);
  }

  return li;
}

function entryColumn(
  label: string,
  e: ManifestEntry | undefined,
): HTMLElement {
  const col = el('div', { class: `entry-col side-${label.toLowerCase()}` });
  col.append(el('div', { class: 'entry-col-label' }, label));
  if (!e) {
    col.append(el('div', { class: 'entry-col-empty' }, '— absent —'));
    return col;
  }
  const dl = el('dl');
  appendKV(dl, 'file', e.file);
  if (e.imports?.length) appendKV(dl, 'imports', e.imports.join(', '));
  if (e.dynamicImports?.length)
    appendKV(dl, 'dynamicImports', e.dynamicImports.join(', '));
  if (e.css?.length) appendKV(dl, 'css', `${e.css.length} file(s)`);
  if (e.assets?.length) appendKV(dl, 'assets', `${e.assets.length} file(s)`);
  col.append(dl);
  return col;
}

function appendKV(dl: HTMLElement, k: string, v: string) {
  dl.append(el('dt', {}, k), el('dd', {}, v));
}

function el(
  tag: string,
  attrs: Record<string, string> = {},
  text?: string,
): HTMLElement {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (text !== undefined) node.textContent = text;
  return node;
}

interface InspectorState {
  side: Side;
  moduleId: string;
}
let inspector: InspectorState | null = null;

function openInspector(side: Side, moduleId: string) {
  if (
    inspector &&
    inspector.side === side &&
    inspector.moduleId === moduleId
  ) {
    closeInspector();
    return;
  }
  inspector = { side, moduleId };
  renderInspector();
}

function closeInspector() {
  inspector = null;
  const host = document.getElementById('inspector')!;
  host.hidden = true;
  host.replaceChildren();
}

function renderInspector() {
  const host = document.getElementById('inspector')!;
  if (!inspector) {
    host.hidden = true;
    host.replaceChildren();
    return;
  }
  const { side, moduleId } = inspector;
  host.hidden = false;
  host.replaceChildren(buildInspectorContent(side, moduleId));
}

function buildInspectorContent(side: Side, moduleId: string): Node {
  const frag = document.createDocumentFragment();

  const header = el('header', { class: 'inspector-header' });
  header.append(el('h3', { class: 'inspector-title' }, 'Why included?'));
  const close = el('button', {
    class: 'inspector-close',
    type: 'button',
    'aria-label': 'Close',
  });
  close.textContent = '×';
  close.addEventListener('click', closeInspector);
  header.append(close);
  frag.append(header);

  const body = el('div', { class: 'inspector-body' });

  body.append(el('div', { class: 'inspector-id-label' }, 'Module'));
  body.append(el('code', { class: 'inspector-id' }, moduleId));

  const sideToggle = el('div', { class: 'inspector-side-toggle' });
  for (const s of ['a', 'b'] as const) {
    const ctx = getTraceContext(s);
    const inSide = ctx?.moduleToChunk.has(moduleId);
    const btn = el('button', {
      class: `graph-tab${side === s ? ' active' : ''}`,
      type: 'button',
    });
    btn.textContent = `Side ${s.toUpperCase()}`;
    if (!inSide) {
      btn.setAttribute('disabled', 'true');
      btn.title = ctx
        ? 'Module not present on this side'
        : 'No bundle-stats.json uploaded for this side';
    }
    btn.addEventListener('click', () => {
      if (!inSide) return;
      inspector = { side: s, moduleId };
      renderInspector();
    });
    sideToggle.append(btn);
  }
  body.append(sideToggle);

  const ctx = getTraceContext(side);
  if (!ctx) {
    body.append(
      el(
        'p',
        { class: 'inspector-note' },
        `No bundle-stats.json loaded for side ${side.toUpperCase()}.`,
      ),
    );
  } else if (!ctx.moduleToChunk.has(moduleId)) {
    body.append(
      el(
        'p',
        { class: 'inspector-note' },
        `Module not present on side ${side.toUpperCase()}.`,
      ),
    );
  } else {
    const chunk = ctx.moduleToChunk.get(moduleId)!;
    body.append(
      el('div', { class: 'inspector-section-label' }, 'In chunk'),
      el('div', { class: 'inspector-chunk' }, chunk),
    );

    if (!ctx.hasImportData) {
      body.append(
        el(
          'p',
          { class: 'inspector-note warn' },
          'This bundle-stats.json was built before module-import data was captured. Rebuild with the latest plugin to enable import-path tracing.',
        ),
      );
    } else {
      const navigate = (id: string) => openInspector(side, id);
      const paths = tracePaths(ctx, moduleId, 5);
      const pathsHeader = el('div', { class: 'inspector-section-row' });
      pathsHeader.append(
        el('div', { class: 'inspector-section-label' }, 'Import paths'),
        renderArrowLegend(),
      );
      body.append(pathsHeader);
      if (paths.length === 0) {
        if (ctx.entryModules.has(moduleId)) {
          body.append(
            el(
              'p',
              { class: 'inspector-note' },
              'This module is itself an entry — it is the root.',
            ),
          );
        } else {
          body.append(
            el(
              'p',
              { class: 'inspector-note' },
              'No import path found from any entry. The module may be an orphan or only reached via a non-recorded path.',
            ),
          );
        }
      } else {
        const list = el('ol', { class: 'inspector-paths' });
        for (const p of paths) list.append(renderTracePath(p, navigate));
        body.append(list);
      }

      const deps = ctx.imports.get(moduleId) ?? [];
      body.append(
        el(
          'div',
          { class: 'inspector-section-label' },
          `Imports (${deps.length})`,
        ),
      );
      if (deps.length === 0) {
        body.append(
          el(
            'p',
            { class: 'inspector-note' },
            'This module has no recorded imports of other bundled modules.',
          ),
        );
      } else {
        const ul = el('ul', { class: 'inspector-deps' });
        for (const d of deps) ul.append(renderDepRow(d, ctx, navigate));
        body.append(ul);
      }
    }
  }

  frag.append(body);
  return frag;
}

function renderTracePath(
  p: TracePath,
  onNodeClick: (id: string) => void,
): HTMLElement {
  const li = el('li', { class: 'trace-path' });
  const headerLine = el('div', { class: 'trace-header' });
  headerLine.append(
    el('span', { class: 'trace-root-label' }, 'entry'),
    el('span', { class: 'trace-root-chunk' }, p.rootChunk),
  );
  li.append(headerLine);

  const chain = el('div', { class: 'trace-chain' });
  if (p.edges.length === 0) {
    chain.append(traceNode(p.rootEntry, onNodeClick));
  } else {
    chain.append(traceNode(p.edges[0].from, onNodeClick));
    for (const e of p.edges) {
      chain.append(arrowSpan(e.kind));
      chain.append(traceNode(e.to, onNodeClick));
    }
  }
  li.append(chain);
  return li;
}

function traceNode(id: string, onClick: (id: string) => void): HTMLElement {
  const node = el('code', { class: 'trace-node clickable', tabindex: '0' }, id);
  node.addEventListener('click', () => onClick(id));
  node.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onClick(id);
    }
  });
  return node;
}

function arrowSpan(kind: 'static' | 'dynamic'): HTMLElement {
  return el(
    'span',
    { class: `trace-arrow trace-arrow-${kind}` },
    kind === 'dynamic' ? '⤳' : '→',
  );
}

function renderArrowLegend(): HTMLElement {
  const wrap = el('span', { class: 'inspector-legend' });
  const staticItem = el('span', { class: 'legend-pair' });
  staticItem.append(arrowSpan('static'), el('span', {}, 'static'));
  const dynamicItem = el('span', { class: 'legend-pair' });
  dynamicItem.append(arrowSpan('dynamic'), el('span', {}, 'dynamic'));
  wrap.append(staticItem, dynamicItem);
  return wrap;
}

function renderDepRow(
  dep: { id: string; kind: 'static' | 'dynamic' },
  ctx: TraceContext,
  onClick: (id: string) => void,
): HTMLElement {
  const li = el('li', { class: 'dep-row' });
  li.append(arrowSpan(dep.kind), traceNode(dep.id, onClick));
  const chunk = ctx.moduleToChunk.get(dep.id);
  if (chunk) {
    li.append(el('span', { class: 'dep-chunk' }, chunk));
  }
  return li;
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeInspector();
});

function mountClearButton() {
  const host = document.querySelector('.uploaders');
  if (!host) return;
  const wrap = el('div', { class: 'uploaders-toolbar' });
  const btn = el('button', { class: 'clear-btn', type: 'button' }, 'Clear all');
  btn.addEventListener('click', () => clearAll());
  wrap.append(btn);
  host.parentNode!.insertBefore(wrap, host.nextSibling);
}

async function init() {
  mountClearButton();
  const persisted = await loadPersisted();
  if (persisted) {
    if (persisted.graphView === 'a' || persisted.graphView === 'b') {
      graphView = persisted.graphView;
    }
    if (typeof persisted.graphHideUnchanged === 'boolean') {
      graphHideUnchanged = persisted.graphHideUnchanged;
    }
    if (typeof persisted.entryDynamicSearch === 'string') {
      entryDynamicSearch = persisted.entryDynamicSearch;
    }
    if (Array.isArray(persisted.graphHiddenChunks)) {
      setHiddenChunkNames(persisted.graphHiddenChunks);
    }
    for (const side of ['a', 'b'] as const) {
      const ps = persisted[side];
      if (ps?.stats) {
        try {
          state[side].stats = {
            filename: ps.stats.filename,
            raw: ps.stats.raw,
            data: parseBundleStats(ps.stats.raw),
          };
        } catch (err) {
          console.warn(`vite-compare: failed to restore stats ${side}`, err);
        }
      }
    }
    for (const elNode of uploaders) {
      const side = elNode.dataset.side as Side;
      const status = elNode.querySelector<HTMLDivElement>('[data-status]')!;
      renderStatus(side, status, []);
    }
  }
  renderAll();
  setupSectionScrollSpy();
}

void init();
