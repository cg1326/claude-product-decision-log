import express, { Request, Response } from 'express';
import {
  listProjects,
  loadDecisions,
  updateDecision,
  deleteDecision,
  restoreDecision,
  permanentlyDelete,
  listTrashed,
  archiveProject,
  unarchiveProject,
  searchDecisions,
  getDeferredOlderThan,
  addDecision,
} from './storage';
import { StoredDecision } from './storage';

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
const PORT = parseInt(process.env.DECISION_LOG_PORT ?? '3456', 10);

// ─── Helpers ─────────────────────────────────────────────────────────────────

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function fmtDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
  } catch { return iso; }
}

function fmtTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString('en-US', { hour: '2-digit', minute: '2-digit' });
  } catch { return ''; }
}

function pad(n: number): string { return String(n).padStart(3, '0'); }
function pad2(n: number): string { return String(n).padStart(2, '0'); }

function projectTitle(slug: string): string {
  const parts = slug.split('-');
  return parts.slice(-2).join('-') || slug;
}

function highlightQuery(text: string, query: string): string {
  if (!query) return escapeHtml(text);
  const escaped = escapeHtml(text);
  const escapedQuery = escapeHtml(query).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return escaped.replace(new RegExp(escapedQuery, 'gi'), match => `<mark>${match}</mark>`);
}

async function getTotalEntries(): Promise<number> {
  const projects = await listProjects();
  return projects.reduce((sum, p) => sum + p.count, 0);
}

// ─── Design tokens ────────────────────────────────────────────────────────────

const STATUS_ORDER = ['decided', 'deferred', 'reversed', 'rejected'] as const;

const STATUS_VAR: Record<string, string> = {
  decided:  'var(--s-decided)',
  deferred: 'var(--s-deferred)',
  reversed: 'var(--s-reversed)',
  rejected: 'var(--s-rejected)',
};

const STATUS_GLOSS: Record<string, string> = {
  decided:  'a direction chosen over alternatives',
  deferred: 'explicitly pushed to later',
  reversed: 'a previous call that changed',
  rejected: 'considered and permanently ruled out',
};

// ─── Styles ───────────────────────────────────────────────────────────────────

const fontLinks = `
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap" rel="stylesheet">`;

