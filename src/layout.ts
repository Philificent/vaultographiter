import * as THREE from 'three';
import type { Note, Edge, ModeId } from './types';

/** Deterministic hash -> [0,1) for stable per-note randomness. */
export function hash01(str: string, salt = 0): number {
  let h = 2166136261 ^ salt;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 100000) / 100000;
}

// ─────────────────────────────────────────────────────────────
// 3D force simulation (O(n²) repulsion — fine for vault-sized graphs)
// ─────────────────────────────────────────────────────────────

interface SimNode {
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
}

export class ForceSim {
  private nodes: SimNode[] = [];
  private ids: string[] = [];
  private index = new Map<string, number>();
  private springs: [number, number][] = [];
  private degree: number[] = [];
  alpha = 1;

  setGraph(notes: Note[], edges: Edge[]): void {
    const prev = new Map<string, SimNode>();
    this.ids.forEach((id, i) => prev.set(id, this.nodes[i]));

    this.ids = notes.map((n) => n.id);
    this.index = new Map(this.ids.map((id, i) => [id, i]));
    this.nodes = notes.map((n, i) => {
      const old = prev.get(n.id);
      if (old) return old;
      // seed new nodes on a deterministic sphere shell
      const u = hash01(n.id, 1) * Math.PI * 2;
      const v = Math.acos(2 * hash01(n.id, 2) - 1);
      const r = 60 + hash01(n.id, 3) * 120;
      return {
        x: r * Math.sin(v) * Math.cos(u),
        y: r * Math.cos(v),
        z: r * Math.sin(v) * Math.sin(u),
        vx: 0, vy: 0, vz: 0,
      };
    });

    this.springs = [];
    this.degree = new Array(this.nodes.length).fill(0);
    for (const e of edges) {
      const a = this.index.get(e.source);
      const b = this.index.get(e.target);
      if (a === undefined || b === undefined) continue;
      this.springs.push([a, b]);
      this.degree[a]++;
      this.degree[b]++;
    }
    this.alpha = 1;
  }

  degreeOf(id: string): number {
    const i = this.index.get(id);
    return i === undefined ? 0 : this.degree[i];
  }

  reheat(amount = 0.6): void {
    this.alpha = Math.max(this.alpha, amount);
  }

  tick(): void {
    const n = this.nodes.length;
    if (n === 0) return;
    this.alpha += (0.06 - this.alpha) * 0.015; // settle toward gentle idle motion
    const a = this.alpha;

    const REPULSE = 950;
    const SPRING = 0.035;
    const REST = 42;
    const CENTER = 0.012;
    const DAMP = 0.88;

    // repulsion
    for (let i = 0; i < n; i++) {
      const ni = this.nodes[i];
      for (let j = i + 1; j < n; j++) {
        const nj = this.nodes[j];
        let dx = ni.x - nj.x, dy = ni.y - nj.y, dz = ni.z - nj.z;
        let d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < 1) { d2 = 1; dx = hash01(String(i * n + j)) - 0.5; }
        const f = (REPULSE / d2) * a;
        const inv = 1 / Math.sqrt(d2);
        dx *= inv; dy *= inv; dz *= inv;
        ni.vx += dx * f; ni.vy += dy * f; ni.vz += dz * f;
        nj.vx -= dx * f; nj.vy -= dy * f; nj.vz -= dz * f;
      }
    }
    // springs
    for (const [i, j] of this.springs) {
      const ni = this.nodes[i], nj = this.nodes[j];
      const dx = nj.x - ni.x, dy = nj.y - ni.y, dz = nj.z - ni.z;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
      const f = (d - REST) * SPRING * a;
      const ux = dx / d, uy = dy / d, uz = dz / d;
      ni.vx += ux * f; ni.vy += uy * f; ni.vz += uz * f;
      nj.vx -= ux * f; nj.vy -= uy * f; nj.vz -= uz * f;
    }
    // centering + integrate
    for (const nd of this.nodes) {
      nd.vx -= nd.x * CENTER * a;
      nd.vy -= nd.y * CENTER * a;
      nd.vz -= nd.z * CENTER * a;
      nd.vx *= DAMP; nd.vy *= DAMP; nd.vz *= DAMP;
      nd.x += nd.vx; nd.y += nd.vy; nd.z += nd.vz;
    }
  }

  position(id: string, out: THREE.Vector3): boolean {
    const i = this.index.get(id);
    if (i === undefined) return false;
    const nd = this.nodes[i];
    out.set(nd.x, nd.y, nd.z);
    return true;
  }
}

// ─────────────────────────────────────────────────────────────
// Mode layouts — every mode answers "where should note X be at time t?"
// ─────────────────────────────────────────────────────────────

export interface OrbitInfo {
  sun: THREE.Vector3;
  radius: number;
  speed: number;
  phase: number;
  tilt: number;
}

