import { ItemView, Plugin, TFile, WorkspaceLeaf } from 'obsidian';
import * as d3 from 'd3';

const VIEW_TYPE = 'weighted-graph';
const EDGE_RE = String.raw`\[\[([^\]]+)\]\]::(-?\d+(?:\.\d+)?)`;

interface GNode extends d3.SimulationNodeDatum {
  id: string;
  file: TFile | null;
  label: string;
  dangling: boolean;
}

interface GEdge extends d3.SimulationLinkDatum<GNode> {
  weight: number;
}

const edgeColor = d3.scaleLinear<string>()
  .domain([-10, 0, 10])
  .range(['#8b1a1a', '#5a5a8a', '#1a7a1a'])
  .clamp(true);

// ── View ──────────────────────────────────────────────────────────────────────

class WeightedGraphView extends ItemView {
  private plugin: WeightedGraphPlugin;
  private sim: d3.Simulation<GNode, GEdge> | null = null;
  private savedPos = new Map<string, { x: number; y: number; fx: number | null; fy: number | null }>();
  private resizeObs: ResizeObserver | null = null;
  private debounce: number | null = null;

  // Persistent elements
  private graphAreaEl!: HTMLElement;
  private pillsEl!: HTMLElement;

  // Filter state
  private connectedOnly = true;
  private nameFilters: string[] = [];