const baseStyles = `
:root {
  --paper:     #f4f3ef;
  --paper-2:   #efeee8;
  --ink:       #16150f;
  --ink-soft:  #56544b;
  --ink-faint: #918e82;
  --line:      #d9d7cd;
  --line-soft: #e6e4db;
  --accent:      oklch(0.55 0.20 28);
  --accent-soft: oklch(0.55 0.20 28 / 0.10);
  --s-decided:   oklch(0.50 0.11 150);
  --s-deferred:  oklch(0.62 0.12 78);
  --s-reversed:  oklch(0.50 0.13 252);
  --s-rejected:  oklch(0.52 0.02 70);
  --sans: 'Space Grotesk', system-ui, -apple-system, sans-serif;
  --mono: 'IBM Plex Mono', ui-monospace, 'SF Mono', Menlo, monospace;
  --maxw: 1000px;
  --pad: 40px;
}
* { box-sizing: border-box; margin: 0; padding: 0; }
html { -webkit-text-size-adjust: 100%; }
body {
  font-family: var(--sans);
  background: var(--paper);
  color: var(--ink);
  line-height: 1.45;
  font-size: 15px;
  -webkit-font-smoothing: antialiased;
}
::selection { background: var(--accent-soft); }
a { color: inherit; text-decoration: none; }
.topedge { height: 3px; background: var(--accent); }
.topbar { border-bottom: 1px solid var(--ink); }
.topbar-inner {
  max-width: var(--maxw);
  margin: 0 auto;
  padding: 16px var(--pad);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}
.wordmark { display: inline-flex; align-items: center; gap: 11px; text-decoration: none; color: var(--ink); }
.wordmark .mark { width: 16px; height: 16px; background: var(--accent); display: inline-block; flex-shrink: 0; }
.wordmark .wm-text { font-family: var(--mono); font-weight: 600; font-size: 13px; letter-spacing: 0.12em; text-transform: uppercase; white-space: nowrap; }
.topbar-meta {
  display: flex; align-items: center; gap: 22px;
  font-family: var(--mono); font-size: 11px; letter-spacing: 0.04em; color: var(--ink-faint); flex-shrink: 0;
}
.topbar-meta span { white-space: nowrap; }
.topbar-meta .val { color: var(--ink); }
.topbar-meta .live::before {
  content: ''; display: inline-block; width: 6px; height: 6px;
  background: var(--s-decided); margin-right: 7px; vertical-align: middle;
}
.nav-link {
  font-family: var(--mono); font-size: 11px; letter-spacing: 0.08em;
  text-transform: uppercase; color: var(--ink-faint); text-decoration: none; white-space: nowrap;
  transition: color 0.13s;
}
.nav-link:hover { color: var(--accent); }
.nav-link.active { color: var(--ink); }
.container { max-width: var(--maxw); margin: 0 auto; padding: 0 var(--pad) 120px; }

/* Hero */
.hero {
  padding: 56px 0 12px;
  display: grid; grid-template-columns: 1fr auto; align-items: end; gap: 32px;
}
.hero h1 { font-size: 52px; font-weight: 500; letter-spacing: -0.035em; line-height: 0.98; max-width: 13ch; }
.hero p { font-family: var(--mono); font-size: 12.5px; line-height: 1.7; color: var(--ink-soft); max-width: 34ch; letter-spacing: 0.01em; padding-bottom: 6px; }

/* Status key */
.statuskey { display: grid; grid-template-columns: repeat(4, 1fr); gap: 30px; padding: 22px 0; border-top: 1px solid var(--ink); border-bottom: 1px solid var(--line); margin-top: 36px; }
.keyitem { display: flex; flex-direction: column; gap: 9px; }
.keyitem .kihead { display: inline-flex; align-items: center; gap: 9px; font-family: var(--mono); font-size: 11px; letter-spacing: 0.1em; text-transform: uppercase; font-weight: 600; color: var(--ink); }
.keyitem .kihead .sq { width: 9px; height: 9px; flex-shrink: 0; }
.keyitem .kn { font-size: 12.5px; line-height: 1.45; color: var(--ink-soft); letter-spacing: -0.005em; }

/* Stat band */
.statband { display: grid; grid-template-columns: repeat(5, 1fr); border-bottom: 1px solid var(--line); }
.stat { padding: 24px 18px 26px 0; border-right: 1px solid var(--line-soft); }
.stat:first-child { padding-left: 0; }
.stat:last-child { border-right: none; }
.stat .num { font-size: 44px; font-weight: 400; line-height: 1; letter-spacing: -0.04em; font-variant-numeric: tabular-nums; display: flex; align-items: baseline; gap: 10px; }
.stat .num .sq { width: 10px; height: 10px; align-self: center; }
.stat .cap { margin-top: 14px; font-family: var(--mono); font-size: 10px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--ink-faint); }

/* Section head */
.section-head { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; margin: 44px 0 0; padding-bottom: 12px; }
.section-head .ttl { font-family: var(--mono); font-size: 11px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--ink); font-weight: 600; }
.section-head .meta { font-family: var(--mono); font-size: 10.5px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--ink-faint); }

/* Search bar */
.search-bar { display: flex; align-items: center; gap: 14px; border-bottom: 2px solid var(--ink); padding: 10px 2px; margin: 30px 0 0; }
.search-bar .prefix { font-family: var(--mono); font-size: 16px; color: var(--accent); }
.search-input { flex: 1; border: none; background: transparent; font-family: var(--sans); font-size: 22px; font-weight: 400; letter-spacing: -0.02em; color: var(--ink); }
.search-input:focus { outline: none; }
.search-input::placeholder { color: var(--ink-faint); }
.search-btn { border: none; background: transparent; font-family: var(--mono); font-size: 11px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--ink); cursor: pointer; padding: 6px 0 6px 14px; display: inline-flex; align-items: center; gap: 8px; transition: color 0.14s; }
.search-btn:hover { color: var(--accent); }
.search-btn .arr { color: var(--accent); }

/* Nudge */
.nudge { display: flex; align-items: center; gap: 16px; padding: 16px 0; border-top: 1px solid var(--ink); border-bottom: 1px solid var(--line); margin: 34px 0 0; font-size: 14px; color: var(--ink-soft); }
.nudge .ico { font-family: var(--mono); font-size: 11px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--s-deferred); font-weight: 600; white-space: nowrap; }
.nudge strong { color: var(--ink); font-weight: 600; }
.nudge a { margin-left: auto; white-space: nowrap; font-family: var(--mono); font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--ink); text-decoration: none; border-bottom: 1px solid var(--accent); padding-bottom: 2px; cursor: pointer; }
.nudge a:hover { color: var(--accent); }

/* Index table */
:root { --idx-grid: 44px minmax(0,1fr) 120px 88px 104px 78px; }
.index-table { border-bottom: 1px solid var(--line); }
.index-head { display: grid; grid-template-columns: var(--idx-grid); gap: 24px; padding: 0 0 11px; border-bottom: 1px solid var(--ink); }
.index-head span { font-family: var(--mono); font-size: 9.5px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--ink-faint); }
.index-head .r { text-align: right; }
.project-row { display: grid; grid-template-columns: var(--idx-grid); gap: 24px; align-items: center; padding: 18px 0; border-bottom: 1px solid var(--line-soft); cursor: pointer; position: relative; transition: background 0.13s; }
.project-row:hover { background: var(--paper-2); }
.project-row::after { content: ''; position: absolute; left: calc(var(--pad) * -1); top: 0; bottom: 0; width: 3px; background: var(--accent); transform: scaleY(0); transition: transform 0.16s ease; }
.project-row:hover::after { transform: scaleY(1); }
.project-row .pidx { font-family: var(--mono); font-size: 12px; color: var(--ink-faint); font-variant-numeric: tabular-nums; }
.project-main { min-width: 0; }
.project-main .pname { font-size: 21px; font-weight: 500; letter-spacing: -0.025em; line-height: 1.1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.project-main .pslug { font-family: var(--mono); font-size: 11px; color: var(--ink-faint); margin-top: 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pcount { font-family: var(--mono); font-size: 15px; color: var(--ink); text-align: right; font-variant-numeric: tabular-nums; }
.pdate { font-family: var(--mono); font-size: 11px; color: var(--ink-faint); text-align: right; white-space: nowrap; }
.distbar { display: flex; height: 8px; width: 100%; gap: 2px; }
.distbar span { height: 100%; display: block; }
.row-actions { display: flex; justify-content: flex-end; }
.mini-btn { font-family: var(--mono); font-size: 10px; letter-spacing: 0.08em; text-transform: uppercase; padding: 5px 0; border: none; background: transparent; color: var(--ink-faint); cursor: pointer; border-bottom: 1px solid transparent; transition: all 0.13s; }
.mini-btn:hover { color: var(--ink); border-bottom-color: var(--ink); }
.mini-btn.warm:hover { color: var(--accent); border-bottom-color: var(--accent); }
.archived-block { margin-top: 34px; }
.archived-summary { font-family: var(--mono); font-size: 11px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--ink-faint); cursor: pointer; list-style: none; display: flex; align-items: center; gap: 10px; padding: 12px 0; border-top: 1px solid var(--line); user-select: none; }
.archived-summary::-webkit-details-marker { display: none; }
.archived-summary .chev { transition: transform 0.2s; display: inline-block; color: var(--accent); }
details[open] .archived-summary .chev { transform: rotate(90deg); }
.archived-block .index-table { opacity: 0.6; transition: opacity 0.2s; }
.archived-block .index-table:hover { opacity: 1; }

/* Project header */
.proj-head { padding-top: 32px; }
.crumb { font-family: var(--mono); font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--ink-faint); text-decoration: none; display: inline-flex; align-items: center; gap: 8px; cursor: pointer; transition: color 0.14s; }
.crumb:hover { color: var(--accent); }
.proj-head .crumb { margin-bottom: 26px; display: inline-flex; }
.proj-title-row { display: flex; align-items: flex-end; justify-content: space-between; gap: 24px; flex-wrap: wrap; padding-bottom: 4px; }
.proj-title-row h2 { font-size: 46px; font-weight: 500; letter-spacing: -0.04em; line-height: 0.98; }
.proj-title-row .pslug { font-family: var(--mono); font-size: 12px; color: var(--ink-faint); margin-top: 10px; letter-spacing: 0.02em; }
.export-btn { font-family: var(--mono); font-size: 10.5px; letter-spacing: 0.1em; text-transform: uppercase; padding: 11px 16px; background: var(--ink); color: var(--paper); border: none; cursor: pointer; text-decoration: none; display: inline-flex; align-items: center; gap: 9px; transition: background 0.15s; }
.export-btn:hover { background: var(--accent); text-decoration: none; color: var(--paper); }

/* Status tabs */
.status-tabs { display: flex; gap: 26px; margin: 30px 0 0; border-bottom: 1px solid var(--ink); flex-wrap: wrap; }
.status-tab { font-family: var(--mono); font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; padding: 0 0 13px; color: var(--ink-faint); cursor: pointer; border: none; background: transparent; border-bottom: 2px solid transparent; margin-bottom: -1px; display: inline-flex; align-items: center; gap: 9px; transition: color 0.13s; text-decoration: none; }
.status-tab:hover { color: var(--ink); text-decoration: none; }
.status-tab.active { color: var(--ink); border-bottom-color: var(--accent); }
.status-tab .tcount { color: var(--ink-faint); font-size: 10px; }
.status-tab .swatch { width: 8px; height: 8px; display: inline-block; }

/* Decision entries */
.timeline { margin-top: 4px; }
.entry { display: grid; grid-template-columns: 116px 1fr; gap: 36px; padding: 30px 0; border-bottom: 1px solid var(--line); position: relative; }
.entry::before { content: ''; position: absolute; left: calc(var(--pad) * -1); top: -1px; width: 3px; height: 0; background: var(--accent); transition: height 0.18s ease; }
.entry:hover::before { height: 56px; }
.entry-rail { text-align: right; }
.entry-rail .enum { font-size: 30px; font-weight: 500; letter-spacing: -0.04em; color: var(--ink-faint); font-variant-numeric: tabular-nums; line-height: 0.9; }
.entry-rail .edate { font-family: var(--mono); font-size: 11px; color: var(--ink-soft); margin-top: 14px; line-height: 1.55; }
.entry-rail .esession { font-family: var(--mono); font-size: 10px; color: var(--ink-faint); margin-top: 7px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.entry-body { min-width: 0; }
.status-marker { display: inline-flex; align-items: center; gap: 9px; font-family: var(--mono); font-size: 10.5px; letter-spacing: 0.12em; text-transform: uppercase; font-weight: 600; margin-bottom: 14px; }
.status-marker .sq { width: 9px; height: 9px; flex-shrink: 0; }
.decision-text { font-size: 27px; font-weight: 500; line-height: 1.16; letter-spacing: -0.03em; color: var(--ink); margin-bottom: 22px; }
.detail-block { display: grid; grid-template-columns: 112px 1fr; gap: 22px; padding: 11px 0; border-top: 1px solid var(--line-soft); }
.detail-block .dlabel { font-family: var(--mono); font-size: 9.5px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--ink-faint); padding-top: 4px; }
.detail-block .dtext { font-size: 15px; line-height: 1.62; color: var(--ink-soft); }
.entry-footer { display: flex; align-items: center; gap: 22px; margin-top: 20px; }
.txt-btn { font-family: var(--mono); font-size: 10px; letter-spacing: 0.1em; text-transform: uppercase; padding: 4px 0; border: none; background: transparent; color: var(--ink-faint); cursor: pointer; border-bottom: 1px solid transparent; transition: all 0.13s; }
.txt-btn:hover { color: var(--ink); border-bottom-color: var(--ink); }
.txt-btn.danger:hover { color: var(--accent); border-bottom-color: var(--accent); }
mark { background: var(--accent-soft); color: var(--accent); padding: 0 3px; font-weight: 500; }

/* Edit mode */
.edit-mode { display: none; }
.entry.editing .view-mode { display: none; }
.entry.editing .edit-mode { display: block; }
.field { margin-bottom: 16px; }
.field label { display: block; font-family: var(--mono); font-size: 9.5px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--ink-faint); margin-bottom: 8px; }
.field textarea, .field select, .field input { width: 100%; font-family: var(--sans); font-size: 15px; color: var(--ink); background: transparent; border: none; border-bottom: 1px solid var(--line); padding: 8px 0; resize: vertical; line-height: 1.5; }
.field textarea:focus, .field select:focus, .field input:focus { outline: none; border-bottom-color: var(--accent); }
.field select { font-family: var(--mono); font-size: 13px; cursor: pointer; }
.edit-actions { display: flex; gap: 22px; margin-top: 18px; align-items: center; }
.btn-primary { font-family: var(--mono); font-size: 10.5px; letter-spacing: 0.1em; text-transform: uppercase; padding: 11px 20px; background: var(--ink); color: var(--paper); border: none; cursor: pointer; transition: background 0.15s; }
.btn-primary:hover { background: var(--accent); }
.btn-ghost { font-family: var(--mono); font-size: 10px; letter-spacing: 0.1em; text-transform: uppercase; padding: 4px 0; background: transparent; color: var(--ink-faint); border: none; border-bottom: 1px solid transparent; cursor: pointer; transition: all 0.13s; }
.btn-ghost:hover { color: var(--ink); border-bottom-color: var(--ink); }

/* Add decision */
.add-block { margin-top: 28px; }
.add-summary { font-family: var(--mono); font-size: 11px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--ink-soft); cursor: pointer; list-style: none; display: inline-flex; align-items: center; gap: 11px; padding: 14px 0; user-select: none; }
.add-summary::-webkit-details-marker { display: none; }
.add-summary .plus { color: var(--accent); font-size: 14px; transition: transform 0.2s; display: inline-block; }
details[open] .add-summary .plus { transform: rotate(45deg); }
.add-form { border-top: 1px solid var(--ink); padding: 26px 0 6px; }

/* Search results */
.result-group { font-family: var(--mono); font-size: 11px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--ink); font-weight: 600; margin: 40px 0 0; padding: 0 0 13px; border-bottom: 1px solid var(--ink); display: flex; align-items: center; gap: 11px; cursor: pointer; transition: color 0.13s; text-decoration: none; }
.result-group:hover { color: var(--accent); text-decoration: none; }
.result-group .arrow { color: var(--accent); }
.result-group .rslug { color: var(--ink-faint); font-weight: 400; letter-spacing: 0.04em; }
.result-count { font-family: var(--mono); font-size: 11px; letter-spacing: 0.06em; text-transform: uppercase; color: var(--ink-faint); margin: 22px 0 0; }
.search-results .entry { grid-template-columns: 96px 1fr; gap: 28px; }

/* Empty */
.empty { text-align: center; padding: 80px 0; color: var(--ink-faint); font-size: 17px; font-weight: 400; letter-spacing: -0.01em; }
.empty strong { color: var(--ink-soft); font-weight: 500; }
.empty .mono-note { font-family: var(--mono); font-size: 10.5px; letter-spacing: 0.1em; text-transform: uppercase; margin-top: 14px; display: block; }

/* Toast */
.toast { position: fixed; bottom: 30px; left: 50%; transform: translateX(-50%) translateY(20px); background: var(--ink); color: var(--paper); font-family: var(--mono); font-size: 11px; letter-spacing: 0.06em; text-transform: uppercase; padding: 13px 22px; opacity: 0; pointer-events: none; transition: opacity 0.2s, transform 0.2s; z-index: 100; }
.toast.show { opacity: 1; transform: translateX(-50%) translateY(0); }

/* Trash page */
.trash-head { display: flex; align-items: baseline; gap: 16px; margin: 32px 0 0; padding-bottom: 12px; border-bottom: 1px solid var(--ink); }
.trash-head .ttl { font-family: var(--mono); font-size: 11px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--ink); font-weight: 600; }
.trash-head .meta { font-family: var(--mono); font-size: 10.5px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--ink-faint); }

@media (max-width: 760px) {
  :root { --pad: 22px; }
  body { font-size: 14px; }
  .hero { grid-template-columns: 1fr; gap: 18px; }
  .hero h1 { font-size: 38px; }
  .statband { grid-template-columns: repeat(2, 1fr); }
  .statuskey { grid-template-columns: repeat(2, 1fr); gap: 22px; }
  .stat { border-right: none; border-bottom: 1px solid var(--line-soft); }
  .stat .num { font-size: 34px; }
  .index-head { display: none; }
  .project-row { grid-template-columns: 1fr auto; gap: 14px; }
  .project-row .pidx, .project-row .distbar, .project-row .row-actions { display: none; }
  .entry { grid-template-columns: 1fr; gap: 14px; }
  .entry-rail { text-align: left; display: flex; align-items: baseline; gap: 16px; }
  .entry-rail .edate, .entry-rail .esession { margin-top: 0; }
  .search-results .entry { grid-template-columns: 1fr; }
  .detail-block { grid-template-columns: 1fr; gap: 4px; }
  .proj-title-row h2 { font-size: 34px; }
}
`;

