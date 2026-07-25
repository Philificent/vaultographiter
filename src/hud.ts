import type { Note } from './types';
import { MODES, type ModeId } from './types';
import type { VaultStore } from './store';
import type { Replay } from './replay';
import type { SceneManager } from './scene';
import { projectColor } from './ambience';
import {
  THEMES, activeTheme, themeGlow, themeHue,
  setThemePreset, setThemeGlow, setThemeHue,
} from './theme';

const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** Per-mode legend copy: what every visual element means. */
const LEGEND_COMMON = [
  ['◉', 'node = a note · size = links + word count · colour = project folder'],
  ['─', 'line = wikilink between two notes'],
  ['✦', 'pulse = a wikilink traced from the linking note → the note it references; notes edited in the last 45 days fire more often'],
];

const LEGEND_MODE: Record<string, [string, string][]> = {
  neural: [['⧗', 'layout: force-directed — densely linked notes pull together into clusters']],
  brain: [
    ['◐', 'LEFT hemisphere = operational memory: logs, periodic notes, meta, templates, inbox'],
    ['◑', 'RIGHT hemisphere = conceptual memory: ideas, references, projects, people'],
    ['⫶', 'bright crossing fibres = corpus callosum — links bridging both hemispheres'],
  ],
  universe: [
    ['☉', 'sun = project folder · planets = its notes'],
    ['⟳', 'inner orbits move faster (Kepler-style); orbit order = note creation order'],
  ],
  matrix: [
    ['△', 'top row = hub notes (most connected 10%)'],
    ['↓', 'each stratum below = one more link-hop from the nearest hub · orphan notes sink to the bottom'],
    ['⫷', 'horizontal drift = connection gravity · stuttering particles = signal glitch'],
  ],
};

export class Hud {
  private root = document.getElementById('hud')!;
  private tooltip = document.getElementById('tooltip')!;
  private toast!: HTMLDivElement;
  private toastTimer = 0;
  private els: Record<string, HTMLElement> = {};

  constructor(
    private store: VaultStore,
    private replay: Replay,
    private sceneMgr: SceneManager,
    private onModeChange: (m: ModeId) => void
  ) {
    this.build();
    store.on('data', () => this.renderPanels());
    store.on('filter', () => this.renderPanels());
    sceneMgr.onHover = (note, x, y) => this.showTooltip(note, x, y);
    sceneMgr.onSelect = (note) => this.showCard(note);
  }

  private build(): void {
    this.root.innerHTML = `
      <div class="brand">
        <h1>VAULTOGRAPHITER</h1>
        <div class="sub" id="brand-sub">scanning vault…</div>
      </div>
      <div class="legend" id="legend"></div>
      <div class="card" id="note-card" hidden></div>
      <div class="modes" id="mode-bar"></div>
      <div class="mode-toast" id="mode-toast"></div>
      <div class="panel" id="panel"></div>
      <div class="stats" id="stats"></div>
      <div class="timeline" id="timeline">
        <button class="play" id="play-btn" title="Replay vault growth">▶</button>
        <div class="track" id="track">
          <div class="rail"></div>
          <div class="fill" id="fill"></div>
          <div class="knob" id="knob"></div>
        </div>
        <button class="speed" id="speed-btn">1×</button>
        <div class="date" id="date-label">NOW</div>
      </div>
    `;
    this.toast = this.root.querySelector('#mode-toast')!;
    for (const id of ['brand-sub', 'mode-bar', 'panel', 'stats', 'play-btn', 'track', 'fill', 'knob', 'speed-btn', 'date-label', 'legend', 'note-card']) {
      this.els[id] = this.root.querySelector(`#${id}`)!;
    }
    this.renderLegend('neural');

    // mode buttons
    const bar = this.els['mode-bar'];
    for (const m of MODES) {
      const btn = document.createElement('button');
      btn.textContent = m.label;
      btn.dataset.mode = m.id;
      if (m.id === 'neural') btn.classList.add('active');
      btn.onclick = () => {
        bar.querySelectorAll('button[data-mode]').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        this.onModeChange(m.id);
        this.renderLegend(m.id);
        this.showToast(m.blurb);
      };
      bar.appendChild(btn);
    }
    // live toggle
    const live = document.createElement('button');
    live.textContent = '● LIVE';
    live.className = 'live-btn on';
    live.title = 'Toggle live vault watching';
    live.onclick = () => {
      this.store.liveEnabled = !this.store.liveEnabled;
      live.classList.toggle('on', this.store.liveEnabled);
      this.showToast(this.store.liveEnabled ? 'live sync engaged' : 'live sync paused');
    };
    bar.appendChild(live);

    // timeline interactions
    this.els['play-btn'].onclick = () => {
      this.replay.togglePlay();
      this.showToast(this.replay.playing ? 'replaying vault growth' : 'replay paused');
    };
    this.els['speed-btn'].onclick = () => {
      const s = this.replay.cycleSpeed();
      this.els['speed-btn'].textContent = `${s}×`;
    };
    const track = this.els['track'];
    const scrub = (e: PointerEvent) => {
      const r = track.getBoundingClientRect();
      this.replay.scrubTo((e.clientX - r.left) / r.width);
    };
    track.addEventListener('pointerdown', (e) => {
      scrub(e as PointerEvent);
      const move = (ev: PointerEvent) => scrub(ev);
      const up = () => {
        removeEventListener('pointermove', move);
        removeEventListener('pointerup', up);
      };
      addEventListener('pointermove', move);
      addEventListener('pointerup', up);
    });
  }

