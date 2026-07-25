import type { Note, Edge, VaultSnapshot, PatchEvent } from './types';

type Listener = () => void;

/**
 * Client-side vault state: snapshot + live WebSocket patches + filter state.
 * Emits coarse-grained events the renderer and HUD subscribe to.
 */
export class VaultStore {
  vaultName = '';
  notes: Note[] = [];
  edges: Edge[] = [];
  notesById = new Map<string, Note>();

  // filters
  activeTags = new Set<string>();
  activeProjects = new Set<string>();
  searchQuery = '';

  // live mode
  liveEnabled = true;
  lastLiveEvent: PatchEvent | null = null;

  private listeners = new Map<string, Set<Listener>>();

  on(event: 'data' | 'filter' | 'live', fn: Listener): void {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(fn);
  }

  private emit(event: string): void {
    this.listeners.get(event)?.forEach((fn) => fn());
  }

  async load(): Promise<void> {
    const res = await fetch('/api/vault');
    const snap: VaultSnapshot = await res.json();
    this.vaultName = snap.vaultName;
    this.applySnapshot(snap.notes, snap.edges);
    this.connectWs();
  }

  private applySnapshot(notes: Note[], edges: Edge[]): void {
    this.notes = notes;
    this.edges = edges;
    this.notesById = new Map(notes.map((n) => [n.id, n]));
    this.emit('data');
  }

  private connectWs(): void {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.onmessage = (evt) => {
      const msg = JSON.parse(evt.data);
      if (msg.type !== 'patch' || !this.liveEnabled) return;
      const events: PatchEvent[] = msg.events;
      const byId = new Map(this.notesById);
      for (const e of events) {
        if (e.type === 'delete') byId.delete(e.id);
        else byId.set(e.note.id, e.note);
      }
      const notes = [...byId.values()].sort((a, b) => a.created - b.created);
      this.applySnapshot(notes, msg.edges);
      this.lastLiveEvent = events[events.length - 1] ?? null;
      this.emit('live');
    };
    ws.onclose = () => setTimeout(() => this.connectWs(), 2000);
  }

  // ── filters ────────────────────────────────────────────────

  toggleTag(tag: string): void {
    this.activeTags.has(tag) ? this.activeTags.delete(tag) : this.activeTags.add(tag);
    this.emit('filter');
  }

  toggleProject(project: string): void {
    this.activeProjects.has(project)
      ? this.activeProjects.delete(project)
      : this.activeProjects.add(project);
    this.emit('filter');
  }

  setSearch(q: string): void {
    this.searchQuery = q.trim().toLowerCase();
    this.emit('filter');
  }

  clearFilters(): void {
    this.activeTags.clear();
    this.activeProjects.clear();
    this.searchQuery = '';
    this.emit('filter');
  }

  /** True when a note passes the current tag/project/search filters. */
  matchesFilter(note: Note): boolean {
    if (this.activeProjects.size > 0 && !this.activeProjects.has(note.project)) return false;
    if (this.activeTags.size > 0 && !note.tags.some((t) => this.activeTags.has(t))) return false;
    if (this.searchQuery && !note.title.toLowerCase().includes(this.searchQuery)) return false;
    return true;
  }

  get hasActiveFilter(): boolean {
    return this.activeTags.size > 0 || this.activeProjects.size > 0 || this.searchQuery.length > 0;
  }

  /** All tags sorted by frequency. */
  tagCounts(): [string, number][] {
    const counts = new Map<string, number>();
    for (const n of this.notes)
      for (const t of n.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }

  /** All projects (top-level folders) sorted by note count. */
  projectCounts(): [string, number][] {
    const counts = new Map<string, number>();
    for (const n of this.notes) counts.set(n.project, (counts.get(n.project) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }
}
