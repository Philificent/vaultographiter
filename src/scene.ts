import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import type { Note, ModeId } from './types';
import type { VaultStore } from './store';
import { LayoutEngine, hash01 } from './layout';
import { Replay } from './replay';
import {
  projectColor, MATRIX_GREEN,
  makeStarfield, makeBrainShell, makeMatrixRain, tintBrainShell,
  makeGlassNodeMaterial,
} from './ambience';
import { activeTheme, themeGlow } from './theme';

interface NodeState {
  note: Note;
  pos: THREE.Vector3;
  scale: number;
  targetScale: number;
  brightness: number; // 0..1 current
  flash: number; // birth flash timer
  born: boolean;
}

const MAX_PULSES = 240;
const tmpV = new THREE.Vector3();
const tmpM = new THREE.Matrix4();
const tmpQ = new THREE.Quaternion();
const tmpS = new THREE.Vector3();
const tmpC = new THREE.Color();

export class SceneManager {
  mode: ModeId = 'neural';
  onHover: (note: Note | null, x: number, y: number) => void = () => {};
  onSelect: (note: Note | null) => void = () => {};

  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private composer: EffectComposer;
  private bloom: UnrealBloomPass;

  private nodeMesh: THREE.InstancedMesh | null = null;
  private nodeStates: NodeState[] = [];
  private nodeIndex = new Map<string, number>();

  private edgeLines: THREE.LineSegments | null = null;
  private edgePairs: [number, number][] = [];

  private pulseGeo = new THREE.BufferGeometry();
  private pulses: { edge: number; t: number; speed: number }[] = [];
  private pulseAccum = 0;
  private hotEdges: number[] = []; // edges whose source note was modified recently
  private edgesBySource = new Map<string, number[]>();

  private sunGroup = new THREE.Group();
  private ringGroup = new THREE.Group();
  private starfield = makeStarfield();
  private brainShell = makeBrainShell();
  private matrixRain = makeMatrixRain();

  private colors = new Map<string, THREE.Color>(); // project -> color
  private matrixBlend = 0; // 0 = normal palette, 1 = matrix green
  private selectedId: string | null = null;
  private hoveredId: string | null = null;
  private focusTarget = new THREE.Vector3();
  private focusTimer = 0;
  private pointer = new THREE.Vector2();
  private pointerPx = { x: 0, y: 0 };
  private neighborSets = new Map<string, Set<string>>();

  constructor(
    canvas: HTMLCanvasElement,
    private store: VaultStore,
    private layout: LayoutEngine,
    private replay: Replay
  ) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.setSize(innerWidth, innerHeight);