  private showToast(text: string): void {
    this.toast.textContent = text.toUpperCase();
    this.toast.classList.add('show');
    clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => this.toast.classList.remove('show'), 1800);
  }

  private legendOpen = true;

  private renderLegend(mode: ModeId): void {
    const rows = [...LEGEND_COMMON, ...(LEGEND_MODE[mode] ?? [])];
    const legend = this.els['legend'];
    legend.innerHTML = `
      <button class="legend-head" id="legend-toggle">
        <span>LEGEND · ${esc(mode.toUpperCase())}</span><span>${this.legendOpen ? '−' : '+'}</span>
      </button>
      <div class="legend-body" ${this.legendOpen ? '' : 'hidden'}>
        ${rows.map(([k, v]) => `<div class="legend-row"><span class="k">${k}</span><span>${esc(v)}</span></div>`).join('')}
      </div>
    `;
    (legend.querySelector('#legend-toggle') as HTMLButtonElement).onclick = () => {
      this.legendOpen = !this.legendOpen;
      this.renderLegend(this.currentMode);
    };
    this.currentMode = mode;
  }

  private currentMode: ModeId = 'neural';

  /** Note detail card — metadata, link lists, content excerpt. */
  private showCard(note: Note | null): void {
    const card = this.els['note-card'];
    if (!note) {
      card.hidden = true;
      return;
    }
    const outIds = this.store.edges.filter((e) => e.source === note.id).map((e) => e.target);
    const inIds = this.store.edges.filter((e) => e.target === note.id).map((e) => e.source);
    const linkList = (ids: string[]): string =>
      ids
        .map((id) => this.store.notesById.get(id))
        .filter((n): n is Note => !!n)
        .map((n) => `<button class="card-link" data-id="${esc(n.id)}">${esc(n.title)}</button>`)
        .join('') || '<span class="card-none">none</span>';

    card.hidden = false;
    card.innerHTML = `
      <button class="card-close" id="card-close">×</button>
      <div class="card-title">${esc(note.title)}</div>
      <div class="card-path">${esc(note.path)}</div>
      <div class="card-grid">
        <span>project</span><b>${esc(note.project)}</b>
        <span>created</span><b>${new Date(note.created).toLocaleDateString()}</b>
        <span>modified</span><b>${new Date(note.modified).toLocaleDateString()}</b>
        <span>words</span><b>${note.wordCount}</b>
        <span>links</span><b>${outIds.length} out · ${inIds.length} in</b>
      </div>
      ${note.tags.length ? `<div class="t-tags">${note.tags.map((t) => `<span>#${esc(t)}</span>`).join('')}</div>` : ''}
      <h4>OUTLINKS</h4><div class="card-links">${linkList(outIds)}</div>
      <h4>BACKLINKS</h4><div class="card-links">${linkList(inIds)}</div>
      <h4>EXCERPT</h4><div class="card-excerpt" id="card-excerpt">loading…</div>
    `;
    (card.querySelector('#card-close') as HTMLButtonElement).onclick = () => (card.hidden = true);
    card.querySelectorAll<HTMLButtonElement>('.card-link').forEach((btn) => {
      btn.onclick = () => this.sceneMgr.select(btn.dataset.id!);
    });

    fetch(`/api/note?id=${encodeURIComponent(note.id)}`)
      .then((r) => r.json())
      .then((data) => {
        const el = card.querySelector('#card-excerpt');
        if (el) el.textContent = data.excerpt?.trim() || '(empty note)';
      })
      .catch(() => {
        const el = card.querySelector('#card-excerpt');
        if (el) el.textContent = '(could not load content)';
      });
  }

  /** Rebuild filter chips + stats after data/filter changes. */
  renderPanels(): void {
    const { store } = this;
    this.els['brand-sub'].textContent = `${store.vaultName} · obsidian cartography`;

    const projects = store.projectCounts();
    const tags = store.tagCounts().slice(0, 28);

    const panel = this.els['panel'];
    panel.innerHTML = `
      <h3>Search</h3>
      <input type="search" id="search-box" placeholder="find a note…" value="${esc(store.searchQuery)}" />
      <h3>Projects</h3>
      <div class="chips" id="proj-chips"></div>
      <h3>Tags</h3>
      <div class="chips" id="tag-chips"></div>
      ${store.hasActiveFilter ? '<button class="clear-btn" id="clear-btn">CLEAR FILTERS</button>' : ''}
      <h3>Theme</h3>
      <div class="chips" id="theme-swatches"></div>
      <div class="slider-row"><span>glow</span><input type="range" id="glow-slider" min="0" max="2" step="0.05" /></div>
      <div class="slider-row"><span>hue</span><input type="range" id="hue-slider" min="0" max="360" step="2" /></div>
    `;

    const searchBox = panel.querySelector('#search-box') as HTMLInputElement;
    searchBox.oninput = () => store.setSearch(searchBox.value);
    // keep focus while typing (panel re-renders on each filter change)
    if (store.searchQuery) {
      searchBox.focus();
      searchBox.setSelectionRange(searchBox.value.length, searchBox.value.length);
    }

    const projChips = panel.querySelector('#proj-chips')!;
    projects.forEach(([p, count], i) => {
      const chip = document.createElement('span');
      chip.className = 'chip proj' + (store.activeProjects.has(p) ? ' active' : '');
      const sw = document.createElement('span');
      sw.className = 'swatch';
      sw.style.background = `#${projectColor(p, this.projectPaletteIndex(p)).getHexString()}`;
      chip.appendChild(sw);
      chip.appendChild(document.createTextNode(p));
      const n = document.createElement('span');
      n.className = 'n';
      n.textContent = String(count);
      chip.appendChild(n);
      chip.onclick = () => store.toggleProject(p);
      projChips.appendChild(chip);
    });

    const tagChips = panel.querySelector('#tag-chips')!;
    if (tags.length === 0) tagChips.innerHTML = '<span style="font-size:10px;color:var(--dim)">no tags found</span>';
    tags.forEach(([t, count]) => {
      const chip = document.createElement('span');
      chip.className = 'chip' + (store.activeTags.has(t) ? ' active' : '');
      chip.textContent = `#${t}`;
      const n = document.createElement('span');
      n.className = 'n';
      n.textContent = String(count);
      chip.appendChild(n);
      chip.onclick = () => store.toggleTag(t);
      tagChips.appendChild(chip);
    });

    (panel.querySelector('#clear-btn') as HTMLButtonElement | null)?.addEventListener('click', () =>
      store.clearFilters()
    );

    // theme swatches + sliders
    const swatches = panel.querySelector('#theme-swatches')!;
    for (const t of THEMES) {
      const chip = document.createElement('button');
      chip.className = 'chip theme-chip' + (t.id === activeTheme().id ? ' current' : '');
      const sw = document.createElement('span');
      sw.className = 'swatch';
      sw.style.background = `linear-gradient(135deg, ${t.ui.accent}, ${t.ui.accent2})`;
      chip.appendChild(sw);
      chip.appendChild(document.createTextNode(t.label));
      chip.onclick = () => {
        setThemePreset(t.id);
        this.sceneMgr.applyTheme();
        this.paletteCache.clear();
        this.renderPanels();
        this.showToast(`theme · ${t.label}`);
      };
      swatches.appendChild(chip);
    }
    const glowSlider = panel.querySelector('#glow-slider') as HTMLInputElement;
    glowSlider.value = String(themeGlow());
    glowSlider.oninput = () => {
      setThemeGlow(Number(glowSlider.value));
      this.sceneMgr.applyGlow();
    };
    const hueSlider = panel.querySelector('#hue-slider') as HTMLInputElement;
    hueSlider.value = String(themeHue());
    hueSlider.oninput = () => {
      setThemeHue(Number(hueSlider.value));
      this.sceneMgr.applyTheme();
    };
    // refresh chip swatch colours only once the drag ends (keeps the slider alive mid-drag)
    hueSlider.onchange = () => {
      this.paletteCache.clear();
      this.renderPanels();
    };

    const visible = store.notes.filter((n) => store.matchesFilter(n)).length;
    this.els['stats'].innerHTML = `
      <div><b>${store.notes.length}</b> notes</div>
      <div><b>${store.edges.length}</b> links</div>
      <div><b>${projects.length}</b> projects</div>
      ${store.hasActiveFilter ? `<div><b>${visible}</b> matching</div>` : ''}
    `;
  }

  private paletteCache = new Map<string, number>();
  private projectPaletteIndex(p: string): number {
    if (!this.paletteCache.has(p)) {
      // mirror LayoutEngine ordering: sorted unique project names
      const sorted = [...new Set(this.store.notes.map((n) => n.project))].sort();
      sorted.forEach((name, i) => this.paletteCache.set(name, i));
    }
    return this.paletteCache.get(p) ?? 0;
  }

  /** Called every frame to sync the timeline UI. */
  tick(): void {
    this.paletteCache.clear();
    const pct = `${(this.replay.t * 100).toFixed(2)}%`;
    (this.els['fill'] as HTMLElement).style.width = pct;
    (this.els['knob'] as HTMLElement).style.left = pct;
    this.els['date-label'].textContent = this.replay.formatCurrent();
    this.els['play-btn'].textContent = this.replay.playing ? '❚❚' : '▶';
  }

  private showTooltip(note: Note | null, x: number, y: number): void {
    if (!note) {
      this.tooltip.hidden = true;
      return;
    }
    this.tooltip.hidden = false;
    const date = new Date(note.created).toLocaleDateString();
    this.tooltip.innerHTML = `
      <div class="t-title">${esc(note.title)}</div>
      <div class="t-meta">${esc(note.project)} · ${note.wordCount} words · ${date}</div>
      ${note.tags.length ? `<div class="t-tags">${note.tags.map((t) => `<span>#${esc(t)}</span>`).join('')}</div>` : ''}
    `;
    const pad = 16;
    const rect = this.tooltip.getBoundingClientRect();
    let tx = x + pad, ty = y + pad;
    if (tx + rect.width > innerWidth - 8) tx = x - rect.width - pad;
    if (ty + rect.height > innerHeight - 8) ty = y - rect.height - pad;
    this.tooltip.style.left = `${tx}px`;
    this.tooltip.style.top = `${ty}px`;
  }
}
