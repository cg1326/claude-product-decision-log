import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { ExtractedDecision } from './extract';

export interface StoredDecision {
  id: string;
  session_id: string;
  timestamp: string;
  project: string;
  decision: string;
  considered: string;
  rationale: string;
  status: 'decided' | 'deferred' | 'reversed' | 'rejected';
  cwd: string;
  deleted_at?: string | null;
}

const DECISION_LOG_DIR = path.join(os.homedir(), '.decision-log');
const DB_PATH = path.join(DECISION_LOG_DIR, 'decisions.db');

// Ensure directory exists
fs.mkdirSync(DECISION_LOG_DIR, { recursive: true });

// Open database (created if not exists)
const db = new Database(DB_PATH);

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS decisions (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    project TEXT NOT NULL,
    decision TEXT NOT NULL,
    considered TEXT NOT NULL,
    rationale TEXT NOT NULL,
    status TEXT NOT NULL,
    cwd TEXT NOT NULL DEFAULT '',
    deleted_at TEXT DEFAULT NULL
  );

  CREATE TABLE IF NOT EXISTS archived (
    slug TEXT PRIMARY KEY
  );
`);

// Add deleted_at column to existing databases that predate soft-delete
try {
  db.exec(`ALTER TABLE decisions ADD COLUMN deleted_at TEXT DEFAULT NULL`);
} catch {
  // Column already exists — ignore
}

// Migration: import JSONL files from old projects directory
const oldProjectsDir = path.join(DECISION_LOG_DIR, 'projects');
const migratedDir = path.join(DECISION_LOG_DIR, 'projects.migrated');

if (fs.existsSync(oldProjectsDir) && !fs.existsSync(migratedDir)) {
  try {
    const entries = fs.readdirSync(oldProjectsDir, { withFileTypes: true });
    const insertStmt = db.prepare(`
      INSERT OR IGNORE INTO decisions (id, session_id, timestamp, project, decision, considered, rationale, status, cwd)
      VALUES (@id, @session_id, @timestamp, @project, @decision, @considered, @rationale, @status, @cwd)
    `);
    const migrateMany = db.transaction((rows: StoredDecision[]) => {
      for (const row of rows) {
        insertStmt.run(row);
      }
    });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const jsonlFile = path.join(oldProjectsDir, entry.name, 'decisions.jsonl');
      if (!fs.existsSync(jsonlFile)) continue;

      const content = fs.readFileSync(jsonlFile, 'utf-8').trim();
      if (!content) continue;

      const rows: StoredDecision[] = [];
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const parsed = JSON.parse(trimmed) as Partial<StoredDecision>;
          rows.push({
            id: parsed.id ?? uuidv4(),
            session_id: parsed.session_id ?? '',
            timestamp: parsed.timestamp ?? new Date().toISOString(),
            project: parsed.project ?? entry.name,
            decision: parsed.decision ?? '',
            considered: parsed.considered ?? '',
            rationale: parsed.rationale ?? '',
            status: (parsed.status as StoredDecision['status']) ?? 'decided',
            cwd: parsed.cwd ?? '',
          });
        } catch {
          // Skip malformed lines
        }
      }

      migrateMany(rows);
    }

    // Rename projects dir to mark migration complete
    fs.renameSync(oldProjectsDir, migratedDir);
  } catch (err) {
    process.stderr.write(`decision-log: Migration error: ${err}\n`);
  }
}

export function projectSlug(cwd: string): string {
  // Use full path: /Users/alice/my-app → users-alice-my-app
  return cwd
    .toLowerCase()
    .replace(/^\//, '')           // remove leading slash
    .replace(/[^a-z0-9]+/g, '-') // replace non-alphanumeric runs with -
    .replace(/-+/g, '-')          // deduplicate -
    .replace(/^-|-$/g, '');       // trim leading/trailing -
}

export async function saveDecisions(
  decisions: ExtractedDecision[],
  sessionId: string,
  cwd: string
): Promise<void> {
  const slug = projectSlug(cwd);
  const timestamp = new Date().toISOString();

  const insertStmt = db.prepare(`
    INSERT INTO decisions (id, session_id, timestamp, project, decision, considered, rationale, status, cwd)
    VALUES (@id, @session_id, @timestamp, @project, @decision, @considered, @rationale, @status, @cwd)
  `);

  const insertMany = db.transaction((rows: StoredDecision[]) => {
    for (const row of rows) {
      insertStmt.run(row);
    }
  });

  const rows: StoredDecision[] = decisions.map(d => ({
    id: uuidv4(),
    session_id: sessionId,
    timestamp,
    project: slug,
    decision: d.decision,
    considered: d.considered,
    rationale: d.rationale,
    status: d.status,
    cwd,
  }));

  insertMany(rows);
}

export async function loadDecisions(slug: string, status?: string): Promise<StoredDecision[]> {
  if (status && status !== 'all') {
    return db.prepare(
      'SELECT * FROM decisions WHERE project = ? AND status = ? AND deleted_at IS NULL ORDER BY timestamp ASC'
    ).all(slug, status) as StoredDecision[];
  }
  return db.prepare(
    'SELECT * FROM decisions WHERE project = ? AND deleted_at IS NULL ORDER BY timestamp ASC'
  ).all(slug) as StoredDecision[];
}

export async function searchDecisions(query: string): Promise<StoredDecision[]> {
  const like = `%${query}%`;
  return db.prepare(`
    SELECT * FROM decisions
    WHERE (decision LIKE ? OR considered LIKE ? OR rationale LIKE ?)
    AND deleted_at IS NULL
    ORDER BY timestamp DESC
    LIMIT 100
  `).all(like, like, like) as StoredDecision[];
}

export async function getDeferredOlderThan(days: number): Promise<StoredDecision[]> {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  return db.prepare(`
    SELECT * FROM decisions
    WHERE status = 'deferred' AND timestamp < ? AND deleted_at IS NULL
    ORDER BY timestamp ASC
  `).all(cutoff) as StoredDecision[];
}

export async function updateDecision(
  slug: string,
  id: string,
  updates: Partial<Pick<StoredDecision, 'decision' | 'considered' | 'rationale' | 'status'>>
): Promise<boolean> {
  const fields = Object.keys(updates) as Array<keyof typeof updates>;
  if (fields.length === 0) return false;

  const setClauses = fields.map(f => `${f} = @${f}`).join(', ');
  const stmt = db.prepare(
    `UPDATE decisions SET ${setClauses} WHERE id = @id AND project = @slug`
  );

  const info = stmt.run({ ...updates, id, slug });
  return info.changes > 0;
}

export async function deleteDecision(slug: string, id: string): Promise<boolean> {
  const info = db.prepare(
    'UPDATE decisions SET deleted_at = ? WHERE id = ? AND project = ? AND deleted_at IS NULL'
  ).run(new Date().toISOString(), id, slug);
  return info.changes > 0;
}

export async function restoreDecision(slug: string, id: string): Promise<boolean> {
  const info = db.prepare(
    'UPDATE decisions SET deleted_at = NULL WHERE id = ? AND project = ?'
  ).run(id, slug);
  return info.changes > 0;
}

export async function listTrashed(slug?: string): Promise<StoredDecision[]> {
  if (slug) {
    return db.prepare(
      'SELECT * FROM decisions WHERE project = ? AND deleted_at IS NOT NULL ORDER BY deleted_at DESC'
    ).all(slug) as StoredDecision[];
  }
  return db.prepare(
    'SELECT * FROM decisions WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC'
  ).all() as StoredDecision[];
}

export async function permanentlyDelete(slug: string, id: string): Promise<boolean> {
  const info = db.prepare(
    'DELETE FROM decisions WHERE id = ? AND project = ? AND deleted_at IS NOT NULL'
  ).run(id, slug);
  return info.changes > 0;
}

export async function addDecision(
  slug: string,
  decision: Omit<StoredDecision, 'id' | 'timestamp' | 'project'>
): Promise<StoredDecision> {
  const row: StoredDecision = {
    id: uuidv4(),
    timestamp: new Date().toISOString(),
    project: slug,
    ...decision,
  };

  db.prepare(`
    INSERT INTO decisions (id, session_id, timestamp, project, decision, considered, rationale, status, cwd)
    VALUES (@id, @session_id, @timestamp, @project, @decision, @considered, @rationale, @status, @cwd)
  `).run(row);

  return row;
}

export function isArchived(slug: string): boolean {
  const row = db.prepare('SELECT 1 FROM archived WHERE slug = ?').get(slug);
  return row !== undefined;
}

export function archiveProject(slug: string): void {
  db.prepare('INSERT OR IGNORE INTO archived (slug) VALUES (?)').run(slug);
}

export function unarchiveProject(slug: string): void {
  db.prepare('DELETE FROM archived WHERE slug = ?').run(slug);
}

export async function listProjects(): Promise<{ slug: string; count: number; lastActivity: string; archived: boolean }[]> {
  const rows = db.prepare(`
    SELECT d.project AS slug, COUNT(*) AS count, MAX(d.timestamp) AS lastActivity,
           CASE WHEN a.slug IS NOT NULL THEN 1 ELSE 0 END AS archived
    FROM decisions d
    LEFT JOIN archived a ON a.slug = d.project
    WHERE d.deleted_at IS NULL
    GROUP BY d.project
    ORDER BY lastActivity DESC
  `).all() as Array<{ slug: string; count: number; lastActivity: string; archived: number }>;

  return rows.map(r => ({
    slug: r.slug,
    count: r.count,
    lastActivity: r.lastActivity,
    archived: r.archived === 1,
  }));
}
