import { chunkSize, type BundleStats, type BundleStatsChunk } from './compare';

export type ModuleStatus = 'same' | 'moved' | 'only-here';
export type ChunkStatus = 'same' | 'changed' | 'only-here';

export interface BuildGraphOptions {
  hideUnchanged?: boolean;
  /**
   * Detected chunk renames as [aName, bName] pairs. The graph treats each pair
   * as a single logical chunk so the renamed counterpart on the other side is
   * found for module-status and chunk-status computation.
   */
  renamedChunks?: Array<[string, string]>;
}

export interface ModuleNode {
  id: string;
  label: string;
  chunkKey: string;
  status: ModuleStatus;
  movedTo?: string;
  size: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ChunkCluster {
  key: string;
  name: string;
  fileName: string;
  isEntry: boolean;
  isDynamicEntry: boolean;
  facadeModuleId: string | null;
  status: ChunkStatus;
  size: number;
  modules: ModuleNode[];
  cx: number;
  cy: number;
  bx: number;
  by: number;
  bw: number;
  bh: number;
}

export interface ChunkEdge {
  source: string;
  target: string;
  kind: 'static' | 'dynamic';
}

export interface SideGraph {
  side: 'a' | 'b';
  clusters: ChunkCluster[];
  edges: ChunkEdge[];
  width: number;
  height: number;
}

const MOD_W = 14;
const MOD_H = 14;
const MOD_GAP = 4;
const CLUSTER_PADDING_X = 10;
const CLUSTER_PADDING_TOP = 22;
const CLUSTER_PADDING_BOTTOM = 8;
const CLUSTER_GAP = 50;
const VIRTUAL_LINK_STRENGTH = 0.25;

export function buildSideGraph(
  side: 'a' | 'b',
  thisStats: BundleStats,
  otherStats: BundleStats | undefined,
  width: number,
  height: number,
  opts: BuildGraphOptions = {},
): SideGraph {
  // Map a chunk name on this side to the equivalent name on the other side.
  // For renamed pairs the names differ; for everything else the identity.
  const renameToOther = new Map<string, string>();
  for (const [aName, bName] of opts.renamedChunks ?? []) {
    if (side === 'a') renameToOther.set(aName, bName);
    else renameToOther.set(bName, aName);
  }
  const translate = (n: string) => renameToOther.get(n) ?? n;

  const otherModuleToChunkName = new Map<string, string>();
  const otherChunksByName = new Map<string, BundleStatsChunk>();
  if (otherStats) {
    for (const ch of otherStats.chunks) {
      const name = ch.name || ch.fileName;
      otherChunksByName.set(name, ch);
      for (const m of ch.modules) {
        otherModuleToChunkName.set(m.id, name);
      }
    }
  }

  let clusters: ChunkCluster[] = thisStats.chunks.map((ch) =>
    buildCluster(
      ch,
      otherModuleToChunkName,
      otherChunksByName,
      !!otherStats,
      translate,
    ),
  );

  if (opts.hideUnchanged) {
    const recChanged = computeRecursivelyChanged(thisStats, clusters);
    clusters = clusters.filter((c) => recChanged.has(c.fileName));
  }

  const visibleKeys = new Set(clusters.map((c) => c.key));
  const edges: ChunkEdge[] = [];
  for (const ch of thisStats.chunks) {
    if (!visibleKeys.has(ch.fileName)) continue;
    for (const tgt of ch.imports) {
      if (!visibleKeys.has(tgt)) continue;
      edges.push({ source: ch.fileName, target: tgt, kind: 'static' });
    }
    for (const tgt of ch.dynamicImports) {
      if (!visibleKeys.has(tgt)) continue;
      edges.push({ source: ch.fileName, target: tgt, kind: 'dynamic' });
    }
  }

  const graph: SideGraph = { side, clusters, edges, width, height };
  layoutGraph(graph);
  return graph;
}

function buildCluster(
  ch: BundleStatsChunk,
  otherModuleToChunkName: Map<string, string>,
  otherChunksByName: Map<string, BundleStatsChunk>,
  hasOther: boolean,
  translate: (name: string) => string,
): ChunkCluster {
  const thisChunkName = ch.name || ch.fileName;
  const otherChunkName = translate(thisChunkName);
  let chunkStatus: ChunkStatus;
  if (!hasOther) {
    chunkStatus = 'same';
  } else {
    const otherChunk = otherChunksByName.get(otherChunkName);
    if (!otherChunk) {
      chunkStatus = 'only-here';
    } else {
      const thisIds = new Set(ch.modules.map((m) => m.id));
      const otherIds = new Set(otherChunk.modules.map((m) => m.id));
      const sameSize = thisIds.size === otherIds.size;
      const allMatch = sameSize && [...thisIds].every((id) => otherIds.has(id));
      chunkStatus = allMatch ? 'same' : 'changed';
    }
  }
  const modules: ModuleNode[] = ch.modules.map((m) => {
    let status: ModuleStatus;
    let movedTo: string | undefined;
    if (!hasOther) {
      status = 'same';
    } else {
      const otherName = otherModuleToChunkName.get(m.id);
      if (otherName === undefined) {
        status = 'only-here';
      } else if (otherName === otherChunkName) {
        status = 'same';
      } else {
        status = 'moved';
        movedTo = otherName;
      }
    }
    return {
      id: m.id,
      label: prettyId(m.id),
      chunkKey: ch.fileName,
      status,
      movedTo,
      size: m.renderedLength,
      x: 0,
      y: 0,
      width: MOD_W,
      height: MOD_H,
    };
  });

  const size = chunkSize(ch);

  return {
    key: ch.fileName,
    name: ch.name || ch.fileName,
    fileName: ch.fileName,
    isEntry: ch.isEntry,
    isDynamicEntry: ch.isDynamicEntry,
    facadeModuleId: ch.facadeModuleId,
    status: chunkStatus,
    size,
    modules,
    cx: 0,
    cy: 0,
    bx: 0,
    by: 0,
    bw: 0,
    bh: 0,
  };
}

function prettyId(id: string): string {
  if (id.startsWith('\0')) return id;
  return id.split('?')[0];
}

/**
 * Returns the set of chunk fileNames that are themselves changed OR transitively
 * depend on a changed chunk (via static or dynamic imports). The complement —
 * chunks whose entire dependency closure is unchanged — can be hidden safely.
 */
function computeRecursivelyChanged(
  stats: BundleStats,
  clusters: ChunkCluster[],
): Set<string> {
  // Reverse adjacency: importedFile -> set of chunks that import it.
  // BFSing this from "own-changed" chunks yields every chunk that has the
  // changed one in its (transitive) dependency closure.
  const importers = new Map<string, Set<string>>();
  for (const ch of stats.chunks) {
    const addImporter = (dep: string) => {
      let s = importers.get(dep);
      if (!s) {
        s = new Set();
        importers.set(dep, s);
      }
      s.add(ch.fileName);
    };
    for (const dep of ch.imports) addImporter(dep);
    for (const dep of ch.dynamicImports) addImporter(dep);
  }

  const result = new Set<string>();
  const queue: string[] = [];
  for (const c of clusters) {
    if (c.status !== 'same') {
      result.add(c.fileName);
      queue.push(c.fileName);
    }
  }
  while (queue.length) {
    const cur = queue.shift()!;
    const ups = importers.get(cur);
    if (!ups) continue;
    for (const u of ups) {
      if (!result.has(u)) {
        result.add(u);
        queue.push(u);
      }
    }
  }
  return result;
}

function layoutGraph(g: SideGraph) {
  for (const c of g.clusters) layoutModulesInCluster(c);
  forceLayoutClusters(g);
  for (const c of g.clusters) translateModules(c);
}

function layoutModulesInCluster(c: ChunkCluster) {
  const labelMinW = estimateLabelWidth(clusterLabelText(c)) + CLUSTER_PADDING_X * 2;
  const n = c.modules.length;
  if (n === 0) {
    c.bw = Math.max(100, labelMinW);
    c.bh = CLUSTER_PADDING_TOP + CLUSTER_PADDING_BOTTOM + 6;
    return;
  }
  const cols = Math.max(1, Math.ceil(Math.sqrt(n * 1.6)));
  const rows = Math.ceil(n / cols);
  const innerW = cols * MOD_W + (cols - 1) * MOD_GAP;
  const innerH = rows * MOD_H + (rows - 1) * MOD_GAP;
  c.bw = Math.max(120, innerW + CLUSTER_PADDING_X * 2, labelMinW);
  c.bh = innerH + CLUSTER_PADDING_TOP + CLUSTER_PADDING_BOTTOM;
  const xOffset = (c.bw - innerW) / 2;
  c.modules.forEach((m, i) => {
    const r = Math.floor(i / cols);
    const col = i % cols;
    m.x = xOffset + col * (MOD_W + MOD_GAP);
    m.y = CLUSTER_PADDING_TOP + r * (MOD_H + MOD_GAP);
  });
}

function clusterLabelText(c: ChunkCluster): string {
  return `${c.name}${c.isEntry ? ' ★' : ''}${c.isDynamicEntry ? ' ⚡' : ''} · ${c.modules.length} · ${formatBytes(c.size)}`;
}

// Cluster label is 11px monospace (.cluster-label). ~7px/char is a safe
// over-estimate that covers wider glyphs like ★ and ⚡.
function estimateLabelWidth(text: string): number {
  return text.length * 7;
}

function forceLayoutClusters(g: SideGraph) {
  const { clusters, edges, width, height } = g;
  const n = clusters.length;
  if (n === 0) return;

  const cols = Math.ceil(Math.sqrt(n));
  const rows = Math.ceil(n / cols);
  clusters.forEach((c, i) => {
    const cx = ((i % cols) + 0.5) * (width / cols);
    const cy = (Math.floor(i / cols) + 0.5) * (height / rows);
    c.cx = cx;
    c.cy = cy;
  });

  const baseK = Math.sqrt((width * height) / Math.max(n, 1)) * 0.7;
  const k = Math.min(baseK, Math.min(width, height) / 5);
  const iters = n > 60 ? 250 : 200;
  const byKey = new Map(clusters.map((c) => [c.key, c]));

  for (let iter = 0; iter < iters; iter++) {
    const t = 1 - iter / iters;
    const vx = new Map<string, number>();
    const vy = new Map<string, number>();
    for (const c of clusters) {
      vx.set(c.key, 0);
      vy.set(c.key, 0);
    }

    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const ci = clusters[i];
        const cj = clusters[j];
        let dx = ci.cx - cj.cx;
        let dy = ci.cy - cj.cy;
        let dist = Math.hypot(dx, dy);
        if (dist < 0.01) {
          dx = Math.random() - 0.5;
          dy = Math.random() - 0.5;
          dist = 0.01;
        }
        let force = (k * k) / dist;
        // Virtual link: weak global attraction between every pair so disconnected
        // components don't drift apart. Strength tuned so virtual links settle at
        // ~1.6x edge length (real edges win).
        force -= ((dist * dist) / k) * VIRTUAL_LINK_STRENGTH;
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;
        vx.set(ci.key, vx.get(ci.key)! + fx);
        vy.set(ci.key, vy.get(ci.key)! + fy);
        vx.set(cj.key, vx.get(cj.key)! - fx);
        vy.set(cj.key, vy.get(cj.key)! - fy);

        // Circle overlap-prevention: each rectangle's bounding circle has
        // radius = half the diagonal (sqrt(bw² + bh²) / 2). Push apart along
        // the line connecting centers when they get within sum of radii + gap.
        const minDist = clusterRadius(ci) + clusterRadius(cj) + CLUSTER_GAP;
        if (dist < minDist) {
          const shove = (minDist - dist) * 6;
          const sx = (dx / dist) * shove;
          const sy = (dy / dist) * shove;
          vx.set(ci.key, vx.get(ci.key)! + sx);
          vy.set(ci.key, vy.get(ci.key)! + sy);
          vx.set(cj.key, vx.get(cj.key)! - sx);
          vy.set(cj.key, vy.get(cj.key)! - sy);
        }
      }
    }