// ─── Components ───────────────────────────────────────────────────────────────

function statusMarker(status: string): string {
  const color = STATUS_VAR[status] ?? 'var(--ink-faint)';
  return `<span class="status-marker" style="color:${color};">
    <span class="sq" style="background:${color};"></span>${escapeHtml(status)}</span>`;
}

function distBar(dist: Record<string, number>, total: number): string {
  if (total === 0) return '<div class="distbar"></div>';
  const segs = STATUS_ORDER
    .filter(s => (dist[s] ?? 0) > 0)
    .map(s => `<span style="width:${((dist[s] ?? 0) / total * 100).toFixed(1)}%;background:${STATUS_VAR[s]};" title="${dist[s]} ${s}"></span>`)
    .join('');
  return `<div class="distbar">${segs}</div>`;
}

function topBar(active: string, totalEntries: number): string {
  const links = [
    { href: '/', label: 'Projects' },
    { href: '/trash', label: 'Trash' },
  ];
  const navLinks = links.map(l =>
    `<a href="${l.href}" class="nav-link${active === l.label ? ' active' : ''}">${l.label}</a>`
  ).join('');
  return `
  <div class="topedge"></div>
  <header class="topbar">
    <div class="topbar-inner">
      <a class="wordmark" href="/">
        <span class="mark"></span>
        <span class="wm-text">Decision Log</span>
      </a>
      <div class="topbar-meta">
        ${navLinks}
        <span><span class="val">${pad2(totalEntries)}</span> Entries</span>
        <span class="live">Local Archive</span>
      </div>
    </div>
  </header>`;
}

