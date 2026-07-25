import type { Note } from './types';

/**
 * Replay-growth timeline: maps [minCreated, maxCreated] to a 0..1 scrubber.
 * When t < 1 the vault is shown as it existed at that moment.
 */
export class Replay {
  t = 1; // 0..1 normalized position, 1 = present
  playing = false;
  speed = 1; // multiplier
  private min = 0;
  private max = 1;
  private baseDuration = 20; // seconds for a full sweep at 1x

  setRange(notes: Note[]): void {
    if (notes.length === 0) return;
    this.min = notes[0].created;
    this.max = notes[notes.length - 1].created;
    if (this.max <= this.min) this.max = this.min + 1;
  }

  get currentTime(): number {
    return this.min + (this.max - this.min) * this.t;
  }

  get active(): boolean {
    return this.t < 1;
  }

  /** Is this note born yet at the current scrub position? */
  isBorn(note: Note): boolean {
    return !this.active || note.created <= this.currentTime;
  }

  togglePlay(): void {
    if (!this.playing && this.t >= 1) this.t = 0; // restart from the beginning
    this.playing = !this.playing;
  }

  cycleSpeed(): number {
    this.speed = this.speed >= 4 ? 0.5 : this.speed * 2;
    return this.speed;
  }

  scrubTo(t: number): void {
    this.t = Math.min(1, Math.max(0, t));
    this.playing = false;
  }

  update(dt: number): void {
    if (!this.playing) return;
    this.t += (dt / this.baseDuration) * this.speed;
    if (this.t >= 1) {
      this.t = 1;
      this.playing = false;
    }
  }

  formatCurrent(): string {
    if (!this.active) return 'NOW';
    return new Date(this.currentTime).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  }
}