    for (const e of edges) {
      const cs = byKey.get(e.source);
      const ct = byKey.get(e.target);
      if (!cs || !ct) continue;
      const dx = cs.cx - ct.cx;
      const dy = cs.cy - ct.cy;
      const dist = Math.hypot(dx, dy) + 0.01;
      const force = (dist * dist) / k;
      const fx = (dx / dist) * force;
      const fy = (dy / dist) * force;
      vx.set(cs.key, vx.get(cs.key)! - fx);
      vy.set(cs.key, vy.get(cs.key)! - fy);
      vx.set(ct.key, vx.get(ct.key)! + fx);
      vy.set(ct.key, vy.get(ct.key)! + fy);
    }

    for (const c of clusters) {
      const ux = vx.get(c.key)!;
      const uy = vy.get(c.key)!;
      const u = Math.hypot(ux, uy);
      const cap = Math.min(u, t * 80);
      if (u > 0) {
        c.cx += (ux / u) * cap;
        c.cy += (uy / u) * cap;
      }
    }
  }

  resolveOverlaps(clusters);

  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const c of clusters) {
    minX = Math.min(minX, c.cx - c.bw / 2);
    minY = Math.min(minY, c.cy - c.bh / 2);
    maxX = Math.max(maxX, c.cx + c.bw / 2);
    maxY = Math.max(maxY, c.cy + c.bh / 2);
  }
  const pad = 30;
  const bboxW = maxX - minX;
  const bboxH = maxY - minY;
  const targetW = Math.max(width, bboxW + pad * 2);
  const targetH = Math.max(height, bboxH + pad * 2);
  const dx = (targetW - bboxW) / 2 - minX;
  const dy = (targetH - bboxH) / 2 - minY;
  for (const c of clusters) {
    c.cx += dx;
    c.cy += dy;
  }
  g.width = targetW;
  g.height = targetH;
}

