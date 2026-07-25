import './style.css';
import { VaultStore } from './store';
import { LayoutEngine } from './layout';
import { Replay } from './replay';
import { SceneManager } from './scene';
import { Hud } from './hud';
import { initTheme } from './theme';

initTheme(); // restore saved theme before anything renders

const loading = document.createElement('div');
loading.className = 'loading';
loading.textContent = 'VAULTOGRAPHITER';
document.body.appendChild(loading);

const store = new VaultStore();
const layout = new LayoutEngine();
const replay = new Replay();
const canvas = document.getElementById('scene') as HTMLCanvasElement;
const sceneMgr = new SceneManager(canvas, store, layout, replay);
sceneMgr.applyTheme(); // sync scene background/glow with the restored theme
const hud = new Hud(store, replay, sceneMgr, (mode) => sceneMgr.setMode(mode));

// debug handle for inspection from devtools
(window as any).__vg = { store, layout, replay, sceneMgr };

store.on('data', () => {
  layout.setGraph(store.notes, store.edges);
  replay.setRange(store.notes);
  sceneMgr.rebuild();
});

store.on('live', () => {
  const e = store.lastLiveEvent;
  if (e && e.type !== 'delete') sceneMgr.flash(e.note.id);
});

let last = performance.now();
function frame(now: number): void {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  replay.update(dt);
  sceneMgr.update(dt, now / 1000);
  hud.tick();
  requestAnimationFrame(frame);
}

store
  .load()
  .then(() => {
    loading.classList.add('done');
    setTimeout(() => loading.remove(), 700);
    requestAnimationFrame(frame);
  })
  .catch((err) => {
    loading.textContent = 'VAULT SCAN FAILED — IS THE SERVER RUNNING?';
    loading.style.letterSpacing = '0.2em';
    console.error(err);
  });