function pageHead(title: string): string {
  return `<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
  ${fontLinks}
  <style>${baseStyles}</style>
</head>`;
}

function projectRow(
  p: { slug: string; count: number; lastActivity: string; archived: boolean },
  idx: number,
  dist: Record<string, number>
): string {
  const archBtn = p.archived
    ? `<button class="mini-btn" onclick="event.stopPropagation(); setArchive('${escapeHtml(p.slug)}', false)">Unarchive</button>`
    : `<button class="mini-btn warm" onclick="event.stopPropagation(); setArchive('${escapeHtml(p.slug)}', true)">Archive</button>`;
  return `
  <div class="project-row" onclick="location.href='/project/${encodeURIComponent(p.slug)}'">
    <div class="pidx">${pad2(idx)}</div>
    <div class="project-main">
      <div class="pname">${escapeHtml(projectTitle(p.slug))}</div>
      <div class="pslug">${escapeHtml(p.slug)}</div>
    </div>
    ${distBar(dist, p.count)}
    <div class="pcount">${p.count}</div>
    <div class="pdate">${fmtDate(p.lastActivity)}</div>
    <div class="row-actions">${archBtn}</div>
  </div>`;
}

function decisionEntry(d: StoredDecision, idx: number, slug: string, query = ''): string {
  const statusOptions = STATUS_ORDER.map(s =>
    `<option value="${s}" ${d.status === s ? 'selected' : ''}>${s}</option>`
  ).join('');
  return `
  <div class="entry" id="entry-${d.id}">
    <div class="entry-rail">
      <div class="enum">${pad(idx)}</div>
      <div class="edate">${fmtDate(d.timestamp)}<br>${fmtTime(d.timestamp)}</div>
      <div class="esession">${escapeHtml(d.session_id)}</div>
    </div>
    <div class="entry-body">
      <div class="view-mode">
        ${statusMarker(d.status)}
        <div class="decision-text">${highlightQuery(d.decision, query)}</div>
        <div class="detail-block">
          <div class="dlabel">Considered</div>
          <div class="dtext">${highlightQuery(d.considered, query)}</div>
        </div>
        <div class="detail-block">
          <div class="dlabel">Rationale</div>
          <div class="dtext">${highlightQuery(d.rationale, query)}</div>
        </div>
        <div class="entry-footer">
          <button class="txt-btn" onclick="startEdit('${d.id}')">Edit</button>
          <button class="txt-btn danger" onclick="deleteDecision('${d.id}', '${escapeHtml(slug)}')">Delete</button>
        </div>
      </div>
      <div class="edit-mode">
        <div class="field">
          <label>Decision</label>
          <textarea id="edit-decision-${d.id}" rows="2">${escapeHtml(d.decision)}</textarea>
        </div>
        <div class="field">
          <label>Considered</label>
          <textarea id="edit-considered-${d.id}" rows="2">${escapeHtml(d.considered)}</textarea>
        </div>
        <div class="field">
          <label>Rationale</label>
          <textarea id="edit-rationale-${d.id}" rows="2">${escapeHtml(d.rationale)}</textarea>
        </div>
        <div class="field">
          <label>Status</label>
          <select id="edit-status-${d.id}">${statusOptions}</select>
        </div>
        <div class="edit-actions">
          <button class="btn-primary" onclick="saveEdit('${d.id}', '${escapeHtml(slug)}')">Save entry</button>
          <button class="btn-ghost" onclick="cancelEdit('${d.id}')">Cancel</button>
        </div>
      </div>
    </div>
  </div>`;
}