function clusterRadius(c: ChunkCluster): number {
  return Math.hypot(c.bw, c.bh) / 2;
}

function resolveOverlaps(clusters: ChunkCluster[], maxPasses = 60): void {
  for (let pass = 0; pass < maxPasses; pass++) {
    let anyOverlap = false;
    for (let i = 0; i < clusters.length; i++) {
      for (let j = i + 1; j < clusters.length; j++) {
        const ci = clusters[i];
        const cj = clusters[j];
        let dx = ci.cx - cj.cx;
        let dy = ci.cy - cj.cy;
        let dist = Math.hypot(dx, dy);
        if (dist < 0.01) {
          dx = Math.random() - 0.5;
          dy = Math.random() - 0.5;
          dist = Math.hypot(dx, dy) || 0.01;
        }
        const minDist = clusterRadius(ci) + clusterRadius(cj) + CLUSTER_GAP;
        const overlap = minDist - dist;
        if (overlap <= 0) continue;
        anyOverlap = true;
        const ux = dx / dist;
        const uy = dy / dist;
        const shift = overlap / 2;
        ci.cx += ux * shift;
        ci.cy += uy * shift;
        cj.cx -= ux * shift;
        cj.cy -= uy * shift;
      }
    }
    if (!anyOverlap) break;
  }
}

