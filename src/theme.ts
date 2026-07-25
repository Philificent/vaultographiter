/**
 * Theme system: curated presets (UI CSS vars + scene background + node palette)
 * plus user-tunable glow (bloom multiplier) and hue shift, persisted to localStorage.
 */
export interface ThemePreset {
  id: string;
  label: string;
  /** CSS custom properties applied to :root (keys without the -- prefix). */
  ui: Record<string, string>;
  /** WebGL scene background + fog colour. */
  sceneBg: string;
  /** Colours cycled across projects for nodes/edges/suns. */
  palette: string[];
}

export const THEMES: ThemePreset[] = [
  {
    id: 'neon',
    label: 'Neon',
    ui: {
      bg: '#05060a', ink: '#e8ecf4', dim: '#6b7386',
      accent: '#7df9ff', accent2: '#ff6ec7',
      panel: 'rgba(10, 13, 22, 0.72)', line: 'rgba(125, 249, 255, 0.14)',
    },
    sceneBg: '#05060a',
    palette: [
      '#7df9ff', '#ff6ec7', '#b388ff', '#69f0ae', '#ffd54f',
      '#ff8a65', '#4fc3f7', '#f48fb1', '#aed581', '#ce93d8',
      '#80cbc4', '#ffab91', '#90caf9', '#e6ee9c', '#f06292',
      '#a7ffeb', '#ffcc80', '#b0bec5',
    ],
  },
  {
    id: 'synthwave',
    label: 'Synthwave',
    ui: {
      bg: '#0d0221', ink: '#f3e9ff', dim: '#8878a8',
      accent: '#ff2ec4', accent2: '#00f0ff',
      panel: 'rgba(20, 8, 40, 0.72)', line: 'rgba(255, 46, 196, 0.16)',
    },
    sceneBg: '#0d0221',
    palette: [
      '#ff2ec4', '#00f0ff', '#b537f2', '#ff6c11', '#f7e733',
      '#ff3864', '#2de2e6', '#f706cf', '#9d72ff', '#ffb3fd',
      '#65dc98', '#ff9472',
    ],
  },
  {
    id: 'ember',
    label: 'Ember',
    ui: {
      bg: '#0a0503', ink: '#f5ead9', dim: '#8a7362',
      accent: '#ffb347', accent2: '#ff5e3a',
      panel: 'rgba(22, 12, 6, 0.72)', line: 'rgba(255, 179, 71, 0.15)',
    },
    sceneBg: '#0a0503',
    palette: [
      '#ffb347', '#ff5e3a', '#ffd97d', '#e63946', '#ff8c61',
      '#d95d39', '#f4a259', '#bc4749', '#ffcb69', '#e07a5f',
      '#c1666b', '#ffe8d1',
    ],
  },
  {
    id: 'aurora',
    label: 'Aurora',
    ui: {
      bg: '#02070d', ink: '#e4f5ec', dim: '#5f7d72',
      accent: '#52ffb8', accent2: '#38b6ff',
      panel: 'rgba(6, 16, 14, 0.72)', line: 'rgba(82, 255, 184, 0.14)',
    },
    sceneBg: '#02070d',
    palette: [
      '#52ffb8', '#38b6ff', '#7cffc4', '#00e5a0', '#4dd2ff',
      '#a8ff9e', '#00b4d8', '#90f1ef', '#57cc99', '#48bfe3',
      '#c7f9cc', '#64dfdf',
    ],
  },
  {
    id: 'sakura',
    label: 'Sakura',
    ui: {
      bg: '#120a12', ink: '#fdeef4', dim: '#907083',
      accent: '#ff9ecb', accent2: '#c77dff',
      panel: 'rgba(26, 14, 26, 0.72)', line: 'rgba(255, 158, 203, 0.15)',
    },
    sceneBg: '#120a12',
    palette: [
      '#ff9ecb', '#c77dff', '#ffc4d6', '#f6a5c1', '#e685b5',
      '#b088f9', '#ffd6e8', '#d291bc', '#ff87ab', '#c9a7eb',
    ],
  },
  {
    id: 'mono',
    label: 'Mono',
    ui: {
      bg: '#060606', ink: '#f2f2f2', dim: '#6e6e6e',
      accent: '#ffffff', accent2: '#9e9e9e',
      panel: 'rgba(14, 14, 14, 0.72)', line: 'rgba(255, 255, 255, 0.14)',
    },
    sceneBg: '#060606',
    palette: [
      '#ffffff', '#c9c9c9', '#9e9e9e', '#e8e8e8', '#b5b5b5',
      '#d6d6d6', '#8a8a8a', '#f5f5f5',
    ],
  },
];

const STORAGE_KEY = 'vg-theme-v1';

let active: ThemePreset = THEMES[0];
let glow = 1; // bloom strength multiplier, 0..2
let hue = 0; // palette hue rotation in degrees, 0..360

export const activeTheme = (): ThemePreset => active;
export const activePalette = (): string[] => active.palette;
export const themeGlow = (): number => glow;
export const themeHue = (): number => hue;

function applyCssVars(): void {
  const root = document.documentElement.style;
  for (const [k, v] of Object.entries(active.ui)) root.setProperty(`--${k}`, v);
}

function persist(): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ id: active.id, glow, hue }));
}

/** Restore saved theme (if any) and apply UI vars. Call before the scene is built. */
export function initTheme(): void {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '');
    const t = THEMES.find((p) => p.id === saved.id);
    if (t) active = t;
    if (typeof saved.glow === 'number') glow = Math.min(2, Math.max(0, saved.glow));
    if (typeof saved.hue === 'number') hue = Math.min(360, Math.max(0, saved.hue));
  } catch { /* first run — defaults */ }
  applyCssVars();
}

export function setThemePreset(id: string): void {
  const t = THEMES.find((p) => p.id === id);
  if (!t) return;
  active = t;
  applyCssVars();
  persist();
}

export function setThemeGlow(v: number): void {
  glow = Math.min(2, Math.max(0, v));
  persist();
}

export function setThemeHue(v: number): void {
  hue = Math.min(360, Math.max(0, v));
  persist();
}