function trashEntry(d: StoredDecision): string {
  return `
  <div class="entry" id="entry-${d.id}">
    <div class="entry-rail">
      <div class="edate">${fmtDate(d.deleted_at ?? '')}<br>${fmtTime(d.deleted_at ?? '')}</div>
      <div class="esession"><a href="/project/${encodeURIComponent(d.project)}" style="color:var(--accent);font-family:var(--mono);font-size:10px;letter-spacing:0.06em;">${escapeHtml(projectTitle(d.project))}</a></div>
    </div>
    <div class="entry-body">
      ${statusMarker(d.status)}
      <div class="decision-text">${escapeHtml(d.decision)}</div>
      <div class="detail-block">
        <div class="dlabel">Considered</div>
        <div class="dtext">${escapeHtml(d.considered)}</div>
      </div>
      <div class="detail-block">
        <div class="dlabel">Rationale</div>
        <div class="dtext">${escapeHtml(d.rationale)}</div>
      </div>
      <div class="entry-footer">
        <button class="txt-btn" onclick="restore('${d.id}', '${escapeHtml(d.project)}')">Restore</button>
        <button class="txt-btn danger" onclick="permanentDelete('${d.id}', '${escapeHtml(d.project)}')">Delete permanently</button>
      </div>
    </div>
  </div>`;
}

const cardScripts = `
  function startEdit(id) { document.getElementById('entry-' + id).classList.add('editing'); }
  function cancelEdit(id) { document.getElementById('entry-' + id).classList.remove('editing'); }
  async function saveEdit(id, slug) {
    const body = {
      decision:   document.getElementById('edit-decision-'   + id).value,
      considered: document.getElementById('edit-considered-' + id).value,
      rationale:  document.getElementById('edit-rationale-'  + id).value,
      status:     document.getElementById('edit-status-'     + id).value,
    };
    const res = await fetch('/project/' + slug + '/decision/' + id, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    if ((await res.json()).ok) location.reload(); else alert('Failed to save.');
  }
  async function deleteDecision(id, slug) {
    if (!confirm('Move this decision to trash?')) return;
    const res = await fetch('/project/' + slug + '/decision/' + id, { method: 'DELETE' });
    if (!(await res.json()).ok) { alert('Failed to delete.'); return; }
    const entry = document.getElementById('entry-' + id);
    if (!entry) return;
    // In search results, remove the group header too if this was the last entry in it
    const timeline = entry.parentElement;
    entry.remove();
    if (timeline && timeline.classList.contains('search-results')) {
      const groups = timeline.querySelectorAll('.result-group');
      groups.forEach(header => {
        // Find next siblings until the next header; if none are entries, remove the header
        let next = header.nextElementSibling;
        let hasEntries = false;
        while (next && !next.classList.contains('result-group')) {
          if (next.classList.contains('entry')) hasEntries = true;
          next = next.nextElementSibling;
        }
        if (!hasEntries) header.remove();
      });
    }
  }
  let _toastTimer;
  function toast(msg) {
    let el = document.getElementById('toast');
    if (!el) { el = document.createElement('div'); el.id = 'toast'; el.className = 'toast'; document.body.appendChild(el); }
    el.textContent = msg; el.classList.add('show');
    clearTimeout(_toastTimer); _toastTimer = setTimeout(() => el.classList.remove('show'), 2000);
  }
`;