function translateModules(c: ChunkCluster) {
  c.bx = c.cx - c.bw / 2;
  c.by = c.cy - c.bh / 2;
  for (const m of c.modules) {
    m.x += c.bx;
    m.y += c.by;
  }
}

const SVG_NS = 'http://www.w3.org/2000/svg';
function svg<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number> = {},
): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

export interface RenderGraphOptions {
  onModuleClick?: (moduleId: string) => void;
}

export function renderGraph(
  host: HTMLElement,
  graph: SideGraph,
  opts: RenderGraphOptions = {},
): void {
  host.replaceChildren();

  const svgEl = svg('svg', {
    class: 'graph-svg',
    viewBox: `0 0 ${graph.width} ${graph.height}`,
    preserveAspectRatio: 'xMidYMid meet',
  });
  svgEl.style.width = '100%';
  svgEl.style.height = '100%';

  const defs = svg('defs');
  defs.appendChild(arrowMarker('arrow-static', 'currentColor'));
  defs.appendChild(arrowMarker('arrow-dynamic', 'currentColor'));
  svgEl.appendChild(defs);

  const viewport = svg('g', { class: 'viewport' });
  svgEl.appendChild(viewport);

  const edgeLayer = svg('g', { class: 'edge-layer' });
  const clusterLayer = svg('g', { class: 'cluster-layer' });
  const moduleLayer = svg('g', { class: 'module-layer' });
  viewport.append(edgeLayer, clusterLayer, moduleLayer);

  const byKey = new Map(graph.clusters.map((c) => [c.key, c]));

  interface EdgeRef {
    pathEl: SVGPathElement;
    source: ChunkCluster;
    target: ChunkCluster;
  }
  const edgesByKey = new Map<string, EdgeRef[]>();
  const pushEdge = (key: string, ref: EdgeRef) => {
    let arr = edgesByKey.get(key);
    if (!arr) {
      arr = [];
      edgesByKey.set(key, arr);
    }
    arr.push(ref);
  };

  for (const e of graph.edges) {
    const cs = byKey.get(e.source);
    const ct = byKey.get(e.target);
    if (!cs || !ct) continue;
    const path = svg('path', {
      class: `edge edge-${e.kind}`,
      'data-edge-source': cs.key,
      'data-edge-target': ct.key,
      'data-edge-source-name': cs.name,
      'data-edge-target-name': ct.name,
      'marker-end': `url(#arrow-${e.kind})`,
    });
    setEdgeD(path, cs, ct);
    edgeLayer.appendChild(path);
    const ref: EdgeRef = { pathEl: path, source: cs, target: ct };
    pushEdge(cs.key, ref);
    pushEdge(ct.key, ref);
  }

  interface ClusterEls {
    rect: SVGRectElement;
    label: SVGTextElement;
    moduleRects: { rect: SVGRectElement; module: ModuleNode }[];
  }
  const clusterEls = new Map<string, ClusterEls>();

  for (const c of graph.clusters) {
    const klass = [
      'cluster',
      c.isEntry ? 'cluster-entry' : '',
      c.isDynamicEntry ? 'cluster-dynamic' : '',
    ]
      .filter(Boolean)
      .join(' ');
    const rect = svg('rect', {
      class: klass,
      'data-cluster-key': c.key,
      'data-cluster-name': c.name,
      x: c.bx,
      y: c.by,
      width: c.bw,
      height: c.bh,
      rx: 8,
      ry: 8,
    });
    clusterLayer.appendChild(rect);

    const labelText = clusterLabelText(c);
    const label = svg('text', {
      class: 'cluster-label',
      'data-cluster-key': c.key,
      'data-cluster-name': c.name,
      x: c.bx + 10,
      y: c.by + 14,
    });
    label.textContent = labelText;
    clusterLayer.appendChild(label);

    clusterEls.set(c.key, { rect, label, moduleRects: [] });
  }

  for (const c of graph.clusters) {
    const els = clusterEls.get(c.key)!;
    for (const m of c.modules) {
      const rect = svg('rect', {
        class: `module module-${m.status}`,
        'data-module-id': m.id,
        'data-cluster-key': c.key,
        'data-cluster-name': c.name,
        x: m.x,
        y: m.y,
        width: m.width,
        height: m.height,
        rx: 2,
        ry: 2,
      });
      rect.addEventListener('mouseenter', () => showTooltip(m, c));
      rect.addEventListener('mousemove', moveTooltip);
      rect.addEventListener('mouseleave', hideTooltip);
      if (opts.onModuleClick) {
        rect.style.cursor = 'pointer';
        // Stop pointerdown from bubbling to the SVG's pan-zoom handler — that
        // would call setPointerCapture on the SVG and divert pointerup away
        // from the module, suppressing the click event.
        rect.addEventListener('pointerdown', (e) => e.stopPropagation());
        rect.addEventListener('click', (e) => {
          e.stopPropagation();
          opts.onModuleClick!(m.id);
        });
      }
      moduleLayer.appendChild(rect);
      els.moduleRects.push({ rect, module: m });
    }
  }

  for (const c of graph.clusters) {
    const els = clusterEls.get(c.key)!;
    attachClusterDrag(c, els, edgesByKey.get(c.key) ?? [], viewport);
    attachClusterContextMenu(els.rect, c, host);
  }

  attachPanZoom(svgEl, viewport);
  host.appendChild(svgEl);
  applyHidden(host);
}

