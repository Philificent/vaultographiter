export interface Note {
  id: string;
  title: string;
  path: string;
  project: string;
  tags: string[];
  wordCount: number;
  created: number;
  modified: number;
  outlinks: string[];
}

export interface Edge {
  source: string;
  target: string;
}

export interface VaultSnapshot {
  vaultName: string;
  generatedAt: number;
  notes: Note[];
  edges: Edge[];
}

export type PatchEvent =
  | { type: 'add'; note: Note }
  | { type: 'update'; note: Note }
  | { type: 'delete'; id: string };

export type ModeId = 'neural' | 'brain' | 'universe' | 'matrix';

export const MODES: { id: ModeId; label: string; blurb: string }[] = [
  { id: 'neural', label: 'NEURAL', blurb: 'synaptic force graph' },
  { id: 'brain', label: 'BRAIN', blurb: 'hemispheric cortex' },
  { id: 'universe', label: 'UNIVERSE', blurb: 'projects as star systems' },
  { id: 'matrix', label: 'MATRIX', blurb: 'digital rain lattice' },
];