/** Folder names that read as operational/temporal memory → left hemisphere. */
const OPERATIONAL_RE = /log|periodic|daily|journal|inbox|meta|template|archive|attachment|base/i;

export class LayoutEngine {
  readonly sim = new ForceSim();
  private notes: Note[] = [];
  private projects: string[] = [];
  private projectIndex = new Map<string, number>();

  // universe
  sunPositions = new Map<string, THREE.Vector3>();
  private orbits = new Map<string, OrbitInfo>();
  // brain
  private brainPos = new Map<string, THREE.Vector3>();
  private hemispheres = new Map<string, 1 | -1>(); // project -> +1 right (conceptual) / -1 left (operational)
  // matrix
  private matrixDepth = new Map<string, number>(); // link-hops from nearest hub
  maxMatrixDepth = 0;

  setGraph(notes: Note[], edges: Edge[]): void {
    this.notes = notes;
    this.projects = [...new Set(notes.map((n) => n.project))].sort();
    this.projectIndex = new Map(this.projects.map((p, i) => [p, i]));
    this.sim.setGraph(notes, edges);
    this.classifyHemispheres();
    this.computeBrain();
    this.computeUniverse();
    this.computeMatrixDepths(edges);
  }

  get projectList(): string[] {
    return this.projects;
  }

  hemisphereOf(project: string): 1 | -1 {
    return this.hemispheres.get(project) ?? 1;
  }

  depthOf(noteId: string): number {
    return this.matrixDepth.get(noteId) ?? 0;
  }

  private classifyHemispheres(): void {
    this.hemispheres.clear();
    for (const p of this.projects) {
      this.hemispheres.set(p, OPERATIONAL_RE.test(p) ? -1 : 1);
    }
  }

  /** Brain: hemispheres are semantic — operational folders left, conceptual right. */
  private computeBrain(): void {
    this.brainPos.clear();
    const byProject = new Map<string, Note[]>();
    for (const n of this.notes) {
      if (!byProject.has(n.project)) byProject.set(n.project, []);
      byProject.get(n.project)!.push(n);
    }

    // count projects per hemisphere so anchors sweep evenly front-to-back on each side
    const perSideTotal = { [-1]: 0, [1]: 0 } as Record<number, number>;
    for (const p of byProject.keys()) perSideTotal[this.hemisphereOf(p)]++;
    const perSideSeen = { [-1]: 0, [1]: 0 } as Record<number, number>;

    const R = 120; // hemisphere radius
    const GAP = 18; // longitudinal fissure
    for (const [project, group] of byProject) {
      const side = this.hemisphereOf(project);
      const sideIdx = perSideSeen[side]++;
      const t = perSideTotal[side] > 1 ? sideIdx / (perSideTotal[side] - 1) : 0.5;
      const theta = -0.9 + t * 1.9; // front-to-back sweep
      const anchorPhi = 0.45 + hash01(project, 7) * 0.5; // stay on the top band
      const anchor = new THREE.Vector3(
        Math.cos(anchorPhi) * side,
        Math.sin(anchorPhi),
        Math.sin(theta)
      ).normalize();

      group.forEach((note, gi) => {
        // fibonacci spiral inside a cap around the anchor
        const k = gi + 0.5;
        const capR = 0.3 + Math.min(0.6, group.length * 0.025);
        const ang = k * 2.39996; // golden angle
        const rad = capR * Math.sqrt(k / group.length);
        // build tangent basis
        const up = Math.abs(anchor.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
        const t1 = new THREE.Vector3().crossVectors(anchor, up).normalize();
        const t2 = new THREE.Vector3().crossVectors(anchor, t1).normalize();
        const dir = anchor
          .clone()
          .addScaledVector(t1, Math.cos(ang) * rad)
          .addScaledVector(t2, Math.sin(ang) * rad)
          .normalize();
        // keep on the correct hemisphere
        if (dir.x * side < 0.05) dir.x = 0.05 * side + Math.abs(dir.x) * side * 0.4;
        dir.normalize();

        // cortical wrinkles: radial ripple by angular noise
        const wr = 1 + 0.06 * Math.sin(dir.y * 14 + dir.z * 11) * Math.cos(dir.z * 9);
        const p = new THREE.Vector3(
          dir.x * R * 0.82 * wr + side * GAP,
          dir.y * R * 0.72 * wr,
          dir.z * R * wr
        );
        this.brainPos.set(note.id, p);
      });
    }
  }

  /** Universe: each project is a sun on a galactic spiral; notes orbit their sun. */
  private computeUniverse(): void {
    this.sunPositions.clear();
    this.orbits.clear();

    const counts = new Map<string, number>();
    for (const n of this.notes) counts.set(n.project, (counts.get(n.project) ?? 0) + 1);
    const ordered = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([p]) => p);

    ordered.forEach((project, i) => {
      const armAngle = i * 2.39996;
      const dist = i === 0 ? 0 : 95 * Math.sqrt(i); // compact galactic spiral
      this.sunPositions.set(
        project,
        new THREE.Vector3(
          Math.cos(armAngle) * dist,
          (hash01(project, 11) - 0.5) * 40,
          Math.sin(armAngle) * dist
        )
      );
    });

    const perProjectCounter = new Map<string, number>();
    for (const n of this.notes) {
      const idx = perProjectCounter.get(n.project) ?? 0;
      perProjectCounter.set(n.project, idx + 1);
      const sun = this.sunPositions.get(n.project)!;
      const total = counts.get(n.project) ?? 1;
      // orbit span capped so big projects never swallow neighboring systems
      const span = Math.min(52, 6 + total * 2.5);
      const radius = 14 + (idx / Math.max(1, total - 1)) * span + hash01(n.id, 21) * 2.5;
      this.orbits.set(n.id, {
        sun,
        radius,
        speed: 0.55 / Math.sqrt(radius / 13), // Keplerish: inner planets faster
        phase: hash01(n.id, 22) * Math.PI * 2,
        tilt: (hash01(n.id, 23) - 0.5) * 0.7,
      });
    }
  }