// Incoming/outgoing edge hiding is per-side (keyed by the chunk's fileName/key
// since edges are scoped to a single rendered graph). Full chunk hiding is
// keyed by the chunk's NAME so it survives flipping the graph from A↔B.
const hiddenIncomingClusters = new Set<string>();
const hiddenOutgoingClusters = new Set<string>();
const hiddenChunkNames = new Set<string>();

export function hasGraphHiding(): boolean {
  return (
    hiddenIncomingClusters.size > 0 ||
    hiddenOutgoingClusters.size > 0 ||
    hiddenChunkNames.size > 0
  );
}

export function getHiddenChunkNames(): string[] {
  return [...hiddenChunkNames].sort();
}

/** Replace the hidden-chunk set without applying — caller renders next. */
export function setHiddenChunkNames(names: string[]): void {
  hiddenChunkNames.clear();
  for (const n of names) hiddenChunkNames.add(n);
}

export function unhideChunk(name: string, host: HTMLElement): void {
  hiddenChunkNames.delete(name);
  applyHidden(host);
}

export function resetGraphHiding(host: HTMLElement): void {
  hiddenIncomingClusters.clear();
  hiddenOutgoingClusters.clear();
  hiddenChunkNames.clear();
  applyHidden(host);
}

function attachClusterContextMenu(
  clusterRect: SVGRectElement,
  cluster: ChunkCluster,
  host: HTMLElement,
): void {
  clusterRect.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    showClusterMenu(e.clientX, e.clientY, cluster, host);
  });
}

