import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';

const SKIP_DIRS = new Set(['.obsidian', '.trash', '.git', '.stfolder', 'node_modules']);

const WIKILINK_RE = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g;
const TAG_RE = /(^|\s)#([A-Za-z0-9][A-Za-z0-9/_-]*)/g;

/** Recursively collect all markdown file paths inside the vault. */
async function collectMarkdownFiles(dir) {
  const out = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await collectMarkdownFiles(full)));
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
      out.push(full);
    }
  }
  return out;
}

function normalizeTags(raw) {
  if (!raw) return [];
  const list = Array.isArray(raw) ? raw : String(raw).split(/[,\s]+/);
  return list
    .map((t) => String(t).trim().replace(/^#/, '').toLowerCase())
    .filter(Boolean);
}

/** Parse a single markdown file into a note record. */
export async function parseNote(vaultRoot, filePath) {
  const rel = path.relative(vaultRoot, filePath);
  const raw = await fs.readFile(filePath, 'utf8');
  const stat = await fs.stat(filePath);

  let frontmatter = {};
  let body = raw;
  try {
    const parsed = matter(raw);
    frontmatter = parsed.data ?? {};
    body = parsed.content;
  } catch {
    // malformed YAML — treat whole file as body
  }

  const tags = new Set(normalizeTags(frontmatter.tags ?? frontmatter.tag));
  for (const m of body.matchAll(TAG_RE)) tags.add(m[2].toLowerCase());

  const outlinks = [];
  for (const m of body.matchAll(WIKILINK_RE)) {
    const target = m[1].trim();
    if (target) outlinks.push(target);
  }

  const segments = rel.split(path.sep);
  const project = segments.length > 1 ? segments[0] : '(root)';

  // Frontmatter "created" wins over birthtime when present (Obsidian templates often set it)
  let created = stat.birthtimeMs || stat.mtimeMs;
  if (frontmatter.created) {
    const t = Date.parse(String(frontmatter.created));
    if (!Number.isNaN(t)) created = t;
  }

  return {
    id: rel,
    title: path.basename(rel, '.md'),
    path: rel,
    project,
    tags: [...tags].sort(),
    wordCount: body.split(/\s+/).filter(Boolean).length,
    created,
    modified: stat.mtimeMs,
    outlinks,
  };
}

/** Resolve outlink strings (note basenames or paths) to note ids and build edge list. */
export function buildGraph(notes) {
  const byBase = new Map();
  const byPath = new Map();
  for (const n of notes) {
    byPath.set(n.path.toLowerCase().replace(/\.md$/, ''), n.id);
    const base = n.title.toLowerCase();
    if (!byBase.has(base)) byBase.set(base, n.id);
  }

  const edgeSet = new Set();
  const edges = [];
  for (const n of notes) {
    for (const raw of n.outlinks) {
      const key = raw.toLowerCase().replace(/\.md$/, '');
      const target = byPath.get(key) ?? byBase.get(key.split('/').pop());
      if (!target || target === n.id) continue;
      const ek = `${n.id}\u0000${target}`;
      if (edgeSet.has(ek)) continue;
      edgeSet.add(ek);
      edges.push({ source: n.id, target });
    }
  }
  return edges;
}

/** Full vault scan -> snapshot payload. */
export async function scanVault(vaultRoot) {
  if (!fsSync.existsSync(vaultRoot)) {
    throw new Error(`Vault path does not exist: ${vaultRoot}`);
  }
  const files = await collectMarkdownFiles(vaultRoot);
  const notes = [];
  for (const f of files) {
    try {
      notes.push(await parseNote(vaultRoot, f));
    } catch (err) {
      console.warn(`[scanner] skipping ${f}: ${err.message}`);
    }
  }
  notes.sort((a, b) => a.created - b.created);
  return {
    vaultName: path.basename(vaultRoot),
    generatedAt: Date.now(),
    notes,
    edges: buildGraph(notes),
  };
}