  constructor(leaf: WorkspaceLeaf, plugin: WeightedGraphPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType()    { return VIEW_TYPE; }
  getDisplayText() { return 'Weighted Graph'; }
  getIcon()        { return 'share-2'; }

  async onOpen() {
    const viewContent = this.containerEl.children[1] as HTMLElement;
    viewContent.addClass('wg-view-content');
    viewContent.empty();

    this.buildFilterBar(viewContent.createDiv('wg-filter-bar'));
    this.graphAreaEl = viewContent.createDiv('wg-graph-area');

    await this.buildAndRender();

    this.registerEvent(this.app.vault.on('modify', () => this.schedule()));
    this.registerEvent(this.app.vault.on('create', () => this.schedule()));
    this.registerEvent(this.app.vault.on('delete', () => this.schedule()));
    this.registerEvent(this.app.vault.on('rename', () => this.schedule()));

    this.resizeObs = new ResizeObserver(() => this.schedule());
    this.resizeObs.observe(viewContent);
  }

  async onClose() {
    this.sim?.stop();
    this.resizeObs?.disconnect();
  }

  private schedule() {
    if (this.debounce) window.clearTimeout(this.debounce);
    this.debounce = window.setTimeout(() => this.buildAndRender(), 400);
  }

  // ── Filter bar (built once, persists across re-renders) ───────────────────

  private buildFilterBar(bar: HTMLElement) {
    // Connected-only toggle
    const toggleLabel = bar.createEl('label', { cls: 'wg-toggle-label' });
    const checkbox = toggleLabel.createEl('input');
    checkbox.type = 'checkbox';
    checkbox.checked = this.connectedOnly;
    toggleLabel.createSpan({ text: 'Connected only' });
    checkbox.addEventListener('change', () => {
      this.connectedOnly = checkbox.checked;
      this.buildAndRender();
    });

    bar.createDiv('wg-filter-divider');

    // Name filter input
    const section = bar.createDiv('wg-filter-section');
    section.createSpan({ cls: 'wg-filter-label', text: 'Filter by mention:' });

    const input = section.createEl('input', { cls: 'wg-filter-input' });
    input.type = 'text';
    input.placeholder = 'Note name…';

    const addBtn = section.createEl('button', { cls: 'wg-filter-add-btn', text: 'Add' });

    const addFilter = () => {
      const val = input.value.trim();
      if (val && !this.nameFilters.includes(val)) {
        this.nameFilters.push(val);
        this.renderPills();
        this.buildAndRender();
      }
      input.value = '';
      input.focus();
    };

    addBtn.addEventListener('click', addFilter);
    input.addEventListener('keydown', e => { if (e.key === 'Enter') addFilter(); });

    this.pillsEl = section.createDiv('wg-pills');
    this.renderPills();
  }

  private renderPills() {
    this.pillsEl.empty();
    for (const f of this.nameFilters) {
      const pill = this.pillsEl.createDiv('wg-pill');
      pill.createSpan({ text: f });
      const x = pill.createEl('button', { cls: 'wg-pill-remove', text: '×' });
      x.addEventListener('click', () => {
        this.nameFilters = this.nameFilters.filter(n => n !== f);
        this.renderPills();
        this.buildAndRender();
      });
    }
  }

  // ── Data collection ───────────────────────────────────────────────────────

  private async buildAndRender() {
    this.sim?.nodes().forEach(n => {
      this.savedPos.set(n.id, { x: n.x ?? 0, y: n.y ?? 0, fx: n.fx ?? null, fy: n.fy ?? null });
    });
    this.sim?.stop();

    const allNodes = new Map<string, GNode>();
    const allEdges: GEdge[] = [];
    const contentCache = new Map<string, string>(); // nodeId → raw file text

    for (const file of this.app.vault.getMarkdownFiles()) {
      allNodes.set(file.basename, { id: file.basename, file, label: file.basename, dangling: false });
    }

    for (const file of this.app.vault.getMarkdownFiles()) {
      const content = await this.app.vault.cachedRead(file);
      contentCache.set(file.basename, content);
      for (const m of content.matchAll(new RegExp(EDGE_RE, 'g'))) {
        const target = m[1].trim();
        const weight  = parseFloat(m[2]);
        if (!allNodes.has(target)) {
          allNodes.set(target, { id: target, file: null, label: target, dangling: true });
        }
        allEdges.push({ source: file.basename, target, weight });
      }
    }

    const { nodes, edges } = this.applyFilters(
      Array.from(allNodes.values()), allEdges, contentCache
    );
    this.render(nodes, edges);
  }

  // ── Filtering ─────────────────────────────────────────────────────────────

  private applyFilters(
    allNodes: GNode[],
    allEdges: GEdge[],
    contentCache: Map<string, string>
  ): { nodes: GNode[]; edges: GEdge[] } {
    let visible = new Set(allNodes.map(n => n.id));

    // 1. Drop islands (nodes with no edges)
    if (this.connectedOnly) {
      const connected = new Set<string>();
      for (const e of allEdges) {
        connected.add(e.source as string);
        connected.add(e.target as string);
      }
      visible = new Set([...visible].filter(id => connected.has(id)));
    }

    // 2. Name filters — keep nodes whose file content mentions ANY filter name
    //    Case-insensitive, checks for [[FilterName]] anywhere in the file
    if (this.nameFilters.length > 0) {
      const matching = new Set<string>();
      for (const id of visible) {
        const text = (contentCache.get(id) ?? '').toLowerCase();
        if (this.nameFilters.some(f => text.includes(`[[${f.toLowerCase()}]]`))) {
          matching.add(id);
        }
      }
      visible = matching;
    }

    return {
      nodes: allNodes.filter(n => visible.has(n.id)),
      edges: allEdges.filter(e =>
        visible.has(e.source as string) && visible.has(e.target as string)
      ),
    };
  }

  // ── Rendering ─────────────────────────────────────────────────────────────

  private render(rawNodes: GNode[], rawEdges: GEdge[]) {
    this.graphAreaEl.empty();

    const W = this.graphAreaEl.clientWidth  || 800;
    const H = this.graphAreaEl.clientHeight || 600;

    const nodes: GNode[] = rawNodes.map(n => {
      const p = this.savedPos.get(n.id);
      return Object.assign({}, n, {
        x:  p?.x  ?? W / 2 + (Math.random() - 0.5) * 300,
        y:  p?.y  ?? H / 2 + (Math.random() - 0.5) * 300,
        fx: p?.fx ?? null,
        fy: p?.fy ?? null,
      });
    });

    const byId  = new Map(nodes.map(n => [n.id, n]));
    const edges: GEdge[] = rawEdges
      .map(e => ({ ...e, source: byId.get(e.source as string)!, target: byId.get(e.target as string)! }))
      .filter(e => e.source && e.target);

    if (nodes.length === 0) {
      this.graphAreaEl.createDiv('wg-empty').setText('No nodes match the current filters.');
      return;
    }

    // Controls overlay
    const controls = this.graphAreaEl.createDiv('wg-controls');
    const btnReset = controls.createEl('button', { text: 'Reset layout' });
    const btnUnpin = controls.createEl('button', { text: 'Unpin all' });

    // Legend
    const legend = this.graphAreaEl.createDiv('wg-legend');
    legend.createDiv('wg-legend-label').setText('Edge weight');
    legend.createDiv('wg-legend-bar');
    const ticks  = legend.createDiv('wg-legend-ticks');
    const ws     = edges.map(e => e.weight);
    const wMin   = Math.min(...ws, 0);
    const wMax   = Math.max(...ws, 0);
    ticks.createSpan().setText(String(wMin));
    ticks.createSpan().setText('0');
    ticks.createSpan().setText(String(wMax));

    // SVG
    const svgEl = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svgEl.setAttribute('width', '100%');
    svgEl.setAttribute('height', '100%');
    this.graphAreaEl.appendChild(svgEl);

    const svg    = d3.select(svgEl);
    const canvas = svg.append('g');

    svg.call(
      d3.zoom<SVGSVGElement, unknown>()
        .scaleExtent([0.05, 4])
        .on('zoom', e => canvas.attr('transform', e.transform as any))
    );

    svg.append('defs')
      .append('marker')
      .attr('id', 'wg-arrow')
      .attr('viewBox', '0 -4 8 8')
      .attr('refX', 8).attr('refY', 0)
      .attr('markerWidth', 6).attr('markerHeight', 6)
      .attr('orient', 'auto')
      .append('path').attr('d', 'M0,-4L8,0L0,4')
      .attr('fill', 'context-stroke');

    const linkLayer  = canvas.append('g');
    const labelLayer = canvas.append('g');
    const nodeLayer  = canvas.append('g');

    const absMax  = Math.max(Math.abs(wMin), Math.abs(wMax), 1);
    const strokeW = d3.scaleLinear().domain([0, absMax]).range([1, 5]).clamp(true);

    const r = (d: GNode) => {
      const deg = edges.filter(e =>
        (e.source as GNode).id === d.id || (e.target as GNode).id === d.id
      ).length;
      return 14 + Math.min(deg * 1.5, 10);
    };

    const link = linkLayer.selectAll<SVGLineElement, GEdge>('line')
      .data(edges).join('line')
      .attr('stroke', d => edgeColor(d.weight))
      .attr('stroke-width', d => strokeW(Math.abs(d.weight)))
      .attr('stroke-opacity', 0.85)
      .attr('marker-end', 'url(#wg-arrow)');

    const edgeLabels = labelLayer.selectAll<SVGTextElement, GEdge>('text')
      .data(edges.filter(e => e.weight !== 1)).join('text')
      .text(d => String(d.weight))
      .attr('font-size', '10px').attr('fill', '#8080a8')
      .attr('text-anchor', 'middle').attr('dominant-baseline', 'middle')
      .style('pointer-events', 'none').style('user-select', 'none');

    const node = nodeLayer.selectAll<SVGGElement, GNode>('g')
      .data(nodes, d => d.id).join('g')
      .style('cursor', 'grab')
      .call(
        d3.drag<SVGGElement, GNode>()
          .on('start', (event, d) => {
            if (!event.active) sim.alphaTarget(0.3).restart();
            d.fx = d.x; d.fy = d.y;
          })
          .on('drag', (event, d) => { d.fx = event.x; d.fy = event.y; })
          .on('end', (event, d) => {
            if (!event.active) sim.alphaTarget(0);
            d3.select<SVGGElement, GNode>(event.sourceEvent.target.closest('g'))
              .select('circle').attr('stroke', '#f0c060').attr('stroke-width', 2.5);
          })
      )
      .on('click', (event, d) => {
        event.stopPropagation();
        const g = d3.select<SVGGElement, GNode>(event.currentTarget as SVGGElement);
        if (d.fx !== null) {
          d.fx = null; d.fy = null;
          g.select('circle').attr('stroke', d.dangling ? '#777' : '#a89ee8').attr('stroke-width', 1.5);
        } else {
          d.fx = d.x; d.fy = d.y;
          g.select('circle').attr('stroke', '#f0c060').attr('stroke-width', 2.5);
        }
        sim.alpha(0.1).restart();
      })
      .on('dblclick', (event, d) => {
        event.stopPropagation();
        if (d.file) this.app.workspace.getLeaf(false).openFile(d.file);
      });

    node.append('circle')
      .attr('r', r)
      .attr('fill',   d => d.dangling ? '#555' : '#7c6adb')
      .attr('stroke', d => d.dangling ? '#777' : '#a89ee8')
      .attr('stroke-width', 1.5);

    node.append('text')
      .attr('text-anchor', 'middle').attr('dy', d => r(d) + 10)
      .attr('font-size', '11px').attr('fill', 'var(--text-normal)')
      .style('pointer-events', 'none').style('user-select', 'none')
      .text(d => d.label);

    node.each(function(d) {
      if (d.fx !== null)
        d3.select(this).select('circle').attr('stroke', '#f0c060').attr('stroke-width', 2.5);
    });

    const sim = d3.forceSimulation<GNode>(nodes)
      .force('link', d3.forceLink<GNode, GEdge>(edges).id(d => d.id)
        .distance(d => 80 + Math.abs(d.weight) * 8).strength(0.5))
      .force('charge',    d3.forceManyBody<GNode>().strength(-180))
      .force('x',         d3.forceX<GNode>(W / 2).strength(0.04))
      .force('y',         d3.forceY<GNode>(H / 2).strength(0.04))
      .force('collision', d3.forceCollide<GNode>().radius(d => r(d) + 6))
      .alphaDecay(0.025)
      .on('tick', () => {
        const pad = 80;
        for (const n of nodes) {
          if (n.fx !== null) continue;
          if ((n.x ?? 0) < -pad)    (n as any).vx += 0.8;
          if ((n.x ?? 0) > W + pad) (n as any).vx -= 0.8;
          if ((n.y ?? 0) < -pad)    (n as any).vy += 0.8;
          if ((n.y ?? 0) > H + pad) (n as any).vy -= 0.8;
        }

        link.each(function(d) {
          const s = d.source as GNode, t = d.target as GNode;
          const dx = (t.x ?? 0) - (s.x ?? 0), dy = (t.y ?? 0) - (s.y ?? 0);
          const dist = Math.sqrt(dx * dx + dy * dy) || 1;
          d3.select(this)
            .attr('x1', (s.x ?? 0) + dx / dist * r(s))
            .attr('y1', (s.y ?? 0) + dy / dist * r(s))
            .attr('x2', (t.x ?? 0) - dx / dist * (r(t) + 6))
            .attr('y2', (t.y ?? 0) - dy / dist * (r(t) + 6));
        });

        edgeLabels
          .attr('x', d => (((d.source as GNode).x ?? 0) + ((d.target as GNode).x ?? 0)) / 2)
          .attr('y', d => (((d.source as GNode).y ?? 0) + ((d.target as GNode).y ?? 0)) / 2 - 6);

        node.attr('transform', d => `translate(${d.x ?? 0},${d.y ?? 0})`);
      });

    this.sim = sim as any;

    btnReset.addEventListener('click', () => {
      sim.nodes().forEach(n => { n.fx = null; n.fy = null; });
      node.each(function(d) {
        d3.select(this).select('circle')
          .attr('stroke', d.dangling ? '#777' : '#a89ee8').attr('stroke-width', 1.5);
      });
      sim.alpha(1).restart();
      svg.transition().duration(400)
        .call(d3.zoom<SVGSVGElement, unknown>().transform as any, d3.zoomIdentity);
    });

    btnUnpin.addEventListener('click', () => {
      sim.nodes().forEach(n => { n.fx = null; n.fy = null; });
      node.each(function(d) {
        d3.select(this).select('circle')
          .attr('stroke', d.dangling ? '#777' : '#a89ee8').attr('stroke-width', 1.5);
      });
      sim.alpha(0.5).restart();
    });
  }
}

// ── Plugin ────────────────────────────────────────────────────────────────────

export default class WeightedGraphPlugin extends Plugin {
  async onload() {
    this.registerView(VIEW_TYPE, leaf => new WeightedGraphView(leaf, this));
    this.addRibbonIcon('share-2', 'Open Weighted Graph', () => this.openView());
    this.addCommand({
      id: 'open-weighted-graph',
      name: 'Open weighted graph',
      callback: () => this.openView(),
    });
  }

  onunload() {
    this.app.workspace.detachLeavesOfType(VIEW_TYPE);
  }

  async openView() {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE);
    if (existing.length) { this.app.workspace.revealLeaf(existing[0]); return; }
    const leaf = this.app.workspace.getLeaf(true);
    await leaf.setViewState({ type: VIEW_TYPE, active: true });
    this.app.workspace.revealLeaf(leaf);
  }
}