function showClusterMenu(
  x: number,
  y: number,
  cluster: ChunkCluster,
  host: HTMLElement,
): void {
  document.querySelectorAll('.cluster-menu').forEach((el) => el.remove());

  const menu = document.createElement('div');
  menu.className = 'cluster-menu';
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;

  const header = document.createElement('div');
  header.className = 'cluster-menu-header';
  header.textContent = cluster.name;
  menu.appendChild(header);

  const incomingHidden = hiddenIncomingClusters.has(cluster.key);
  const incomingBtn = document.createElement('button');
  incomingBtn.type = 'button';
  incomingBtn.className = 'cluster-menu-item';
  incomingBtn.textContent = incomingHidden
    ? 'Show incoming edges'
    : 'Hide incoming edges';
  incomingBtn.addEventListener('click', () => {
    if (incomingHidden) hiddenIncomingClusters.delete(cluster.key);
    else hiddenIncomingClusters.add(cluster.key);
    applyHidden(host);
    closeMenu();
  });
  menu.appendChild(incomingBtn);

  const outgoingHidden = hiddenOutgoingClusters.has(cluster.key);
  const outgoingBtn = document.createElement('button');
  outgoingBtn.type = 'button';
  outgoingBtn.className = 'cluster-menu-item';
  outgoingBtn.textContent = outgoingHidden
    ? 'Show outgoing edges'
    : 'Hide outgoing edges';
  outgoingBtn.addEventListener('click', () => {
    if (outgoingHidden) hiddenOutgoingClusters.delete(cluster.key);
    else hiddenOutgoingClusters.add(cluster.key);
    applyHidden(host);
    closeMenu();
  });
  menu.appendChild(outgoingBtn);

  const hideClusterBtn = document.createElement('button');
  hideClusterBtn.type = 'button';
  hideClusterBtn.className = 'cluster-menu-item';
  hideClusterBtn.textContent = 'Hide chunk';
  hideClusterBtn.addEventListener('click', () => {
    hiddenChunkNames.add(cluster.name);
    applyHidden(host);
    closeMenu();
  });
  menu.appendChild(hideClusterBtn);

  document.body.appendChild(menu);

  const rect = menu.getBoundingClientRect();
  if (rect.right > window.innerWidth - 4) {
    menu.style.left = `${Math.max(4, window.innerWidth - rect.width - 4)}px`;
  }
  if (rect.bottom > window.innerHeight - 4) {
    menu.style.top = `${Math.max(4, window.innerHeight - rect.height - 4)}px`;
  }

  function closeMenu() {
    menu.remove();
    document.removeEventListener('mousedown', outside, true);
    document.removeEventListener('keydown', escape);
  }
  function outside(ev: MouseEvent) {
    if (!menu.contains(ev.target as Node)) closeMenu();
  }
  function escape(ev: KeyboardEvent) {
    if (ev.key === 'Escape') closeMenu();
  }
  setTimeout(() => {
    document.addEventListener('mousedown', outside, true);
    document.addEventListener('keydown', escape);
  }, 0);
}

function applyHidden(host: HTMLElement): void {
  const paths = host.querySelectorAll<SVGPathElement>('[data-edge-target]');
  for (const path of paths) {
    const target = path.getAttribute('data-edge-target') ?? '';
    const source = path.getAttribute('data-edge-source') ?? '';
    const sourceName = path.getAttribute('data-edge-source-name') ?? '';
    const targetName = path.getAttribute('data-edge-target-name') ?? '';
    const hide =
      hiddenIncomingClusters.has(target) ||
      hiddenOutgoingClusters.has(source) ||
      hiddenChunkNames.has(sourceName) ||
      hiddenChunkNames.has(targetName);
    path.classList.toggle('edge-hidden', hide);
  }
  const els = host.querySelectorAll<SVGElement>('[data-cluster-name]');
  for (const elx of els) {
    const n = elx.getAttribute('data-cluster-name') ?? '';
    elx.classList.toggle('cluster-hidden', hiddenChunkNames.has(n));
  }
  host.dispatchEvent(
    new CustomEvent('graph:hidden-changed', {
      bubbles: true,
      detail: { hasHiding: hasGraphHiding() },
    }),
  );
}


