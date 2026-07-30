import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import express from 'express';
import chokidar from 'chokidar';
import matter from 'gray-matter';
import { WebSocketServer } from 'ws';
import { scanVault, parseNote, buildGraph } from './scanner.mjs';

const PORT = Number(process.env.PORT ?? 4400);
const VAULT_PATH =
  process.env.VAULT_PATH ?? path.join(os.homedir(), 'Documents', 'Obsidian');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

// Fail fast with recovery guidance instead of an uncaught stack trace when the
// vault directory is missing or unreadable.
let snapshot;
try {
  snapshot = await scanVault(VAULT_PATH);
} catch (err) {
  console.error(`[vaultographiter] failed to scan vault at "${VAULT_PATH}": ${err.message}`);
  console.error(
    '[vaultographiter] set the VAULT_PATH environment variable to an existing Obsidian vault directory,'
  );
  console.error(
    `[vaultographiter] e.g. VAULT_PATH=/path/to/vault npm run dev:server (default: ${path.join(os.homedir(), 'Documents', 'Obsidian')})`
  );
  process.exit(1);
}
console.log(
  `[vaultographiter] scanned "${snapshot.vaultName}": ${snapshot.notes.length} notes, ${snapshot.edges.length} links`
);

app.get('/api/vault', (_req, res) => res.json(snapshot));

// Content excerpt for the note detail card. Path is validated to stay inside the vault.
app.get('/api/note', async (req, res) => {
  const id = String(req.query.id ?? '');
  const root = path.resolve(VAULT_PATH);
  const full = path.resolve(root, id);
  if (!full.startsWith(root + path.sep) || !full.toLowerCase().endsWith('.md')) {
    return res.status(400).json({ error: 'invalid note id' });
  }
  try {
    const raw = await fs.readFile(full, 'utf8');
    let body = raw;
    try { body = matter(raw).content; } catch { /* keep raw */ }
    body = body.trim();
    const excerpt = body.length > 1400 ? body.slice(0, 1400) + '\u2026' : body;
    res.json({ id, excerpt });
  } catch {
    res.status(404).json({ error: 'note not found' });
  }
});

function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(data);
  }
}

// Debounced incremental updates: re-parse the touched file, rebuild edges, notify clients.
let pending = new Map(); // relPath -> 'upsert' | 'delete'
let flushTimer = null;

async function flush() {
  flushTimer = null;
  const batch = pending;
  pending = new Map();

  const notesById = new Map(snapshot.notes.map((n) => [n.id, n]));
  const events = [];

  for (const [rel, kind] of batch) {
    if (kind === 'delete') {
      if (notesById.delete(rel)) events.push({ type: 'delete', id: rel });
    } else {
      try {
        const note = await parseNote(VAULT_PATH, path.join(VAULT_PATH, rel));
        const isNew = !notesById.has(rel);
        notesById.set(rel, note);
        events.push({ type: isNew ? 'add' : 'update', note });
      } catch (err) {
        console.warn(`[watch] failed to parse ${rel}: ${err.message}`);
      }
    }
  }
  if (events.length === 0) return;

  const notes = [...notesById.values()].sort((a, b) => a.created - b.created);
  snapshot = {
    ...snapshot,
    generatedAt: Date.now(),
    notes,
    edges: buildGraph(notes),
  };
  broadcast({ type: 'patch', events, edges: snapshot.edges });
  console.log(`[watch] ${events.map((e) => `${e.type}:${e.id ?? e.note.id}`).join(', ')}`);
}

function queue(rel, kind) {
  if (!rel.toLowerCase().endsWith('.md')) return;
  pending.set(rel, kind);
  clearTimeout(flushTimer);
  flushTimer = setTimeout(flush, 300);
}

chokidar
  .watch(VAULT_PATH, {
    ignored: (p) => /(^|[\/\\])\.|\.trash/.test(path.relative(VAULT_PATH, p)),
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 400, pollInterval: 100 },
  })
  .on('add', (p) => queue(path.relative(VAULT_PATH, p), 'upsert'))
  .on('change', (p) => queue(path.relative(VAULT_PATH, p), 'upsert'))
  .on('unlink', (p) => queue(path.relative(VAULT_PATH, p), 'delete'));

wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'hello', vaultName: snapshot.vaultName }));
});

server.listen(PORT, () => {
  console.log(`[vaultographiter] server on http://localhost:${PORT} watching ${VAULT_PATH}`);
});