// ─── Routes ───────────────────────────────────────────────────────────────────

// GET / — Homepage
app.get('/', async (_req: Request, res: Response) => {
  const projects = await listProjects();

  // Load decisions per project for distbar + global stats
  const projectDecisions = await Promise.all(projects.map(p => loadDecisions(p.slug)));
  const allDecisions = projectDecisions.flat();

  const totals: Record<string, number> = { decided: 0, deferred: 0, reversed: 0, rejected: 0 };
  for (const d of allDecisions) { totals[d.status] = (totals[d.status] ?? 0) + 1; }
  const grandTotal = allDecisions.length;

  const projectsWithDist = projects.map((p, i) => {
    const dist: Record<string, number> = { decided: 0, deferred: 0, reversed: 0, rejected: 0 };
    for (const d of projectDecisions[i]) { dist[d.status] = (dist[d.status] ?? 0) + 1; }
    return { ...p, dist };
  });

  const active = projectsWithDist.filter(p => !p.archived);
  const archived = projectsWithDist.filter(p => p.archived);

  const deferred = await getDeferredOlderThan(30);
  const nudge = deferred.length > 0 ? `
    <div class="nudge">
      <span class="ico">&#x2691; Deferred</span>
      <span><strong>${deferred.length} decision${deferred.length === 1 ? '' : 's'}</strong> ${deferred.length === 1 ? 'has' : 'have'} sat untouched for over 30 days. Worth a revisit.</span>
      <a href="/search?status=deferred">Review &#x2192;</a>
    </div>` : '';

  const statuskey = `
    <div class="statuskey">
      ${STATUS_ORDER.map(s => `
        <div class="keyitem">
          <div class="kihead"><span class="sq" style="background:${STATUS_VAR[s]};"></span>${s}</div>
          <div class="kn">${STATUS_GLOSS[s]}</div>
        </div>`).join('')}
    </div>`;

  const statband = `
    <div class="statband">
      <div class="stat">
        <div class="num">${pad2(grandTotal)}</div>
        <div class="cap">Total logged</div>
      </div>
      ${STATUS_ORDER.map(s => `
        <div class="stat">
          <div class="num"><span class="sq" style="background:${STATUS_VAR[s]};"></span>${pad2(totals[s] ?? 0)}</div>
          <div class="cap">${s}</div>
        </div>`).join('')}
    </div>`;

  const indexHead = `
    <div class="index-head">
      <span>&#x2116;</span>
      <span>Project</span>
      <span>Distribution</span>
      <span class="r">Count</span>
      <span class="r">Updated</span>
      <span></span>
    </div>`;

  const activeSection = active.length === 0
    ? `<div class="empty">No projects on record yet.<span class="mono-note">Decisions appear here after your first session</span></div>`
    : `<div class="index-table">${indexHead}${active.map((p, i) => projectRow(p, i + 1, p.dist)).join('')}</div>`;

  const archivedSection = archived.length === 0 ? '' : `
    <details class="archived-block">
      <summary class="archived-summary"><span class="chev">&#x25B8;</span> Archived projects (${archived.length})</summary>
      <div class="index-table">${archived.map((p, i) => projectRow(p, active.length + i + 1, p.dist)).join('')}</div>
    </details>`;

  const html = `<!DOCTYPE html>
<html lang="en">
${pageHead('Decision Log')}
<body>
  ${topBar('Projects', grandTotal)}
  <div class="container">
    <div class="hero">
      <h1>Every decision, on the record.</h1>
      <p>Product calls captured from your Claude Code sessions. The reasoning, the alternatives, the roads not taken. The log writes itself.</p>
    </div>
    ${statuskey}
    ${nudge}
    <form class="search-bar" action="/search" method="GET">
      <span class="prefix">/</span>
      <input class="search-input" type="text" name="q" placeholder="Search every decision..." />
      <button class="search-btn" type="submit">Search <span class="arr">&#x2192;</span></button>
    </form>
    <div class="section-head">
      <span class="ttl">Overview</span>
    </div>
    ${statband}
    <div class="section-head">
      <span class="ttl">${active.length} Active Project${active.length === 1 ? '' : 's'}</span>
      <span class="meta">${grandTotal} decision${grandTotal === 1 ? '' : 's'}</span>
    </div>
    ${activeSection}
    ${archivedSection}
  </div>
  <script>
    async function setArchive(slug, archive) {
      const method = archive ? 'POST' : 'DELETE';
      const res = await fetch('/project/' + slug + '/archive', { method });
      if ((await res.json()).ok) location.reload(); else alert('Failed to update archive status.');
    }
  </script>
</body>
</html>`;

  res.send(html);
});