function setEdgeD(
  path: SVGPathElement,
  cs: ChunkCluster,
  ct: ChunkCluster,
): void {
  const [x1, y1, x2, y2] = clusterEdgePoints(cs, ct);
  // Always bend to the left of the direction of travel (consistent CCW
  // offset). Reverse direction → opposite bend, so two edges between the same
  // pair (e.g. A statically imports B, B dynamically imports A) don't overlap.
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy) || 1;
  const px = -dy / len;
  const py = dx / len;
  const offset = Math.min(30, Math.max(20, len * 0.15));
  const mx = (x1 + x2) / 2 + px * offset;
  const my = (y1 + y2) / 2 + py * offset;
  path.setAttribute('d', `M ${x1} ${y1} Q ${mx} ${my}, ${x2} ${y2}`);
}

function attachClusterDrag(
  cluster: ChunkCluster,
  els: {
    rect: SVGRectElement;
    label: SVGTextElement;
    moduleRects: { rect: SVGRectElement; module: ModuleNode }[];
  },
  edges: { pathEl: SVGPathElement; source: ChunkCluster; target: ChunkCluster }[],
  viewport: SVGGElement,
): void {
  const rect = els.rect;
  rect.style.cursor = 'move';
  let dragging = false;
  let startCx = 0;
  let startCy = 0;
  let startX = 0;
  let startY = 0;

  rect.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    dragging = true;
    startCx = cluster.cx;
    startCy = cluster.cy;
    startX = e.clientX;
    startY = e.clientY;
    rect.setPointerCapture(e.pointerId);
    rect.style.cursor = 'grabbing';
  });

  rect.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const ctm = viewport.getScreenCTM();
    if (!ctm || ctm.a === 0 || ctm.d === 0) return;
    const newCx = startCx + (e.clientX - startX) / ctm.a;
    const newCy = startCy + (e.clientY - startY) / ctm.d;
    moveCluster(cluster, newCx, newCy, els, edges);
  });

  const endDrag = (e: PointerEvent) => {
    if (!dragging) return;
    dragging = false;
    try {
      rect.releasePointerCapture(e.pointerId);
    } catch {
      /* released already */
    }
    rect.style.cursor = 'move';
  };
  rect.addEventListener('pointerup', endDrag);
  rect.addEventListener('pointercancel', endDrag);
}

function moveCluster(
  cluster: ChunkCluster,
  newCx: number,
  newCy: number,
  els: {
    rect: SVGRectElement;
    label: SVGTextElement;
    moduleRects: { rect: SVGRectElement; module: ModuleNode }[];
  },
  edges: { pathEl: SVGPathElement; source: ChunkCluster; target: ChunkCluster }[],
): void {
  const dx = newCx - cluster.cx;
  const dy = newCy - cluster.cy;
  cluster.cx = newCx;
  cluster.cy = newCy;
  cluster.bx += dx;
  cluster.by += dy;
  els.rect.setAttribute('x', String(cluster.bx));
  els.rect.setAttribute('y', String(cluster.by));
  els.label.setAttribute('x', String(cluster.bx + 10));
  els.label.setAttribute('y', String(cluster.by + 14));
  for (const { rect, module } of els.moduleRects) {
    module.x += dx;
    module.y += dy;
    rect.setAttribute('x', String(module.x));
    rect.setAttribute('y', String(module.y));
  }
  for (const e of edges) {
    setEdgeD(e.pathEl, e.source, e.target);
  }
}

function arrowMarker(id: string, color: string): SVGMarkerElement {
  const marker = svg('marker', {
    id,
    viewBox: '0 0 10 10',
    refX: 9,
    refY: 5,
    markerWidth: 9,
    markerHeight: 9,
    orient: 'auto-start-reverse',
  });
  const tri = svg('path', { d: 'M 0 0 L 10 5 L 0 10 z', fill: color });
  marker.appendChild(tri);
  return marker;
}