  /**
   * Matrix: hub notes (highest degree) surface at the top; every other note
   * hangs below at Y = link-hops from its nearest hub (BFS). X/Z come from the
   * force sim, so "connection gravity" still shapes the horizontal drift.
   */
  private computeMatrixDepths(edges: Edge[]): void {
    this.matrixDepth.clear();
    const adj = new Map<string, string[]>();
    const degree = new Map<string, number>();
    for (const n of this.notes) { adj.set(n.id, []); degree.set(n.id, 0); }
    for (const e of edges) {
      adj.get(e.source)?.push(e.target);
      adj.get(e.target)?.push(e.source);
      degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
      degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
    }

    // hubs: top ~10% most-connected notes (at least one, must actually link)
    const ranked = [...degree.entries()].filter(([, d]) => d > 0).sort((a, b) => b[1] - a[1]);
    const hubCount = Math.max(1, Math.round(ranked.length * 0.1));
    const queue: string[] = [];
    for (let i = 0; i < hubCount && i < ranked.length; i++) {
      this.matrixDepth.set(ranked[i][0], 0);
      queue.push(ranked[i][0]);
    }

    // multi-source BFS
    let head = 0;
    let maxD = 0;
    while (head < queue.length) {
      const cur = queue[head++];
      const d = this.matrixDepth.get(cur)!;
      for (const next of adj.get(cur) ?? []) {
        if (this.matrixDepth.has(next)) continue;
        this.matrixDepth.set(next, d + 1);
        maxD = Math.max(maxD, d + 1);
        queue.push(next);
      }
    }
    // orphans (no links at all) sink to the lowest stratum
    for (const n of this.notes) {
      if (!this.matrixDepth.has(n.id)) this.matrixDepth.set(n.id, maxD + 1);
    }
    this.maxMatrixDepth = maxD + 1;
  }

  /** Per-frame target position for a note in the given mode. */
  target(mode: ModeId, note: Note, time: number, out: THREE.Vector3): void {
    switch (mode) {
      case 'neural': {
        if (!this.sim.position(note.id, out)) out.set(0, 0, 0);
        return;
      }
      case 'brain': {
        const p = this.brainPos.get(note.id);
        if (!p) { out.set(0, 0, 0); return; }
        // gentle breathing
        const breathe = 1 + 0.015 * Math.sin(time * 0.8 + p.y * 0.05);
        out.copy(p).multiplyScalar(breathe);
        return;
      }
      case 'universe': {
        const o = this.orbits.get(note.id);
        if (!o) { out.set(0, 0, 0); return; }
        const a = o.phase + time * o.speed;
        out.set(
          o.sun.x + Math.cos(a) * o.radius,
          o.sun.y + Math.sin(a) * o.radius * Math.sin(o.tilt),
          o.sun.z + Math.sin(a) * o.radius * Math.cos(o.tilt)
        );
        return;
      }
      case 'matrix': {
        // horizontal position: connection gravity from the live force sim
        if (!this.sim.position(note.id, out)) out.set(0, 0, 0);
        const depth = this.matrixDepth.get(note.id) ?? 0;
        const spread = 1.15 + depth * 0.08; // lower strata fan out slightly
        out.x *= spread;
        out.z *= spread;
        // vertical position: strata by link-hops from the nearest hub
        out.y = 110 - depth * 52 + Math.sin(time * 0.6 + hash01(note.id, 44) * 6.28) * 3;
        return;
      }
    }
  }
}