// GET /search?q=...&status=...
app.get('/search', async (req: Request, res: Response) => {
  const q = (req.query['q'] as string) ?? '';
  const statusFilter = (req.query['status'] as string) ?? '';
  const totalEntries = await getTotalEntries();

  let results: StoredDecision[] = [];
  // hasSearch is true only when the user has provided a real query or a specific status filter.
  // statusFilter === 'all' is treated as "no filter" so the page stays empty with no query.
  const hasSearch = q.trim().length > 0 || (statusFilter.length > 0 && statusFilter !== 'all');

  if (hasSearch) {
    results = await searchDecisions(q.trim());
    if (statusFilter && statusFilter !== 'all') {
      results = results.filter(d => d.status === statusFilter);
    }
  }

  const grouped: Record<string, StoredDecision[]> = {};
  for (const d of results) {
    if (!grouped[d.project]) grouped[d.project] = [];
    grouped[d.project].push(d);
  }

  let resultHtml = '';
  if (hasSearch && results.length === 0) {
    resultHtml = `<div class="empty">Nothing matches.<span class="mono-note">Try a different term or status</span></div>`;
  } else if (hasSearch) {
    resultHtml = `<div class="search-results">`;
    for (const [proj, decisions] of Object.entries(grouped)) {
      const allProjDecisions = await loadDecisions(proj);
      const orderIndex = new Map(allProjDecisions.map((d, i) => [d.id, i + 1]));
      resultHtml += `<a class="result-group" href="/project/${encodeURIComponent(proj)}">
        <span class="arrow">&#x2192;</span>${escapeHtml(projectTitle(proj))}
        <span class="rslug">${escapeHtml(proj)}</span></a>`;
      resultHtml += decisions.map(d => decisionEntry(d, orderIndex.get(d.id) ?? 0, proj, q)).join('');
    }
    resultHtml += `</div>`;
  }

  const statusTabs = ['all', ...STATUS_ORDER].map(s => {
    const isActive = (statusFilter || 'all') === s;
    const params = new URLSearchParams({ q, status: s });
    const sw = s === 'all' ? '' : `<span class="swatch" style="background:${STATUS_VAR[s]};display:inline-block;"></span>`;
    return `<a href="/search?${params}" class="status-tab${isActive ? ' active' : ''}">${sw}${s}</a>`;
  }).join('');

  const html = `<!DOCTYPE html>
<html lang="en">
${pageHead('Search — Decision Log')}
<body>
  ${topBar('', totalEntries)}
  <div class="container">
    <div class="proj-head">
      <a class="crumb" href="/">&#x2190; All projects</a>
    </div>
    <form class="search-bar" action="/search" method="GET">
      <span class="prefix">/</span>
      <input class="search-input" type="text" name="q" placeholder="Search every decision..." value="${escapeHtml(q)}" autofocus />
      <input type="hidden" name="status" value="${escapeHtml(statusFilter)}" />
      <button class="search-btn" type="submit">Search <span class="arr">&#x2192;</span></button>
    </form>
    <div class="status-tabs">${statusTabs}</div>
    ${(hasSearch || statusFilter) ? `<div class="result-count">${results.length} result${results.length === 1 ? '' : 's'}${q ? ` for &ldquo;${escapeHtml(q)}&rdquo;` : ''}</div>` : ''}
    ${resultHtml}
  </div>
  <script>${cardScripts}</script>
</body>
</html>`;

  res.send(html);
});

// GET /project/:slug — Decision timeline with status filter
app.get('/project/:slug', async (req: Request, res: Response) => {
  const { slug } = req.params;
  const statusFilter = (req.query['status'] as string) ?? 'all';
  const totalEntries = await getTotalEntries();

  const allDecisions = await loadDecisions(slug);
  const decisions = statusFilter && statusFilter !== 'all'
    ? await loadDecisions(slug, statusFilter)
    : allDecisions;

  const counts: Record<string, number> = { all: allDecisions.length };
  for (const s of STATUS_ORDER) {
    counts[s] = allDecisions.filter(d => d.status === s).length;
  }

  const orderIndex = new Map(allDecisions.map((d, i) => [d.id, i + 1]));

  const statusTabs = ['all', ...STATUS_ORDER].map(s => {
    const isActive = (statusFilter || 'all') === s;
    const href = `/project/${encodeURIComponent(slug)}?status=${s}`;
    const sw = s === 'all' ? '' : `<span class="swatch" style="background:${STATUS_VAR[s]};display:inline-block;"></span>`;
    return `<a href="${href}" class="status-tab${isActive ? ' active' : ''}">${sw}${s}<span class="tcount">${counts[s] ?? 0}</span></a>`;
  }).join('');

  let entriesHtml = '';
  if (decisions.length === 0) {
    entriesHtml = `<div class="empty">No <strong>${escapeHtml(statusFilter)}</strong> decisions in this project.<span class="mono-note">Switch filter or add one below</span></div>`;
  } else {
    entriesHtml = `<div class="timeline">${decisions.map(d => decisionEntry(d, orderIndex.get(d.id) ?? 0, slug)).join('')}</div>`;
  }

  const addFormHtml = `
    <details class="add-block">
      <summary class="add-summary"><span class="plus">&#xFF0B;</span> Add a decision by hand</summary>
      <div class="add-form">
        <div class="field">
          <label>Decision</label>
          <textarea id="new-decision" rows="2" placeholder="What was decided?"></textarea>
        </div>
        <div class="field">
          <label>Considered</label>
          <textarea id="new-considered" rows="2" placeholder="What alternatives were weighed?"></textarea>
        </div>
        <div class="field">
          <label>Rationale</label>
          <textarea id="new-rationale" rows="2" placeholder="Why this direction?"></textarea>
        </div>
        <div class="field">
          <label>Status</label>
          <select id="new-status">
            ${STATUS_ORDER.map(s => `<option value="${s}">${s}</option>`).join('')}
          </select>
        </div>
        <div class="edit-actions">
          <button class="btn-primary" onclick="addDecisionManually()">Log decision</button>
        </div>
      </div>
    </details>`;

  const html = `<!DOCTYPE html>
<html lang="en">
${pageHead(`${slug} — Decision Log`)}
<body>
  ${topBar('Projects', totalEntries)}
  <div class="container">
    <div class="proj-head">
      <a class="crumb" href="/">&#x2190; All projects</a>
      <div class="proj-title-row">
        <div>
          <h2>${escapeHtml(projectTitle(slug))}</h2>
          <div class="pslug">${escapeHtml(slug)}</div>
        </div>
        <a class="export-btn" href="/project/${encodeURIComponent(slug)}/export">&#x2193; Export Markdown</a>
      </div>
    </div>
    <div class="status-tabs">${statusTabs}</div>
    ${entriesHtml}
    ${addFormHtml}
  </div>
  <script>
    ${cardScripts}
    async function addDecisionManually() {
      const body = {
        decision:   document.getElementById('new-decision').value.trim(),
        considered: document.getElementById('new-considered').value.trim(),
        rationale:  document.getElementById('new-rationale').value.trim(),
        status:     document.getElementById('new-status').value,
        session_id: 'manual',
        cwd:        '',
      };
      if (!body.decision) { toast('A decision statement is required.'); return; }
      const res = await fetch('/project/${encodeURIComponent(slug)}/decisions', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const data = await res.json();
      if (data.ok) location.reload(); else toast('Failed to add decision.');
    }
  </script>
</body>
</html>`;

  res.send(html);
});