function clusterEdgePoints(
  a: ChunkCluster,
  b: ChunkCluster,
): [number, number, number, number] {
  const dx = b.cx - a.cx;
  const dy = b.cy - a.cy;
  const [x1, y1] = rectBorder(a, dx, dy);
  const [x2, y2] = rectBorder(b, -dx, -dy);
  return [x1, y1, x2, y2];
}

function rectBorder(c: ChunkCluster, dx: number, dy: number): [number, number] {
  if (dx === 0 && dy === 0) return [c.cx, c.cy];
  const halfW = c.bw / 2;
  const halfH = c.bh / 2;
  const tx = dx === 0 ? Infinity : Math.abs(halfW / dx);
  const ty = dy === 0 ? Infinity : Math.abs(halfH / dy);
  const t = Math.min(tx, ty);
  return [c.cx + dx * t, c.cy + dy * t];
}

function attachPanZoom(svgEl: SVGSVGElement, viewport: SVGGElement) {
  let scale = 1;
  let tx = 0;
  let ty = 0;

  function apply() {
    viewport.setAttribute('transform', `translate(${tx} ${ty}) scale(${scale})`);
  }

  svgEl.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const rect = svgEl.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      const vbW = parseFloat(svgEl.getAttribute('viewBox')!.split(' ')[2]);
      const sx = (px / rect.width) * vbW;
      const sy = (py / rect.height) * vbW * (rect.height / rect.width);
      const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
      const newScale = Math.max(0.1, Math.min(8, scale * factor));
      tx = sx - ((sx - tx) / scale) * newScale;
      ty = sy - ((sy - ty) / scale) * newScale;
      scale = newScale;
      apply();
    },
    { passive: false },
  );

  let dragging = false;
  let lastX = 0;
  let lastY = 0;
  svgEl.addEventListener('pointerdown', (e) => {
    dragging = true;
    lastX = e.clientX;
    lastY = e.clientY;
    svgEl.setPointerCapture(e.pointerId);
    svgEl.style.cursor = 'grabbing';
  });
  svgEl.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const rect = svgEl.getBoundingClientRect();
    const vbW = parseFloat(svgEl.getAttribute('viewBox')!.split(' ')[2]);
    const ratio = vbW / rect.width;
    tx += (e.clientX - lastX) * ratio;
    ty += (e.clientY - lastY) * ratio;
    lastX = e.clientX;
    lastY = e.clientY;
    apply();
  });
  function endDrag(e: PointerEvent) {
    dragging = false;
    svgEl.releasePointerCapture(e.pointerId);
    svgEl.style.cursor = '';
  }
  svgEl.addEventListener('pointerup', endDrag);
  svgEl.addEventListener('pointercancel', endDrag);
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

let tooltipEl: HTMLDivElement | null = null;

function ensureTooltip(): HTMLDivElement {
  if (tooltipEl) return tooltipEl;
  const t = document.createElement('div');
  t.className = 'graph-tooltip';
  t.hidden = true;
  document.body.appendChild(t);
  tooltipEl = t;
  return t;
}

function showTooltip(m: ModuleNode, c: ChunkCluster) {
  const t = ensureTooltip();
  t.replaceChildren();
  const idLine = document.createElement('div');
  idLine.className = 'graph-tooltip-id';
  idLine.textContent = m.id;
  t.appendChild(idLine);
  const meta = document.createElement('div');
  meta.className = 'graph-tooltip-meta';
  meta.textContent =
    `chunk: ${c.name} · ${formatBytes(m.size)}` +
    (m.movedTo ? ` · moved → ${m.movedTo}` : '') +
    ` · ${m.status}`;
  t.appendChild(meta);
  t.hidden = false;
}

function moveTooltip(e: MouseEvent) {
  const t = tooltipEl;
  if (!t || t.hidden) return;
  const tipW = t.offsetWidth;
  const tipH = t.offsetHeight;
  const margin = 14;
  let x = e.clientX + margin;
  let y = e.clientY + margin;
  if (x + tipW > window.innerWidth - 8) x = e.clientX - tipW - margin;
  if (y + tipH > window.innerHeight - 8) y = e.clientY - tipH - margin;
  t.style.left = `${x}px`;
  t.style.top = `${y}px`;
}

function hideTooltip() {
  if (tooltipEl) tooltipEl.hidden = true;
}