    this.camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.1, 4000);
    this.camera.position.set(0, 80, 360);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.06;
    this.controls.maxDistance = 1200;
    this.controls.minDistance = 20;

    this.scene.background = new THREE.Color('#05060a');
    this.scene.fog = new THREE.FogExp2('#05060a', 0.00075);

    // ambience
    this.scene.add(this.starfield);
    this.scene.add(this.brainShell);
    this.scene.add(this.sunGroup);
    this.scene.add(this.ringGroup);
    this.scene.add(this.camera);
    this.matrixRain.position.set(0, 0, -900);
    this.camera.add(this.matrixRain);
    this.starfield.visible = false;
    this.brainShell.visible = false;

    // pulses
    const pPos = new Float32Array(MAX_PULSES * 3);
    const pCol = new Float32Array(MAX_PULSES * 3);
    this.pulseGeo.setAttribute('position', new THREE.BufferAttribute(pPos, 3));
    this.pulseGeo.setAttribute('color', new THREE.BufferAttribute(pCol, 3));
    const pulsePoints = new THREE.Points(
      this.pulseGeo,
      new THREE.PointsMaterial({
        size: 3.2,
        vertexColors: true,
        transparent: true,
        opacity: 0.95,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      })
    );
    this.scene.add(pulsePoints);

    // post-processing
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.75, 0.35, 0.45);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());

    addEventListener('resize', () => {
      this.camera.aspect = innerWidth / innerHeight;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(innerWidth, innerHeight);
      this.composer.setSize(innerWidth, innerHeight);
    });

    canvas.addEventListener('pointermove', (e) => {
      this.pointer.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
      this.pointerPx = { x: e.clientX, y: e.clientY };
    });
    canvas.addEventListener('click', () => this.handleClick());
  }

  // ── graph (re)build ─────────────────────────────────────────

  rebuild(): void {
    const notes = this.store.notes;
    const prevPos = new Map<string, THREE.Vector3>();
    const prevBorn = new Map<string, boolean>();
    for (const s of this.nodeStates) {
      prevPos.set(s.note.id, s.pos);
      prevBorn.set(s.note.id, s.born);
    }

    // colors per project
    this.colors.clear();
    this.layout.projectList.forEach((p, i) => this.colors.set(p, projectColor(p, i)));

    // node states
    this.nodeStates = notes.map((note) => {
      const isNew = !prevPos.has(note.id);
      return {
        note,
        pos: prevPos.get(note.id) ?? new THREE.Vector3(
          (hash01(note.id, 51) - 0.5) * 40,
          (hash01(note.id, 52) - 0.5) * 40,
          (hash01(note.id, 53) - 0.5) * 40
        ),
        scale: isNew ? 0 : 1,
        targetScale: 1,
        brightness: 1,
        flash: isNew && prevPos.size > 0 ? 1 : 0, // flash newly-added notes (live mode)
        born: prevBorn.get(note.id) ?? true,
      };
    });
    this.nodeIndex = new Map(notes.map((n, i) => [n.id, i]));

    // instanced node mesh
    if (this.nodeMesh) {
      this.scene.remove(this.nodeMesh);
      this.nodeMesh.geometry.dispose();
      (this.nodeMesh.material as THREE.Material).dispose();
    }
    const geo = new THREE.IcosahedronGeometry(1.9, 3); // extra subdiv → smooth fresnel rim
    const mat = makeGlassNodeMaterial();
    this.nodeMesh = new THREE.InstancedMesh(geo, mat, Math.max(1, notes.length));
    this.nodeMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    for (let i = 0; i < notes.length; i++) this.nodeMesh.setColorAt(i, new THREE.Color(1, 1, 1));
    this.scene.add(this.nodeMesh);

    // edges (orientation preserved: [source, target] — pulses flow along it)
    this.edgePairs = [];
    this.neighborSets.clear();
    this.edgesBySource.clear();
    this.hotEdges = [];
    const HOT_WINDOW = 45 * 24 * 3600 * 1000; // notes edited in the last 45 days "fire" more
    const now = Date.now();
    for (const e of this.store.edges) {
      const a = this.nodeIndex.get(e.source);
      const b = this.nodeIndex.get(e.target);
      if (a === undefined || b === undefined) continue;
      const edgeIdx = this.edgePairs.length;
      this.edgePairs.push([a, b]);
      if (!this.neighborSets.has(e.source)) this.neighborSets.set(e.source, new Set());
      if (!this.neighborSets.has(e.target)) this.neighborSets.set(e.target, new Set());
      this.neighborSets.get(e.source)!.add(e.target);
      this.neighborSets.get(e.target)!.add(e.source);
      if (!this.edgesBySource.has(e.source)) this.edgesBySource.set(e.source, []);
      this.edgesBySource.get(e.source)!.push(edgeIdx);
      const src = this.store.notesById.get(e.source);
      if (src && now - src.modified < HOT_WINDOW) this.hotEdges.push(edgeIdx);
    }
    if (this.edgeLines) {
      this.scene.remove(this.edgeLines);
      this.edgeLines.geometry.dispose();
      (this.edgeLines.material as THREE.Material).dispose();
    }
    const eGeo = new THREE.BufferGeometry();
    eGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.edgePairs.length * 6), 3));
    eGeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(this.edgePairs.length * 6), 3));
    this.edgeLines = new THREE.LineSegments(
      eGeo,
      new THREE.LineBasicMaterial({
        vertexColors: true,
        transparent: true,
        opacity: 0.5,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      })
    );
    this.scene.add(this.edgeLines);

    this.rebuildSuns();
    this.pulses = [];
  }

  private rebuildSuns(): void {
    this.sunGroup.clear();
    this.ringGroup.clear();
    const counts = new Map<string, number>();
    for (const n of this.store.notes) counts.set(n.project, (counts.get(n.project) ?? 0) + 1);

    const sunGeo = new THREE.IcosahedronGeometry(1, 3);
    for (const [project, pos] of this.layout.sunPositions) {
      const color = this.colors.get(project) ?? new THREE.Color('#fff');
      const mesh = new THREE.Mesh(
        sunGeo,
        new THREE.MeshBasicMaterial({ color: color.clone().multiplyScalar(0.9), toneMapped: false })
      );
      const size = 2.6 + Math.sqrt(counts.get(project) ?? 1) * 0.9;
      mesh.position.copy(pos);
      mesh.scale.setScalar(size);
      mesh.userData.project = project;
      this.sunGroup.add(mesh);

      // faint orbit guide rings around each sun
      const ringMat = new THREE.LineBasicMaterial({
        color: color.clone().multiplyScalar(0.7),
        transparent: true,
        opacity: 0.07,
      });
      const circle = new THREE.BufferGeometry().setFromPoints(
        Array.from({ length: 65 }, (_, i) => {
          const a = (i / 64) * Math.PI * 2;
          return new THREE.Vector3(Math.cos(a), 0, Math.sin(a));
        })
      );
      const n = counts.get(project) ?? 0;
      const span = Math.min(52, 6 + n * 2.5); // mirrors LayoutEngine orbit radii
      const ringCount = Math.min(n, 6);
      for (let r = 0; r < ringCount; r++) {
        const ring = new THREE.Line(circle, ringMat);
        ring.position.copy(pos);
        ring.scale.setScalar(14 + (r / Math.max(1, ringCount - 1)) * span);
        ring.userData.project = project;
        this.ringGroup.add(ring);
      }
    }
    this.sunGroup.visible = this.mode === 'universe';
    this.ringGroup.visible = this.mode === 'universe';
  }

  // ── mode switching ──────────────────────────────────────────

  private camTween = 0;
  private camFrom = new THREE.Vector3();
  private camTo = new THREE.Vector3();

  setMode(mode: ModeId): void {
    this.mode = mode;
    this.layout.sim.reheat(0.5);
    this.selectedId = null;
    this.starfield.visible = mode === 'universe';
    this.brainShell.visible = mode === 'brain';
    this.sunGroup.visible = mode === 'universe';
    this.ringGroup.visible = mode === 'universe';
    this.matrixRain.visible = true; // fades via uniform
    document.body.classList.toggle('matrix-theme', mode === 'matrix');

    const fogDensity = mode === 'universe' ? 0.0003 : mode === 'matrix' ? 0.001 : 0.00075;
    (this.scene.fog as THREE.FogExp2).density = fogDensity;
    this.applyGlow();

    // fly the camera to a vantage point suited to the new layout
    this.camFrom.copy(this.camera.position);
    switch (mode) {
      case 'neural': this.camTo.set(0, 80, 360); break;
      case 'brain': this.camTo.set(0, 130, 320); break; // face-on: left/right hemispheres read true
      case 'universe': this.camTo.set(0, 340, 520); break;
      case 'matrix': this.camTo.set(0, 30, 430); break; // step back to read the vertical strata
    }
    this.camTween = 1;
    this.controls.target.set(0, 0, 0);
  }

  // ── theming ─────────────────────────────────────────────────

  /** Bloom strength = per-mode base × user glow multiplier. */
  applyGlow(): void {
    const base = this.mode === 'matrix' ? 1.0 : this.mode === 'universe' ? 0.85 : 0.75;
    this.bloom.strength = base * themeGlow();
  }

  /** Re-apply the active theme: background, fog colour, palette, brain tint, glow. */
  applyTheme(): void {
    const t = activeTheme();
    (this.scene.background as THREE.Color).set(t.sceneBg);
    (this.scene.fog as THREE.FogExp2).color.set(t.sceneBg);

    // refresh the project → colour map; nodes/edges/pulses read it every frame
    this.layout.projectList.forEach((p, i) => this.colors.set(p, projectColor(p, i)));

    // recolour suns + orbit rings in place (no geometry churn)
    for (const child of this.sunGroup.children) {
      const c = this.colors.get(child.userData.project);
      if (c) ((child as THREE.Mesh).material as THREE.MeshBasicMaterial).color.copy(c).multiplyScalar(0.9);
    }
    for (const child of this.ringGroup.children) {
      const c = this.colors.get(child.userData.project);
      if (c) ((child as THREE.Line).material as THREE.LineBasicMaterial).color.copy(c).multiplyScalar(0.7);
    }

    tintBrainShell(this.brainShell, new THREE.Color(t.ui.accent2), new THREE.Color(t.ui.accent));
    this.applyGlow();
  }

  // ── interaction ─────────────────────────────────────────────

  /** Screen-space picking: nearest projected node within a generous pixel radius. */
  private pick(): Note | null {
    if (this.nodeStates.length === 0) return null;
    const tanHalfFov = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
    let best: Note | null = null;
    let bestD = Infinity;
    for (const st of this.nodeStates) {
      if (st.scale < 0.25) continue;
      tmpV.copy(st.pos).project(this.camera);
      if (tmpV.z > 1 || tmpV.z < -1) continue;
      const dx = (tmpV.x - this.pointer.x) * (innerWidth / 2);
      const dy = (tmpV.y - this.pointer.y) * (innerHeight / 2);
      const d = Math.hypot(dx, dy);
      // projected node radius in px, padded for easy targeting
      const dist = this.camera.position.distanceTo(st.pos);
      const projR = ((1.9 * st.scale) / (dist * tanHalfFov)) * (innerHeight / 2);
      const threshold = Math.max(14, projR * 2.2);
      if (d < threshold && d < bestD) {
        bestD = d;
        best = st.note;
      }
    }
    return best;
  }

  private handleClick(): void {
    const note = this.pick();
    if (note) this.select(note.id);
    else {
      this.selectedId = null;
      this.onSelect(null);
    }
  }

  /** Select a note programmatically (also used by the detail card's link lists). */
  select(noteId: string): void {
    const idx = this.nodeIndex.get(noteId);
    if (idx === undefined) return;
    this.selectedId = noteId;
    this.focusTarget.copy(this.nodeStates[idx].pos);
    this.focusTimer = 1.4;
    this.onSelect(this.nodeStates[idx].note);
  }

  flash(noteId: string): void {
    const idx = this.nodeIndex.get(noteId);
    if (idx !== undefined) this.nodeStates[idx].flash = 1;
    // burst of pulses down this note's outgoing links
    for (const e of (this.edgesBySource.get(noteId) ?? []).slice(0, 8)) {
      if (this.pulses.length < MAX_PULSES) this.pulses.push({ edge: e, t: 0, speed: 0.9 });
    }
  }

  // ── frame update ────────────────────────────────────────────

  update(dt: number, time: number): void {
    const { store, replay, layout } = this;
    // matrix uses the sim for X/Z "connection gravity", so tick it there too
    if (this.mode === 'neural' || this.mode === 'matrix') layout.sim.tick();

    // matrix blend + rain fade
    const matrixTargetBlend = this.mode === 'matrix' ? 1 : 0;
    this.matrixBlend += (matrixTargetBlend - this.matrixBlend) * Math.min(1, dt * 3);
    const rainMat = this.matrixRain.material as THREE.ShaderMaterial;
    rainMat.uniforms.uTime.value = time;
    rainMat.uniforms.uOpacity.value = this.matrixBlend;
    if (this.matrixBlend < 0.01 && this.mode !== 'matrix') this.matrixRain.visible = false;

    // starfield slow spin
    this.starfield.rotation.y += dt * 0.004;

    const lerpK = 1 - Math.exp(-dt * 4.2);
    const scaleK = 1 - Math.exp(-dt * 6);

    const hovered = this.hoveredId;
    const selected = this.selectedId;
    const selectedNeighbors = selected ? this.neighborSets.get(selected) : undefined;

    // ── nodes
    if (this.nodeMesh) {
      for (let i = 0; i < this.nodeStates.length; i++) {
        const st = this.nodeStates[i];
        const note = st.note;

        // target position from current mode
        layout.target(this.mode, note, time, tmpV);
        st.pos.lerp(tmpV, lerpK);

        // visibility: replay birth + filters
        const bornNow = replay.isBorn(note);
        if (bornNow && !st.born) st.flash = 1; // birth burst during replay
        st.born = bornNow;

        const matches = store.matchesFilter(note);
        const dimmedByFilter = store.hasActiveFilter && !matches;
        const dimmedBySelection =
          selected !== null && selected !== note.id && !selectedNeighbors?.has(note.id);

        const deg = layout.sim.degreeOf(note.id);
        const base = 0.85 + Math.sqrt(deg) * 0.35 + Math.min(1.2, note.wordCount / 2500);

        st.targetScale = !bornNow ? 0 : dimmedByFilter ? base * 0.35 : base;
        st.flash = Math.max(0, st.flash - dt * 1.6);
        const flashBoost = 1 + st.flash * 1.8;
        st.scale += (st.targetScale * flashBoost - st.scale) * scaleK;

        let bright = 1;
        if (dimmedByFilter) bright = 0.1;
        if (dimmedBySelection) bright = Math.min(bright, 0.12);
        if (note.id === hovered || note.id === selected) bright = 1.6;
        st.brightness += (bright - st.brightness) * scaleK;

        // per-particle glitch: individual nodes stutter, never the whole frame
        let s = st.scale;
        let glitchWhite = 0;
        if (this.matrixBlend > 0.3) {
          const seed = hash01(note.id, 61);
          const burst = Math.sin(time * (3.0 + seed * 4.0) + seed * 40);
          if (burst > 0.982) {
            // quantized horizontal snap, like a dropped packet re-slotting
            const step = Math.floor((time * 18 + seed * 9) % 3) - 1;
            tmpV.set(st.pos.x + step * 6 * this.matrixBlend, st.pos.y, st.pos.z);
            s *= 0.6 + hash01(note.id, 62 + Math.floor(time * 12)) * 1.4;
            glitchWhite = 0.8;
          } else {
            tmpV.copy(st.pos);
          }
        } else {
          tmpV.copy(st.pos);
        }

        tmpM.compose(tmpV, tmpQ.identity(), tmpS.setScalar(Math.max(0.0001, s)));
        this.nodeMesh.setMatrixAt(i, tmpM);

        const pc = this.colors.get(note.project) ?? MATRIX_GREEN;
        tmpC.copy(pc).lerp(MATRIX_GREEN, this.matrixBlend);
        if (glitchWhite > 0) tmpC.lerp(new THREE.Color(0.9, 1, 0.95), glitchWhite);
        tmpC.multiplyScalar(st.brightness * 0.85 * (1 + st.flash * 2.2));
        this.nodeMesh.setColorAt(i, tmpC);
      }
      this.nodeMesh.count = this.nodeStates.length;
      this.nodeMesh.instanceMatrix.needsUpdate = true;
      if (this.nodeMesh.instanceColor) this.nodeMesh.instanceColor.needsUpdate = true;
    }

    // ── edges
    if (this.edgeLines) {
      const posAttr = this.edgeLines.geometry.getAttribute('position') as THREE.BufferAttribute;
      const colAttr = this.edgeLines.geometry.getAttribute('color') as THREE.BufferAttribute;
      const edgeDim = this.mode === 'universe' ? 0.22 : this.mode === 'matrix' ? 0.4 : 0.55;
      for (let e = 0; e < this.edgePairs.length; e++) {
        const [a, b] = this.edgePairs[e];
        const sa = this.nodeStates[a], sb = this.nodeStates[b];
        posAttr.setXYZ(e * 2, sa.pos.x, sa.pos.y, sa.pos.z);
        posAttr.setXYZ(e * 2 + 1, sb.pos.x, sb.pos.y, sb.pos.z);
        const va = Math.min(1, sa.scale) * sa.brightness;
        const vb = Math.min(1, sb.scale) * sb.brightness;
        let vis = Math.min(va, vb) * edgeDim;
        // corpus callosum: links bridging brain hemispheres glow brighter
        if (
          this.mode === 'brain' &&
          this.layout.hemisphereOf(sa.note.project) !== this.layout.hemisphereOf(sb.note.project)
        ) {
          vis *= 2.4;
        }
        const ca = this.colors.get(sa.note.project) ?? MATRIX_GREEN;
        const cb = this.colors.get(sb.note.project) ?? MATRIX_GREEN;
        tmpC.copy(ca).lerp(MATRIX_GREEN, this.matrixBlend).multiplyScalar(vis);
        colAttr.setXYZ(e * 2, tmpC.r, tmpC.g, tmpC.b);
        tmpC.copy(cb).lerp(MATRIX_GREEN, this.matrixBlend).multiplyScalar(vis);
        colAttr.setXYZ(e * 2 + 1, tmpC.r, tmpC.g, tmpC.b);
      }
      posAttr.needsUpdate = true;
      colAttr.needsUpdate = true;
    }

    this.updatePulses(dt);

    // hover picking
    const hit = this.pick();
    const newHover = hit?.id ?? null;
    if (newHover !== this.hoveredId) {
      this.hoveredId = newHover;
      document.body.style.cursor = newHover ? 'pointer' : 'default';
    }
    this.onHover(hit, this.pointerPx.x, this.pointerPx.y);

    // camera focus tween
    if (this.focusTimer > 0) {
      this.focusTimer -= dt;
      const idx = this.selectedId ? this.nodeIndex.get(this.selectedId) : undefined;
      if (idx !== undefined) this.focusTarget.copy(this.nodeStates[idx].pos);
      this.controls.target.lerp(this.focusTarget, 1 - Math.exp(-dt * 3.5));
    }

    // mode flyover tween (eased, releases control back to the user at the end)
    if (this.camTween > 0) {
      this.camTween = Math.max(0, this.camTween - dt * 0.7);
      const k = 1 - Math.exp(-dt * 2.8);
      this.camera.position.lerp(this.camTo, k);
    }

    // universe: slow auto-orbit of the whole galaxy view
    if (this.mode === 'universe') this.sunGroup.rotation.y = 0;

    this.controls.update();
    this.composer.render();
  }

  private updatePulses(dt: number): void {
    const posAttr = this.pulseGeo.getAttribute('position') as THREE.BufferAttribute;
    const colAttr = this.pulseGeo.getAttribute('color') as THREE.BufferAttribute;

    // spawn — pulses trace wikilinks (linker → linked); recently edited notes fire more
    const rate = this.mode === 'neural' ? 22 : this.mode === 'matrix' ? 14 : 7;
    this.pulseAccum += dt * rate;
    while (this.pulseAccum > 1 && this.pulses.length < MAX_PULSES && this.edgePairs.length > 0) {
      this.pulseAccum -= 1;
      const useHot = this.hotEdges.length > 0 && Math.random() < 0.65;
      const e = useHot
        ? this.hotEdges[Math.floor(Math.random() * this.hotEdges.length)]
        : Math.floor(Math.random() * this.edgePairs.length);
      const [a, b] = this.edgePairs[e];
      if (this.nodeStates[a].scale < 0.3 || this.nodeStates[b].scale < 0.3) continue;
      this.pulses.push({ edge: e, t: 0, speed: 0.5 + Math.random() * 0.9 });
    }

    // advance + write buffers
    let w = 0;
    for (const p of this.pulses) {
      p.t += dt * p.speed;
      if (p.t >= 1) continue;
      const [a, b] = this.edgePairs[p.edge] ?? [];
      if (a === undefined) continue;
      const sa = this.nodeStates[a], sb = this.nodeStates[b];
      const fade = Math.sin(p.t * Math.PI);
      posAttr.setXYZ(
        w,
        sa.pos.x + (sb.pos.x - sa.pos.x) * p.t,
        sa.pos.y + (sb.pos.y - sa.pos.y) * p.t,
        sa.pos.z + (sb.pos.z - sa.pos.z) * p.t
      );
      tmpC.copy(this.colors.get(sa.note.project) ?? MATRIX_GREEN)
        .lerp(MATRIX_GREEN, this.matrixBlend)
        .lerp(new THREE.Color(1, 1, 1), 0.55)
        .multiplyScalar(fade * 1.6);
      colAttr.setXYZ(w, tmpC.r, tmpC.g, tmpC.b);
      w++;
    }
    this.pulses = this.pulses.filter((p) => p.t < 1);
    // hide unused slots
    for (let i = w; i < MAX_PULSES; i++) colAttr.setXYZ(i, 0, 0, 0);
    this.pulseGeo.setDrawRange(0, Math.max(w, 0));
    posAttr.needsUpdate = true;
    colAttr.needsUpdate = true;
  }
}