// POST /project/:slug/decisions — manually add a decision
app.post('/project/:slug/decisions', async (req: Request, res: Response) => {
  const { slug } = req.params;
  const { decision, considered, rationale, status, session_id, cwd } = req.body as Partial<StoredDecision>;

  if (!decision) { res.status(400).json({ ok: false, error: 'decision is required' }); return; }

  const stored = await addDecision(slug, {
    decision: decision ?? '',
    considered: considered ?? '',
    rationale: rationale ?? '',
    status: (status as StoredDecision['status']) ?? 'decided',
    session_id: session_id ?? 'manual',
    cwd: cwd ?? '',
  });

  res.json({ ok: true, id: stored.id });
});

// POST /project/:slug/archive — Archive a project
app.post('/project/:slug/archive', (req: Request, res: Response) => {
  archiveProject(req.params.slug);
  res.json({ ok: true });
});

// DELETE /project/:slug/archive — Unarchive a project
app.delete('/project/:slug/archive', (req: Request, res: Response) => {
  unarchiveProject(req.params.slug);
  res.json({ ok: true });
});

// PUT /project/:slug/decision/:id — Update a decision
app.put('/project/:slug/decision/:id', async (req: Request, res: Response) => {
  const { slug, id } = req.params;
  const { decision, considered, rationale, status } = req.body as Partial<StoredDecision>;
  const ok = await updateDecision(slug, id, { decision, considered, rationale, status });
  res.json({ ok });
});

// DELETE /project/:slug/decision/:id — Soft-delete a decision
app.delete('/project/:slug/decision/:id', async (req: Request, res: Response) => {
  const { slug, id } = req.params;
  const ok = await deleteDecision(slug, id);
  res.json({ ok });
});

// POST /project/:slug/decision/:id/restore — Restore a soft-deleted decision
app.post('/project/:slug/decision/:id/restore', async (req: Request, res: Response) => {
  const { slug, id } = req.params;
  const ok = await restoreDecision(slug, id);
  res.json({ ok });
});

// DELETE /project/:slug/decision/:id/permanent — Permanently delete a decision
app.delete('/project/:slug/decision/:id/permanent', async (req: Request, res: Response) => {
  const { slug, id } = req.params;
  const ok = await permanentlyDelete(slug, id);
  res.json({ ok });
});

// GET /trash — Trash page
app.get('/trash', async (_req: Request, res: Response) => {
  const trashed = await listTrashed();
  const totalEntries = await getTotalEntries();

  const entriesHtml = trashed.length === 0
    ? `<div class="empty">Trash is empty.<span class="mono-note">Deleted decisions appear here for recovery</span></div>`
    : `<div class="timeline">${trashed.map(d => trashEntry(d)).join('')}</div>`;

  const html = `<!DOCTYPE html>
<html lang="en">
${pageHead('Trash — Decision Log')}
<body>
  ${topBar('Trash', totalEntries)}
  <div class="container">
    <div class="trash-head">
      <span class="ttl">Trash</span>
      <span class="meta">${trashed.length} item${trashed.length === 1 ? '' : 's'}</span>
    </div>
    ${entriesHtml}
  </div>
  <script>
    async function restore(id, slug) {
      const res = await fetch('/project/' + slug + '/decision/' + id + '/restore', { method: 'POST' });
      if ((await res.json()).ok) document.getElementById('entry-' + id).remove();
      else alert('Failed to restore.');
    }
    async function permanentDelete(id, slug) {
      if (!confirm('Permanently delete this decision? It cannot be recovered.')) return;
      const res = await fetch('/project/' + slug + '/decision/' + id + '/permanent', { method: 'DELETE' });
      if ((await res.json()).ok) document.getElementById('entry-' + id).remove();
      else alert('Failed to delete.');
    }
  </script>
</body>
</html>`;

  res.send(html);
});

// GET /project/:slug/export — Markdown export
app.get('/project/:slug/export', async (req: Request, res: Response) => {
  const { slug } = req.params;
  // loadDecisions returns ORDER BY timestamp ASC from DB — no re-sort needed
  const decisions = await loadDecisions(slug);

  let md = `# Decision Log: ${slug}\n\n`;

  if (decisions.length === 0) {
    md += '_No decisions recorded yet._\n';
  } else {
    for (const d of decisions) {
      md += `## ${d.timestamp} ${d.decision}\n\n`;
      md += `**Considered:** ${d.considered}\n\n`;
      md += `**Rationale:** ${d.rationale}\n\n`;
      md += `**Status:** ${d.status}\n\n`;
      md += '---\n\n';
    }
  }

  res.setHeader('Content-Type', 'text/markdown');
  res.setHeader('Content-Disposition', `attachment; filename="${slug}-decisions.md"`);
  res.send(md);
});

app.listen(PORT, () => {
  console.log(`Decision Log server running at http://localhost:${PORT}`);
});

export default app;
