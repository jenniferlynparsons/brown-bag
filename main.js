'use strict';
/*
 * Brown Bag — one book, one hour, once a week.
 * Inspectional reading for a working library: a four-phase session timer,
 * an on-deck queue, a verdict for every book, and a running list of chapters
 * worth coming back to. Plain JavaScript, no build step, desktop and mobile.
 */
const obsidian = require('obsidian');
const {
  Plugin, ItemView, Modal, Notice, Setting, PluginSettingTab, TFile, Menu,
  MarkdownRenderChild, normalizePath, requestUrl, setIcon, debounce,
} = obsidian;

const VIEW_TYPE = 'brown-bag-view';
const STATUS_LABEL = { shelf: 'On the shelf', 'on deck': 'On deck', skimming: 'This week', skimmed: 'Skimmed' };
const VERDICTS = [
  ['read deeper', 'Read deeper'],
  ['reference', 'Keep as a reference'],
  ['got what I needed', 'Got what I needed'],
  ['let it go', 'Let it go'],
];
const VERDICT_LABEL = Object.fromEntries(VERDICTS);

const DEFAULT_PHASES = [
  { name: 'First pass', minutes: 10, prompt: 'Cover copy, intro or preface, table of contents. What is this book arguing? Mark the chapters that look useful.' },
  { name: 'Openings & closings', minutes: 15, prompt: 'Read the first and last few paragraphs of the chapters you marked. Add the keepers to "Chapters worth reading".' },
  { name: 'One section, properly', minutes: 25, prompt: 'Pick the single most relevant section and read it for real. If you brought a guiding question, read against it.' },
  { name: 'Wrap-up', minutes: 10, prompt: 'Talk it through, out loud or on paper: the one idea worth keeping, where it applies right now, and what happens to the book next.' },
];

const DEFAULT_SETTINGS = {
  booksFolder: 'Library',
  topicsFolder: 'Topics',
  exportsFolder: 'Exports',
  retrosFolder: 'Retros',
  phases: DEFAULT_PHASES,
  retroEvery: 5,
  openOnStartup: true,
  lastRetroAt: 0,
  session: null,
  exportedKeys: [],
  lastExportDate: '',
};

/* ------------------------------------------------------------------ */
/* Pure helpers                                                       */
/* ------------------------------------------------------------------ */

function pad(n) { return String(n).padStart(2, '0'); }
function todayStr(d) { d = d || new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function toDateStr(v) {
  if (!v) return '';
  if (v instanceof Date) return isNaN(v) ? '' : v.toISOString().slice(0, 10);
  const m = String(v).match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : '';
}
function parseLocal(s) { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); }
function niceDate(s) { return s ? parseLocal(s).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }) : ''; }
function shortDate(s) { return s ? parseLocal(s).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : ''; }

function stripLink(v) {
  let s = String(v == null ? '' : v).trim();
  const m = s.match(/^\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]$/);
  if (m) s = m[1];
  return s.split('/').pop().replace(/\.md$/i, '').trim();
}

function toList(v) {
  if (v == null || v === '') return [];
  const arr = Array.isArray(v) ? v.flat(Infinity) : String(v).split(',');
  const out = [];
  for (const x of arr) { const s = stripLink(x); if (s && !out.includes(s)) out.push(s); }
  return out;
}

function normStatus(v) {
  const s = String(v || '').toLowerCase().trim();
  if (/^(on[ _-]?deck|next|queued|up next)$/.test(s)) return 'on deck';
  if (/^(skimming|this week|current|reading)$/.test(s)) return 'skimming';
  if (/^(skimmed|done|finished)$/.test(s)) return 'skimmed';
  return 'shelf';
}

function normVerdict(v) {
  const s = String(v || '').toLowerCase().trim();
  if (!s) return '';
  if (/deep/.test(s)) return 'read deeper';
  if (/ref/.test(s)) return 'reference';
  if (/needed|got it/.test(s)) return 'got what I needed';
  if (/let|go|drop/.test(s)) return 'let it go';
  return '';
}

function dateList(v) {
  const arr = Array.isArray(v) ? v.flat(Infinity) : (v ? String(v).split(',') : []);
  return [...new Set(arr.map(toDateStr).filter(Boolean))].sort();
}

function bookFromFrontmatter(path, basename, fm) {
  fm = fm || {};
  return {
    path,
    basename,
    title: String(fm.title || basename),
    author: fm.author ? String(fm.author) : '',
    cover: fm.cover ? String(fm.cover) : '',
    link: fm.link ? String(fm.link) : '',
    status: normStatus(fm.status),
    verdict: normVerdict(fm.verdict),
    idea: fm.idea ? String(fm.idea) : '',
    topics: toList(fm.topics),
    sessions: dateList(fm.sessions),
    decked: toDateStr(fm.decked),
    skimmed: toDateStr(fm.skimmed),
  };
}

function byTitle(a, b) { return a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }); }

/** Body of a "## Heading" section (up to the next ## or # heading). */
function getSection(content, heading) {
  const re = new RegExp(`^##[ \\t]+${heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[ \\t]*$`, 'im');
  const m = re.exec(content || '');
  if (!m) return null;
  const start = m.index + m[0].length;
  const rest = content.slice(start);
  const next = /^#{1,2}\s/m.exec(rest);
  return { start, end: next ? start + next.index : content.length, text: (next ? rest.slice(0, next.index) : rest) };
}

function setSection(content, heading, body) {
  const sec = getSection(content, heading);
  const block = `\n\n${body.trim()}\n`;
  if (!sec) return `${content.replace(/\s*$/, '')}\n\n## ${heading}${block}`;
  const after = content.slice(sec.end);
  return `${content.slice(0, sec.start)}${block}${after ? `\n${after}` : ''}`;
}

/** Tasks under "## Chapters worth reading": [{ text, done, line }] where line is the index in content.split('\n'). */
function parseChapters(content) {
  const lines = (content || '').split('\n');
  const out = [];
  let inside = false;
  lines.forEach((l, i) => {
    if (/^##\s+Chapters worth reading\s*$/i.test(l)) { inside = true; return; }
    if (inside && /^#{1,2}\s/.test(l)) { inside = false; return; }
    if (!inside) return;
    const m = l.match(/^\s*[-*]\s+\[( |x|X)\]\s+(.*\S)\s*$/);
    if (m) out.push({ text: m[2], done: m[1] !== ' ', line: i });
  });
  return out;
}

function toggleChapterLine(content, lineIndex, text, done) {
  const lines = content.split('\n');
  const l = lines[lineIndex];
  if (l == null || !l.includes(text)) return content; // file changed underneath us
  lines[lineIndex] = l.replace(/\[( |x|X)\]/, done ? '[x]' : '[ ]');
  return lines.join('\n');
}

/** Where a running session is: { phaseIndex, phaseLeftMs, totalLeftMs, done } */
function sessionState(session, phases, now) {
  const totalMs = phases.reduce((s, p) => s + p.minutes * 60000, 0);
  const paused = session.pausedAt ? now - session.pausedAt : 0;
  const elapsed = Math.max(0, now - session.startedAt - (session.pausedMs || 0) - paused);
  let acc = 0;
  for (let i = 0; i < phases.length; i++) {
    const len = phases[i].minutes * 60000;
    if (elapsed < acc + len) return { phaseIndex: i, phaseLeftMs: acc + len - elapsed, totalLeftMs: totalMs - elapsed, elapsed, done: false };
    acc += len;
  }
  return { phaseIndex: phases.length - 1, phaseLeftMs: 0, totalLeftMs: 0, elapsed, done: true };
}

function fmtMs(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${pad(s % 60)}`;
}

function safeFileName(s) {
  return String(s).replace(/[\\/:*?"<>|#^[\]]/g, '').replace(/\s+/g, ' ').trim().slice(0, 120) || 'Untitled';
}
function yamlStr(s) { return JSON.stringify(String(s == null ? '' : s)); }

const WHY_HEADING = 'Why this book';
const WHY_PROMPT = 'What drew you to it, and what are you hoping to find?';

function getWhy(content) {
  const sec = getSection(content, WHY_HEADING);
  return sec ? sec.text.trim() : '';
}

/** Write the Why section. A missing section goes above "Guiding question" (or the first ## heading). */
function setWhy(content, text) {
  text = (text || '').trim();
  if (getSection(content, WHY_HEADING)) return setSection(content, WHY_HEADING, text);
  if (!text) return content;
  const block = `## ${WHY_HEADING}\n\n${text}\n\n`;
  const anchor = /^##[ \t]+Guiding question[ \t]*$/im.exec(content) || /^##\s/m.exec(content);
  if (anchor) return content.slice(0, anchor.index) + block + content.slice(anchor.index);
  return `${content.replace(/\s*$/, '')}\n\n${block}`;
}

const BOOK_BODY = [
  '```brown-bag', 'show: book', '```', '',
  `## ${WHY_HEADING}`, '', '',
  '## Guiding question', '', '',
  '## First pass', '', '',
  '## Chapters worth reading', '', '- [ ] ', '',
  '## Notes', '', '',
  '## Verdict', '', '',
].join('\n');

function buildBookNote({ title, author, cover, link, topics, status, decked, why }) {
  const lines = ['---',
    `title: ${yamlStr(title)}`,
    `author: ${yamlStr(author)}`,
    `cover: ${yamlStr(cover)}`,
    `link: ${yamlStr(link)}`,
    `status: ${status || 'shelf'}`,
    'verdict:',
    'idea:'];
  if (topics && topics.length) { lines.push('topics:'); for (const t of topics) lines.push(`  - ${yamlStr(`[[${t}]]`)}`); } else lines.push('topics: []');
  lines.push('sessions: []', decked ? `decked: ${decked}` : 'decked:', 'skimmed:', '---', '', why && why.trim() ? setWhy(BOOK_BODY, why) : BOOK_BODY);
  return lines.join('\n');
}

function buildTopicNote() {
  return ['---', 'type: topic', '---', '', '```brown-bag', 'show: topic', '```', '', '## Notes', '', ''].join('\n');
}

function buildRetroNote(date, sessions) {
  return [`# Retro — ${niceDate(date)}`, '', `${sessions} sessions so far.`, '',
    '## Did I keep anything?', '', '',
    '## Was the hour worth it?', '', '',
    '## What do the verdicts say about the library?', '', '',
    '## What changes for the next stretch?', '', '- Keep:', '- Drop:', '- Try:', ''].join('\n');
}

function md(s) { return String(s || '').replace(/([*_`[\]])/g, '\\$1'); }

function verdictBody({ verdict, idea, applies, date }) {
  const out = [`*Skimmed ${date} · ${VERDICT_LABEL[verdict] || verdict}*`, ''];
  out.push(`**The one idea worth keeping:** ${idea.trim() || '—'}`, '');
  out.push(`**Where it applies right now:** ${applies.trim() || '—'}`);
  return out.join('\n');
}

function skimKey(b) { return `${b.title}|${b.skimmed}`; }

function exportSkimNotes(books, applies, settings, today) {
  const seen = new Set(settings.exportedKeys || []);
  const fresh = books.filter((b) => b.status === 'skimmed' && !seen.has(skimKey(b)));
  if (!fresh.length) return null;
  const since = settings.lastExportDate ? `since ${niceDate(settings.lastExportDate)}` : 'so far';
  const out = [`# Brown Bag notes — ${since}`, '', `*Exported ${niceDate(today)}*`, ''];
  for (const [v, label] of VERDICTS) {
    const list = fresh.filter((b) => b.verdict === v).sort((a, b) => a.skimmed.localeCompare(b.skimmed) || byTitle(a, b));
    if (!list.length) continue;
    out.push(`## ${label}`, '');
    for (const b of list) {
      const meta = [b.author && `*${md(b.author)}*`, b.topics.join(', '), b.link && `[${linkLabel(b.link)}](${b.link})`].filter(Boolean);
      out.push(`### ${md(b.title)}`, '');
      if (meta.length) out.push(meta.join(' · '), '');
      if (b.idea) out.push(`> ${b.idea}`, '');
      if (applies[b.path]) out.push(`Where it applies: ${applies[b.path]}`, '');
    }
  }
  const unrated = fresh.filter((b) => !b.verdict);
  if (unrated.length) out.push('## No verdict yet', '', ...unrated.map((b) => `- ${md(b.title)}`), '');
  return { markdown: out.join('\n'), keys: fresh.map(skimKey) };
}

function exportChapters(entries, today) {
  // entries: [{ book, chapters: [{text, done}] }]
  const open = entries.map((e) => ({ book: e.book, list: e.chapters.filter((c) => !c.done) })).filter((e) => e.list.length);
  const out = [`# Chapters to read — ${niceDate(today)}`, ''];
  if (!open.length) out.push('Nothing on the list yet.', '');
  for (const e of open.sort((a, b) => byTitle(a.book, b.book))) {
    out.push(`## ${md(e.book.title)}${e.book.author ? ` — ${md(e.book.author)}` : ''}`, '', ...e.list.map((c) => `- [ ] ${c.text}`), '');
  }
  return out.join('\n');
}

const LIB_COLS = ['Title', 'Author', 'Status', 'Verdict', 'Idea', 'Topics', 'Sessions', 'Skimmed', 'Link', 'Cover'];
function libRows(books) {
  return [...books].sort(byTitle).map((b) => [b.title, b.author, STATUS_LABEL[b.status], VERDICT_LABEL[b.verdict] || '', b.idea,
    b.topics.join(', '), b.sessions.join(', '), b.skimmed, b.link, b.cover]);
}
function exportLibraryMarkdown(books, today) {
  const cell = (s) => String(s || '').replace(/\|/g, '\\|').replace(/\n+/g, ' ');
  const cols = LIB_COLS.slice(0, -1);
  return [`# Library — ${niceDate(today)}`, '', `${books.length} books.`, '',
    `| ${cols.join(' | ')} |`, `|${cols.map(() => ' --- ').join('|')}|`,
    ...libRows(books).map((r) => `| ${r.slice(0, cols.length).map(cell).join(' | ')} |`), ''].join('\n');
}
function exportLibraryCsv(books) {
  const q = (s) => `"${String(s || '').replace(/"/g, '""')}"`;
  return [LIB_COLS, ...libRows(books)].map((r) => r.map(q).join(',')).join('\n') + '\n';
}

function totalSessions(books) { return books.reduce((n, b) => n + b.sessions.length, 0); }

const LINK_SITES = { 'bookpile.org': 'Bookpile', 'goodreads.com': 'Goodreads', 'thestorygraph.com': 'StoryGraph', 'app.thestorygraph.com': 'StoryGraph', 'openlibrary.org': 'Open Library', 'bookshop.org': 'Bookshop', 'librarything.com': 'LibraryThing' };
function linkLabel(url) {
  try { const host = new URL(url).hostname.replace(/^www\./, ''); return LINK_SITES[host] || host; } catch (e) { return 'Link'; }
}


/** Week number counted from a fixed Monday, for finding runs of consecutive weeks. */
function weekIndex(d) { return Math.floor((parseLocal(d) - new Date(2000, 0, 3)) / (7 * 86400000)); }

function longestWeekStreak(dates) {
  const weeks = [...new Set(dates.map(weekIndex))].sort((a, b) => a - b);
  let best = 0, run = 0, prev = null;
  for (const w of weeks) { run = prev !== null && w === prev + 1 ? run + 1 : 1; best = Math.max(best, run); prev = w; }
  return best;
}

/** Pull the parts of a book note the year report uses. */
function noteDetails(content) {
  const sec = (h) => { const x = getSection(content, h); return x ? x.text.trim() : ''; };
  const verdict = sec('Verdict');
  const applies = (verdict.match(/\*\*Where it applies right now:\*\*\s*(.+)/) || [])[1];
  return {
    why: getWhy(content),
    question: sec('Guiding question'),
    firstPass: sec('First pass'),
    applies: applies && applies.trim() !== '—' ? applies.trim() : '',
    chapters: parseChapters(content),
  };
}

/* --- year-in-reading report core v1 (shared by In the Margins, Brown Bag, The Stacks and Brainrot) --- */
/*
 * Each plugin builds a report object in the year-in-reading/1 shape, then calls
 * renderReportMarkdown() for the note and JSON.stringify() for the .json file.
 * The JSON is what the Year in Reading page reads.
 *
 * {
 *   schema: 'year-in-reading/1',
 *   source: { plugin, name, unit, units },          // unit: 'book' | 'fic' | 'session'
 *   year: '2026', generated: '2026-12-31', title,
 *   covers: [{ title, cover }],
 *   stats: [{ label, value }],                       // "At a glance"
 *   top: [{ label, name, count, of }],               // "Most read" (heading: topHeading)
 *   highlights: ['markdown', ...],
 *   months: { label, values: [12], secondary: { label, values: [12] } | null },
 *   sections: [{ heading, items: [item] }],
 *   tables: [{ heading, columns: [...], rows: [[...]] }],
 * }
 * item: { title, author, link, linkLabel, cover, date, meta: ['markdown'], fields: [{ label, text }],
 *         checklist: [{ text, done }], quote, tags: [] }
 */
const REPORT_SCHEMA = 'year-in-reading/1';
const REPORT_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function rMd(s) { return String(s == null ? '' : s).replace(/([*_`[\]|])/g, '\\$1'); }
function rAttr(s) { return String(s || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;'); }
function rImg(title, cover, width) {
  return cover ? `<img src="${rAttr(cover)}" alt="${rAttr(`Cover of ${title}`)}" width="${width}">` : '';
}
function rPlural(n, one, many) { return `${n} ${n === 1 ? one : (many || `${one}s`)}`; }
function rNum(n) { return typeof n === 'number' ? n.toLocaleString('en-US') : String(n == null ? '' : n); }
function rOneLine(s) { return String(s || '').replace(/\s*\n+\s*/g, ' ').trim(); }
function rDate(d) {
  if (!/^\d{4}-\d\d-\d\d$/.test(d || '')) return d || '';
  const [y, m, day] = d.split('-').map(Number);
  return new Date(y, m - 1, day).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/** Count values → [{ name, count }] sorted by count, then name. */
function rRank(values) {
  const m = new Map();
  for (const v of values) {
    if (v == null || v === '') continue;
    const key = String(v).toLowerCase();
    if (!m.has(key)) m.set(key, { name: String(v), count: 0 });
    m.get(key).count++;
  }
  return [...m.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

/** The "Most read" row for one dimension: ties share the top spot. */
function rTop(label, ranked, of) {
  if (!ranked.length) return null;
  const best = ranked.filter((x) => x.count === ranked[0].count);
  if ((ranked[0].count < 2 && of > 1) || best.length > 3) return null; // no clear favorite
  return { label, name: best.map((x) => x.name).join(', '), count: ranked[0].count, of };
}

function rMonthCounts(dates) {
  const out = new Array(12).fill(0);
  for (const d of dates) { const m = /^\d{4}-(\d\d)/.exec(d || ''); if (m) out[Number(m[1]) - 1]++; }
  return out;
}

function newReport(source, year, title) {
  return {
    schema: REPORT_SCHEMA, source, year: String(year), generated: (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; })(),
    title, covers: [], stats: [], top: [], highlights: [], months: null, sections: [], tables: [],
  };
}

function renderReportMarkdown(r) {
  const out = [`# ${r.title}`, '', `*Made ${rDate(r.generated)} from ${r.source.name}.*`, ''];
  const itemCount = r.sections.reduce((n, s) => n + s.items.length, 0);
  if (!itemCount && !r.stats.length) { out.push(`Nothing logged in ${r.year}.`, ''); return out.join('\n'); }
  const covers = r.covers.filter((c) => c.cover);
  if (covers.length) out.push(covers.map((c) => rImg(c.title, c.cover, 72)).join(' '), '');

  if (r.stats.length) {
    out.push('## At a glance', '', '| | |', '| --- | --- |', ...r.stats.map((s) => `| ${rMd(s.label)} | ${rNum(s.value)} |`), '');
  }
  const top = r.top.filter(Boolean);
  if (top.length) {
    out.push(`## ${r.topHeading || 'Most read'}`, '', `| | Top | ${r.source.units[0].toUpperCase()}${r.source.units.slice(1)} |`, '| --- | --- | --- |',
      ...top.map((t) => `| ${rMd(t.label)} | ${rMd(t.name)} | ${t.count} of ${t.of} |`), '');
  }
  if (r.highlights.length) out.push('## Highlights', '', ...r.highlights.map((h) => `- ${h}`), '');

  if (r.months && r.months.values.some(Boolean)) {
    const v = r.months.values, sec = r.months.secondary;
    const max = Math.max(...v);
    out.push('## Month by month', '', '```');
    REPORT_MONTHS.forEach((m, i) => {
      const bar = v[i] ? '█'.repeat(Math.max(1, Math.round((v[i] / max) * 24))) : '';
      const extra = sec && sec.values[i] ? `  ${rNum(sec.values[i])} ${sec.label}` : '';
      out.push(`${m.slice(0, 3)}  ${bar.padEnd(25)}${v[i] || ''}${extra}`.trimEnd());
    });
    out.push('```', `*${r.months.label}${sec ? `, with ${sec.label}` : ''}.*`, '');
  }

  for (const s of r.sections) {
    if (!s.items.length) continue;
    out.push(`## ${s.heading}`, '');
    for (const it of s.items) {
      out.push(`### ${rMd(it.title)}`, '');
      if (it.cover) out.push(rImg(it.title, it.cover, 120), '');
      const meta = [...(it.author ? [`*${rMd(it.author)}*`] : []), ...(it.meta || [])];
      if (it.link) meta.push(`[${it.linkLabel || 'Link'}](${it.link})`);
      if (meta.length) out.push(meta.join(' · '), '');
      for (const f of it.fields || []) if (f.text) out.push(`**${f.label}:** ${rOneLine(f.text)}`, '');
      if (it.checklist && it.checklist.length) out.push(...it.checklist.map((c) => `- [${c.done ? 'x' : ' '}] ${c.text}`), '');
      if (it.quote) out.push(String(it.quote).trim().split('\n').map((l) => (l ? `> ${l}` : '>')).join('\n'), '');
    }
  }
  for (const t of r.tables) {
    if (!t.rows.length) continue;
    out.push(`## ${t.heading}`, '', `| ${t.columns.join(' | ')} |`, `| ${t.columns.map(() => '---').join(' | ')} |`,
      ...t.rows.map((row) => `| ${row.map((c) => rMd(rNum(c))).join(' | ')} |`), '');
  }
  return out.join('\n');
}
/* --- end report core --- */

/**
 * Year-end report data (year-in-reading/1): every book that got an hour in the year,
 * with verdicts, ideas and chapters, plus how the practice went.
 */
function buildYearReport(books, details, year, settings) {
  const y = String(year);
  const inYear = (d) => d && d.startsWith(`${y}-`);
  details = details || {};
  const log = [];
  for (const b of books) for (const d of b.sessions) if (inYear(d)) log.push({ d, b });
  log.sort((a, b) => a.d.localeCompare(b.d) || byTitle(a.b, b.b));
  const seen = [...new Set(log.map((e) => e.b))];
  const hourMin = (settings && settings.phases ? settings.phases : DEFAULT_PHASES).reduce((n, p) => n + p.minutes, 0);
  const r = newReport({ plugin: 'brown-bag', name: 'Brown Bag', unit: 'book', units: 'books' }, y, `${y} in Brown Bag`);
  r.topHeading = 'Most common';
  if (!log.length) return r;

  r.covers = seen.filter((b) => b.cover).map((b) => ({ title: b.title, cover: b.cover }));
  const verdictCount = Object.fromEntries(VERDICTS.map(([v]) => [v, seen.filter((b) => b.verdict === v).length]));
  const allCh = seen.flatMap((b) => (details[b.path] ? details[b.path].chapters : []));
  const chDone = allCh.filter((c) => c.done).length;
  r.stats.push({ label: 'Sessions', value: log.length }, { label: 'Time spent', value: `about ${rPlural(Math.round((log.length * hourMin) / 60), 'hour')}` },
    { label: 'Books', value: seen.length });
  for (const [v, label] of VERDICTS) if (verdictCount[v]) r.stats.push({ label, value: verdictCount[v] });
  const noVerdict = seen.filter((b) => !b.verdict).length;
  if (noVerdict) r.stats.push({ label: 'No verdict yet', value: noVerdict });
  if (allCh.length) r.stats.push({ label: 'Chapters marked worth reading', value: `${allCh.length} (${chDone} read so far)` });

  r.top = [rTop('Topic', rRank(seen.flatMap((b) => b.topics)), seen.length), rTop('Verdict', rRank(seen.map((b) => VERDICT_LABEL[b.verdict])), seen.length),
    rTop('Author', rRank(seen.map((b) => b.author)), seen.length)].filter(Boolean);

  const hi = r.highlights;
  const streak = longestWeekStreak(log.map((e) => e.d));
  if (streak > 1) hi.push(`**Longest run:** ${streak} weeks in a row with a session.`);
  const months = rMonthCounts(log.map((e) => e.d));
  const peak = Math.max(...months);
  if (peak > 1) hi.push(`**Busiest month:** ${REPORT_MONTHS.filter((_, i) => months[i] === peak).join(' and ')}, with ${peak} sessions.`);
  const repeats = seen.filter((b) => b.sessions.filter(inYear).length > 1);
  if (repeats.length) hi.push(`**Worth a second hour:** ${repeats.map((b) => `*${rMd(b.title)}*`).join(', ')}.`);
  const kept = verdictCount['read deeper'] + verdictCount.reference;
  const decided = seen.filter((b) => b.verdict).length;
  if (decided) hi.push(`**Kept vs. let go:** ${kept} of ${decided} books earned a place (read deeper or reference), and ${verdictCount['let it go']} ${verdictCount['let it go'] === 1 ? 'was' : 'were'} let go.`);
  const sorted = books.filter((b) => b.status === 'skimmed').length;
  const left = books.length - sorted;
  if (books.length) hi.push(`**The library so far:** ${sorted} of ${books.length} books sorted (${Math.round((sorted / books.length) * 100)}%).${left > 0 ? ` At one a week, the rest would take about ${left < 52 ? rPlural(left, 'more week') : rPlural(Math.round(left / 52), 'year')}.` : ''}`);

  r.months = { label: 'Sessions', values: months, secondary: null };
  const item = (b) => {
    const dt = details[b.path] || {};
    const sess = b.sessions.filter(inYear);
    return {
      title: b.title, author: b.author, cover: b.cover, date: sess[sess.length - 1],
      link: b.link, linkLabel: b.link ? linkLabel(b.link) : '',
      meta: [sess.length > 1 ? `${sess.length} sessions: ${sess.map(rDate).join(', ')}` : rDate(sess[0]), b.topics.join(', ')].filter(Boolean),
      fields: [{ label: 'Why I picked it up', text: dt.why }, { label: 'Guiding question', text: dt.question },
        { label: "What it's arguing", text: dt.firstPass }, { label: 'The one idea worth keeping', text: b.idea },
        { label: 'Where it applies', text: dt.applies }].filter((f) => f.text),
      checklist: (dt.chapters || []).map((c) => ({ text: c.text, done: c.done })),
      tags: [VERDICT_LABEL[b.verdict] || 'No verdict yet', ...b.topics],
    };
  };
  r.sections = [...VERDICTS, ['', 'No verdict yet']].map(([v, label]) => ({ heading: label, items: seen.filter((b) => b.verdict === v).sort(byTitle).map(item) }));
  r.tables.push({ heading: 'Every hour', columns: ['Date', 'Book', 'Verdict'], rows: log.map((e) => [rDate(e.d), e.b.title, VERDICT_LABEL[e.b.verdict] || '']) });
  r.tables.push({ heading: 'By topic', columns: ['Topic', 'Books'], rows: rRank(seen.flatMap((b) => b.topics)).map((t) => [t.name, t.count]) });
  return r;
}

function exportYearReport(books, details, year, settings) { return renderReportMarkdown(buildYearReport(books, details, year, settings)); }

/* ------------------------------------------------------------------ */
/* Plugin                                                             */
/* ------------------------------------------------------------------ */

class BrownBagPlugin extends Plugin {
  async onload() {
    await this.loadSettings();
    this.registerView(VIEW_TYPE, (leaf) => new BagView(leaf, this));
    this.addRibbonIcon('coffee', 'Open Brown Bag', () => this.activateView());
    this.registerMarkdownCodeBlockProcessor('brown-bag', (source, el, ctx) => ctx.addChild(new BagBlock(el, this, source, ctx.sourcePath)));
    this.registerObsidianProtocolHandler('brown-bag', () => this.activateView());

    this.addCommand({ id: 'open', name: 'Open this week', callback: () => this.activateView() });
    this.addCommand({ id: 'add-book', name: 'Add a book to the library', callback: () => new AddBookModal(this).open() });
    this.addCommand({ id: 'skim-current', name: 'Skim this book this week', checkCallback: (c) => this.withCurrentBook(c, (b) => this.setThisWeek(b)) });
    this.addCommand({ id: 'deck-current', name: 'Put this book on deck', checkCallback: (c) => this.withCurrentBook(c, (b) => this.putOnDeck(b)) });
    this.addCommand({ id: 'start-current', name: 'Start the hour with this book', checkCallback: (c) => this.withCurrentBook(c, (b) => this.startSession(b)) });
    this.addCommand({ id: 'verdict-current', name: 'Record a verdict for this book', checkCallback: (c) => this.withCurrentBook(c, (b) => new VerdictModal(this, b).open()) });
    this.addCommand({ id: 'why-current', name: 'Why this book', checkCallback: (c) => this.withCurrentBook(c, (b) => new WhyModal(this, b).open()) });
    this.addCommand({ id: 'cover-current', name: 'Find a cover for this book', checkCallback: (c) => this.withCurrentBook(c, (b) => new CoverModal(this, b).open()) });
    this.addCommand({ id: 'find-covers', name: 'Find covers for every book that has none', callback: () => this.findMissingCovers() });
    this.addCommand({ id: 'export-notes', name: 'Export: skim notes since last export', callback: () => this.runExport('notes') });
    this.addCommand({ id: 'export-chapters', name: 'Export: chapters to read', callback: () => this.runExport('chapters') });
    this.addCommand({ id: 'export-year', name: 'Year-end report', callback: () => this.runExport('year') });
    this.addCommand({ id: 'export-library', name: 'Export: library (markdown + CSV)', callback: () => this.runExport('library') });
    this.addCommand({ id: 'retro', name: 'Start a retro', callback: () => this.startRetro() });

    this.addSettingTab(new BagSettingTab(this.app, this));
    this.app.workspace.onLayoutReady(() => { if (this.settings.openOnStartup) this.activateView(); });
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    const ph = Array.isArray(this.settings.phases) && this.settings.phases.length ? this.settings.phases : DEFAULT_PHASES;
    this.settings.phases = ph.map((x) => ({ ...x }));
    if (!Array.isArray(this.settings.exportedKeys)) this.settings.exportedKeys = [];
  }
  async saveSettings() { await this.saveData(this.settings); }

  /* ---------- data ---------- */

  inFolder(path, folder) { const f = normalizePath(folder || ''); return !f || f === '/' || path.startsWith(`${f}/`); }

  readBook(file) {
    const book = bookFromFrontmatter(file.path, file.basename, this.app.metadataCache.getFileCache(file)?.frontmatter);
    book.file = file;
    return book;
  }
  getBooks() {
    return this.app.vault.getMarkdownFiles().filter((f) => this.inFolder(f.path, this.settings.booksFolder)).map((f) => this.readBook(f));
  }
  getBook(path) {
    const f = this.app.vault.getAbstractFileByPath(path);
    return f instanceof TFile && this.inFolder(f.path, this.settings.booksFolder) ? this.readBook(f) : null;
  }
  getTopicPaths() {
    const out = {};
    for (const f of this.app.vault.getMarkdownFiles()) if (this.inFolder(f.path, this.settings.topicsFolder)) out[f.basename] = f.path;
    return out;
  }
  getTopicNames() {
    const set = new Set(Object.keys(this.getTopicPaths()));
    for (const b of this.getBooks()) b.topics.forEach((t) => set.add(t));
    return [...set].sort((a, b) => a.localeCompare(b));
  }

  async readChapters(books) {
    const out = [];
    for (const b of books) {
      if (b.status === 'shelf') continue;
      const chapters = parseChapters(await this.app.vault.cachedRead(b.file));
      if (chapters.length) out.push({ book: b, chapters });
    }
    return out;
  }

  async ensureFolder(path) { const p = normalizePath(path); if (!this.app.vault.getAbstractFileByPath(p)) await this.app.vault.createFolder(p); }
  async ensureTopicNote(name) {
    name = safeFileName(name);
    const path = normalizePath(`${this.settings.topicsFolder}/${name}.md`);
    if (!this.app.vault.getAbstractFileByPath(path)) { await this.ensureFolder(this.settings.topicsFolder); await this.app.vault.create(path, buildTopicNote()); }
    return name;
  }
  async writeFile(path, content) {
    path = normalizePath(path);
    const f = this.app.vault.getAbstractFileByPath(path);
    if (f instanceof TFile) { await this.app.vault.modify(f, content); return f; }
    return this.app.vault.create(path, content);
  }
  async openFile(file) { await this.app.workspace.getLeaf('tab').openFile(file); }
  openBook(book, sourcePath) { this.app.workspace.openLinkText(book.path, sourcePath || '', 'tab'); }

  withCurrentBook(checking, fn) {
    const file = this.app.workspace.getActiveFile();
    const book = file && this.getBook(file.path);
    if (!book) return false;
    if (!checking) fn(book);
    return true;
  }

  /* ---------- actions ---------- */

  async setStatus(book, status, extra) {
    await this.app.fileManager.processFrontMatter(book.file, (fm) => { fm.status = status; if (extra) extra(fm); });
  }

  async putOnDeck(book) {
    await this.setStatus(book, 'on deck', (fm) => { fm.decked = todayStr(); });
    new Notice(`${book.title} is on deck`);
  }

  async backToShelf(book) {
    await this.setStatus(book, 'shelf', (fm) => { fm.decked = null; });
  }

  async setThisWeek(book) {
    for (const other of this.getBooks()) {
      if (other.status === 'skimming' && other.path !== book.path) {
        await this.setStatus(other, 'on deck', (fm) => { if (!fm.decked) fm.decked = todayStr(); });
        new Notice(`${other.title} went back on deck`);
      }
    }
    await this.setStatus(book, 'skimming');
    new Notice(`This week: ${book.title}`);
    if (!(await this.readWhy(book))) new WhyModal(this, book).open();
  }

  async readWhy(book) { return getWhy(await this.app.vault.cachedRead(book.file)); }

  async saveWhy(book, why, question) {
    await this.app.vault.process(book.file, (data) => {
      let out = setWhy(data, why);
      if (question != null) out = setSection(out, 'Guiding question', question);
      return out;
    });
  }

  async startSession(book) {
    if (book.status !== 'skimming') await this.setThisWeek(book);
    const date = todayStr();
    await this.app.fileManager.processFrontMatter(book.file, (fm) => {
      const list = dateList(fm.sessions);
      if (!list.includes(date)) list.push(date);
      fm.sessions = list;
    });
    this.settings.session = { path: book.path, startedAt: Date.now(), pausedAt: null, pausedMs: 0, notified: 0 };
    await this.saveSettings();
    await this.activateView();
    this.app.workspace.getLeavesOfType(VIEW_TYPE).forEach((l) => l.view && l.view.renderNow && (l.view.tab = 'week', l.view.renderNow()));
  }

  async pauseSession() {
    const s = this.settings.session; if (!s) return;
    if (s.pausedAt) { s.pausedMs += Date.now() - s.pausedAt; s.pausedAt = null; } else s.pausedAt = Date.now();
    await this.saveSettings();
  }

  async skipPhase() {
    const s = this.settings.session; if (!s) return;
    const st = sessionState(s, this.settings.phases, Date.now());
    if (!st.done) s.startedAt -= st.phaseLeftMs;
    await this.saveSettings();
  }

  async endSession(openVerdict) {
    const s = this.settings.session;
    this.settings.session = null;
    await this.saveSettings();
    const book = s && this.getBook(s.path);
    if (openVerdict && book) new VerdictModal(this, book).open();
  }

  async recordVerdict(book, { verdict, idea, applies, link }) {
    const date = todayStr();
    await this.app.fileManager.processFrontMatter(book.file, (fm) => {
      fm.status = 'skimmed';
      fm.verdict = verdict;
      fm.idea = idea.trim().replace(/\s*\n+\s*/g, ' ');
      fm.skimmed = date;
      if (link) fm.link = link;
      const list = dateList(fm.sessions);
      if (!list.length) fm.sessions = [date];
    });
    await this.app.vault.process(book.file, (data) => setSection(data, 'Verdict', verdictBody({ verdict, idea, applies, date })));
    new Notice(`${book.title}: ${VERDICT_LABEL[verdict].toLowerCase()}`);
  }

  async reopenBook(book) {
    await this.setStatus(book, 'on deck', (fm) => { fm.decked = todayStr(); });
  }

  async createBook(data) {
    await this.ensureFolder(this.settings.booksFolder);
    for (const t of data.topics) await this.ensureTopicNote(t);
    const base = safeFileName(data.title);
    let path = normalizePath(`${this.settings.booksFolder}/${base}.md`);
    for (let i = 2; this.app.vault.getAbstractFileByPath(path); i++) path = normalizePath(`${this.settings.booksFolder}/${base} (${i}).md`);
    return this.app.vault.create(path, buildBookNote(data));
  }

  async toggleChapter(book, ch, done) {
    await this.app.vault.process(book.file, (data) => toggleChapterLine(data, ch.line, ch.text, done));
  }

  async renameTopic(oldName, newName) {
    newName = safeFileName(newName);
    if (!newName || newName === oldName) return;
    const paths = this.getTopicPaths();
    if (paths[newName]) { new Notice(`There's already a topic called ${newName}`); return; }
    const file = paths[oldName] && this.app.vault.getAbstractFileByPath(paths[oldName]);
    if (file) await this.app.fileManager.renameFile(file, normalizePath(`${this.settings.topicsFolder}/${newName}.md`));
    for (const b of this.getBooks()) {
      if (!b.topics.includes(oldName)) continue;
      await this.app.fileManager.processFrontMatter(b.file, (fm) => { fm.topics = toList(fm.topics).map((t) => (t === oldName ? newName : t)).map((t) => `[[${t}]]`); });
    }
  }

  async deleteTopic(name) {
    for (const b of this.getBooks()) {
      if (!b.topics.includes(name)) continue;
      await this.app.fileManager.processFrontMatter(b.file, (fm) => { fm.topics = toList(fm.topics).filter((t) => t !== name).map((t) => `[[${t}]]`); });
    }
    const p = this.getTopicPaths()[name];
    const file = p && this.app.vault.getAbstractFileByPath(p);
    if (file) await this.app.vault.trash(file, false);
  }

  async startRetro() {
    const n = totalSessions(this.getBooks());
    await this.ensureFolder(this.settings.retrosFolder);
    const f = await this.writeFile(`${this.settings.retrosFolder}/${todayStr()} Retro.md`, buildRetroNote(todayStr(), n));
    this.settings.lastRetroAt = n;
    await this.saveSettings();
    this.openFile(f);
  }

  async runExport(kind) {
    const books = this.getBooks();
    const today = todayStr();
    const folder = this.settings.exportsFolder;
    await this.ensureFolder(folder);
    if (kind === 'notes') {
      const applies = {};
      for (const b of books) {
        if (b.status !== 'skimmed') continue;
        const sec = getSection(await this.app.vault.cachedRead(b.file), 'Verdict');
        const m = sec && sec.text.match(/\*\*Where it applies right now:\*\*\s*(.+)/);
        if (m && m[1].trim() !== '—') applies[b.path] = m[1].trim();
      }
      const res = exportSkimNotes(books, applies, this.settings, today);
      if (!res) { new Notice('Nothing new skimmed since the last export'); return; }
      const f = await this.writeFile(`${folder}/${today} Brown Bag notes.md`, res.markdown);
      this.settings.lastExportDate = today;
      this.settings.exportedKeys = [...new Set([...this.settings.exportedKeys, ...res.keys])];
      await this.saveSettings();
      return this.openFile(f);
    }
    if (kind === 'chapters') {
      const f = await this.writeFile(`${folder}/${today} Chapters to read.md`, exportChapters(await this.readChapters(books), today));
      return this.openFile(f);
    }
    if (kind === 'year') {
      return new PromptModal(this.app, 'Which year?', String(new Date().getFullYear()), async (year) => {
        year = String(year).trim();
        if (!/^\d{4}$/.test(year)) { new Notice('Enter a four-digit year'); return; }
        const details = {};
        for (const b of books) if (b.sessions.some((d) => d.startsWith(year))) details[b.path] = noteDetails(await this.app.vault.cachedRead(b.file));
        const report = buildYearReport(books, details, year, this.settings);
        const f = await this.writeFile(`${folder}/${year} in Brown Bag.md`, renderReportMarkdown(report));
        await this.writeFile(`${folder}/${year} in Brown Bag.json`, JSON.stringify(report, null, 2));
        this.openFile(f);
      }).open();
    }
    if (kind === 'library') {
      const f = await this.writeFile(`${folder}/${today} Library.md`, exportLibraryMarkdown(books, today));
      await this.writeFile(`${folder}/${today} Library.csv`, exportLibraryCsv(books));
      new Notice('Exported the library (markdown and CSV)');
      return this.openFile(f);
    }
  }

  async findMissingCovers() {
    if (this.coverJob) { new Notice('Already looking for covers'); return; }
    const todo = this.getBooks().filter((b) => !b.cover);
    if (!todo.length) { new Notice('Every book has a cover'); return; }
    this.coverJob = true;
    const note = new Notice(`Looking for ${todo.length} covers…`, 0);
    let found = 0;
    try {
      for (let i = 0; i < todo.length; i++) {
        const b = todo[i];
        note.setMessage(`Looking for covers… ${i + 1} of ${todo.length} (${found} found)`);
        try {
          const res = await searchOpenLibrary(b.title, b.author.split(/;|,/)[0].trim(), 1);
          if (res.length) {
            await this.app.fileManager.processFrontMatter(b.file, (fm) => { if (!fm.cover) fm.cover = res[0].cover; });
            found++;
          }
        } catch (e) { /* skip this one */ }
        await new Promise((r) => window.setTimeout(r, 350));
      }
    } finally {
      this.coverJob = false;
      note.hide();
    }
    new Notice(`Found ${found} of ${todo.length} covers. Fix any wrong ones with "Find a cover for this book".`);
  }

  async activateView() {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) { leaf = workspace.getLeaf('tab'); await leaf.setViewState({ type: VIEW_TYPE, active: true }); }
    await workspace.revealLeaf(leaf);
  }
}

/* ------------------------------------------------------------------ */
/* Rendering bits                                                     */
/* ------------------------------------------------------------------ */

function renderCover(parent, book, cls) {
  const wrap = parent.createDiv({ cls: `bb-cover ${cls || ''}` });
  const blank = () => { wrap.empty(); wrap.addClass('bb-cover-blank'); wrap.createDiv({ cls: 'bb-cover-title', text: book.title }); };
  if (book.cover) wrap.createEl('img', { attr: { src: book.cover, alt: '', loading: 'lazy' } }).addEventListener('error', blank);
  else blank();
  return wrap;
}

function chip(parent, text, cls) { return parent.createSpan({ cls: `bb-chip ${cls || ''}`, text }); }

function beep() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const ctx = new Ctx();
    [0, 0.25].forEach((t) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.frequency.value = 660; o.connect(g); g.connect(ctx.destination);
      g.gain.setValueAtTime(0.0001, ctx.currentTime + t);
      g.gain.exponentialRampToValueAtTime(0.2, ctx.currentTime + t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + t + 0.2);
      o.start(ctx.currentTime + t); o.stop(ctx.currentTime + t + 0.22);
    });
    window.setTimeout(() => ctx.close(), 800);
  } catch (e) { /* no audio */ }
}

/* ------------------------------------------------------------------ */
/* Main view                                                          */
/* ------------------------------------------------------------------ */

class BagView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.tab = 'week';
    this.topic = null;
    this.query = '';
    this.shelfFilter = 'all';
    this.suggestion = null;
    this.render = debounce(() => this.renderNow(), 150, true);
  }
  getViewType() { return VIEW_TYPE; }
  getDisplayText() { return 'Brown Bag'; }
  getIcon() { return 'coffee'; }

  async onOpen() {
    this.registerEvent(this.app.metadataCache.on('changed', () => this.render()));
    this.registerEvent(this.app.vault.on('delete', () => this.render()));
    this.registerEvent(this.app.vault.on('rename', () => this.render()));
    this.registerInterval(window.setInterval(() => this.tick(), 1000));
    this.renderNow();
  }

  tick() {
    const s = this.plugin.settings.session;
    if (!s || !this.timerEls) return;
    const phases = this.plugin.settings.phases;
    const st = sessionState(s, phases, Date.now());
    if (st.phaseIndex !== this.timerEls.phaseIndex || st.done !== this.timerEls.done) {
      if (!s.pausedAt) {
        if (st.done && !s.doneNotified) { s.doneNotified = true; beep(); new Notice('Time. Record your verdict.'); }
        else if (!st.done && st.phaseIndex > (s.notified || 0)) { s.notified = st.phaseIndex; beep(); new Notice(`Next: ${phases[st.phaseIndex].name}`); }
        this.plugin.saveSettings();
      }
      this.renderNow();
      return;
    }
    this.timerEls.clock.setText(st.done ? '0:00' : fmtMs(st.phaseLeftMs));
    this.timerEls.total.setText(`${fmtMs(st.totalLeftMs)} left in the hour`);
    const totalMs = phases.reduce((n, p) => n + p.minutes * 60000, 0);
    this.timerEls.bar.setCssProps({ '--bb-progress': `${Math.min(100, (st.elapsed / totalMs) * 100)}%` });
  }

  renderNow() {
    const c = this.contentEl;
    const scroll = c.scrollTop;
    c.empty();
    c.addClass('bb-view');
    this.timerEls = null;
    const books = this.plugin.getBooks();

    const head = c.createDiv({ cls: 'bb-head' });
    const t = head.createDiv();
    t.createEl('h2', { text: 'Brown Bag' });
    const skimmed = books.filter((b) => b.status === 'skimmed').length;
    t.createDiv({ cls: 'bb-summary', text: `${skimmed} of ${books.length} skimmed · ${totalSessions(books)} sessions` });
    const actions = head.createDiv({ cls: 'bb-head-actions' });
    const add = actions.createEl('button', { text: 'Add book' });
    add.addEventListener('click', () => new AddBookModal(this.plugin).open());
    const exp = actions.createEl('button', { attr: { 'aria-label': 'Export' } });
    setIcon(exp, 'share');
    exp.addEventListener('click', (evt) => {
      const m = new Menu();
      m.addItem((i) => i.setTitle('Skim notes since last export').setIcon('notebook-pen').onClick(() => this.plugin.runExport('notes')));
      m.addItem((i) => i.setTitle('Chapters to read').setIcon('list-checks').onClick(() => this.plugin.runExport('chapters')));
      m.addItem((i) => i.setTitle('Year-end report').setIcon('calendar').onClick(() => this.plugin.runExport('year')));
      m.addItem((i) => i.setTitle('Library (markdown + CSV)').setIcon('table').onClick(() => this.plugin.runExport('library')));
      m.showAtMouseEvent(evt);
    });

    const tabs = c.createDiv({ cls: 'bb-tabs' });
    const count = (st) => books.filter((b) => b.status === st).length;
    for (const [key, label] of [['week', 'This week'], ['shelf', `Shelf ${count('shelf') + count('on deck')}`], ['skimmed', `Skimmed ${skimmed}`], ['chapters', 'Chapters'], ['topics', 'Topics']]) {
      const b = tabs.createEl('button', { cls: `bb-tab ${this.tab === key ? 'is-active' : ''}`, text: label });
      b.addEventListener('click', () => { this.tab = key; this.renderNow(); });
    }

    if (this.tab === 'week') this.renderWeek(c, books);
    else if (this.tab === 'shelf') this.renderShelf(c, books);
    else if (this.tab === 'skimmed') this.renderSkimmed(c, books);
    else if (this.tab === 'chapters') this.renderChapters(c, books);
    else this.renderTopics(c, books);
    c.scrollTop = scroll;
  }

  /* ----- This week ----- */
  renderWeek(c, books) {
    const p = this.plugin, s = p.settings;
    const n = totalSessions(books);
    if (s.retroEvery > 0 && n - (s.lastRetroAt || 0) >= s.retroEvery) {
      const banner = c.createDiv({ cls: 'bb-banner' });
      banner.createSpan({ text: `${n - (s.lastRetroAt || 0)} sessions since your last retro. Time to look back?` });
      const b = banner.createEl('button', { cls: 'mod-cta', text: 'Start a retro' });
      b.addEventListener('click', () => p.startRetro());
    }

    const session = s.session;
    const current = session ? p.getBook(session.path) : books.find((b) => b.status === 'skimming');
    if (session && !current) { p.endSession(false); }

    if (session && current) this.renderTimer(c, current);
    else if (current) this.renderThisWeek(c, current);
    else this.renderPicker(c, books);

    // On deck
    const deck = books.filter((b) => b.status === 'on deck').sort((a, b) => (a.decked || '').localeCompare(b.decked || '') || byTitle(a, b));
    const box = c.createDiv({ cls: 'bb-section' });
    box.createDiv({ cls: 'bb-label', text: current ? 'Up next' : 'On deck' });
    if (!deck.length) box.createDiv({ cls: 'bb-empty', text: 'Nothing on deck. Pick next week\'s book from the Shelf tab so the hour starts with reading, not choosing.' });
    for (const b of deck) {
      const row = this.row(box, b);
      const acts = row.createDiv({ cls: 'bb-row-actions' });
      if (!current) {
        const go = acts.createEl('button', { cls: 'mod-cta', text: 'Skim this week' });
        go.addEventListener('click', () => p.setThisWeek(b));
      }
      const off = acts.createEl('button', { attr: { 'aria-label': 'Back to the shelf' } });
      setIcon(off, 'x');
      off.addEventListener('click', () => p.backToShelf(b));
    }

    // Recent sessions
    const recent = books.flatMap((b) => b.sessions.map((d) => ({ d, b }))).sort((a, b) => b.d.localeCompare(a.d)).slice(0, 8);
    if (recent.length) {
      const r = c.createDiv({ cls: 'bb-section' });
      r.createDiv({ cls: 'bb-label', text: 'Recent sessions' });
      for (const { d, b } of recent) {
        const row = r.createDiv({ cls: 'bb-log' });
        row.createSpan({ cls: 'bb-log-date', text: shortDate(d) });
        const a = row.createEl('a', { text: b.title, href: '#' });
        a.addEventListener('click', (e) => { e.preventDefault(); p.openBook(b); });
        if (b.verdict) chip(row, VERDICT_LABEL[b.verdict], `bb-v-${b.verdict.replace(/\s+/g, '-')}`);
      }
    }
  }

  renderThisWeek(c, book) {
    const p = this.plugin;
    const card = c.createDiv({ cls: 'bb-week' });
    renderCover(card, book, 'bb-cover-md').addEventListener('click', () => p.openBook(book));
    const body = card.createDiv({ cls: 'bb-week-body' });
    body.createDiv({ cls: 'bb-label', text: 'This week' });
    const a = body.createEl('a', { cls: 'bb-title bb-title-lg', text: book.title, href: '#' });
    a.addEventListener('click', (e) => { e.preventDefault(); p.openBook(book); });
    if (book.author) body.createDiv({ cls: 'bb-author', text: book.author });
    if (book.sessions.length) body.createDiv({ cls: 'bb-muted', text: `${book.sessions.length} ${book.sessions.length === 1 ? 'session' : 'sessions'} so far` });
    const whyEl = body.createDiv({ cls: 'bb-why' });
    const q = body.createDiv({ cls: 'bb-question' });
    p.app.vault.cachedRead(book.file).then((txt) => {
      const why = getWhy(txt);
      if (why) whyEl.setText(why); else whyEl.remove();
      const sec = getSection(txt, 'Guiding question');
      const text = sec && sec.text.trim();
      q.setText(text ? `Reading against: ${text}` : 'No guiding question this time. Add one under "Guiding question" in the book note if something is on your mind.');
      if (!text) q.addClass('bb-muted');
    });
    const acts = body.createDiv({ cls: 'bb-actions' });
    const start = acts.createEl('button', { cls: 'mod-cta bb-big', text: 'Start the hour' });
    start.addEventListener('click', () => p.startSession(book));
    const v = acts.createEl('button', { text: 'Record verdict' });
    v.addEventListener('click', () => new VerdictModal(p, book).open());
    const back = acts.createEl('button', { text: 'Not this week' });
    back.addEventListener('click', () => p.setStatus(book, 'on deck', (fm) => { if (!fm.decked) fm.decked = todayStr(); }));
  }

  renderTimer(c, book) {
    const p = this.plugin, s = p.settings.session, phases = p.settings.phases;
    const st = sessionState(s, phases, Date.now());
    const box = c.createDiv({ cls: `bb-timer ${s.pausedAt ? 'is-paused' : ''}` });
    const top = box.createDiv({ cls: 'bb-timer-top' });
    renderCover(top, book, 'bb-cover-sm');
    const tt = top.createDiv();
    const a = tt.createEl('a', { cls: 'bb-title', text: book.title, href: '#' });
    a.addEventListener('click', (e) => { e.preventDefault(); p.openBook(book); });
    const total = tt.createDiv({ cls: 'bb-muted' });

    const steps = box.createDiv({ cls: 'bb-steps' });
    phases.forEach((ph, i) => {
      const step = steps.createDiv({ cls: `bb-step ${i < st.phaseIndex || st.done ? 'is-done' : ''} ${i === st.phaseIndex && !st.done ? 'is-now' : ''}` });
      step.createDiv({ cls: 'bb-step-name', text: ph.name });
      step.createDiv({ cls: 'bb-step-min', text: `${ph.minutes} min` });
    });

    const clock = box.createDiv({ cls: 'bb-clock' });
    const prompt = box.createDiv({ cls: 'bb-prompt' });
    if (st.done) prompt.setText('That\'s the hour. Finish your wrap-up, then record the verdict.');
    else prompt.setText(phases[st.phaseIndex].prompt);
    if (s.pausedAt) box.createDiv({ cls: 'bb-paused', text: 'Paused' });
    const barWrap = box.createDiv({ cls: 'bb-bar' });
    const bar = barWrap.createDiv({ cls: 'bb-bar-fill' });

    const acts = box.createDiv({ cls: 'bb-actions' });
    if (st.done) {
      const v = acts.createEl('button', { cls: 'mod-cta bb-big', text: 'Record verdict' });
      v.addEventListener('click', () => p.endSession(true).then(() => this.renderNow()));
    } else {
      const pause = acts.createEl('button', { text: s.pausedAt ? 'Resume' : 'Pause' });
      pause.addEventListener('click', async () => { await p.pauseSession(); this.renderNow(); });
      const next = acts.createEl('button', { text: st.phaseIndex === phases.length - 1 ? 'Finish' : 'Next phase' });
      next.addEventListener('click', async () => { await p.skipPhase(); this.renderNow(); });
      const notes = acts.createEl('button', { text: 'Open notes' });
      notes.addEventListener('click', () => p.openBook(book));
    }
    const stop = acts.createEl('button', { cls: 'bb-quiet', text: st.done ? 'Not now' : 'End early' });
    stop.addEventListener('click', async () => { await p.endSession(!st.done); this.renderNow(); });

    this.timerEls = { clock, total, bar, phaseIndex: st.phaseIndex, done: st.done };
    this.tick();
  }

  renderPicker(c, books) {
    const p = this.plugin;
    const box = c.createDiv({ cls: 'bb-week bb-pick' });
    const body = box.createDiv({ cls: 'bb-week-body' });
    body.createDiv({ cls: 'bb-label', text: 'This week' });
    body.createDiv({ cls: 'bb-title bb-title-lg', text: 'Pick this week\'s book' });
    body.createDiv({ cls: 'bb-muted', text: 'Take one from On deck below, or let the shelf suggest one.' });

    const shelf = books.filter((b) => b.status === 'shelf');
    const topics = [...new Set(shelf.flatMap((b) => b.topics))].sort((a, b) => a.localeCompare(b));
    const pool = () => shelf.filter((b) => !this.topic || b.topics.includes(this.topic));
    const sel = body.createEl('select', { cls: 'dropdown' });
    sel.createEl('option', { value: '', text: 'Any topic' });
    for (const t of topics) sel.createEl('option', { value: t, text: t });
    sel.value = this.topic || '';
    sel.addEventListener('change', () => { this.topic = sel.value || null; this.suggestion = null; this.renderNow(); });

    const acts = body.createDiv({ cls: 'bb-actions' });
    const sug = acts.createEl('button', { text: this.suggestion ? 'Suggest another' : 'Suggest one' });
    sug.addEventListener('click', () => {
      const list = pool().filter((b) => !this.suggestion || b.path !== this.suggestion);
      if (!list.length) { new Notice('Nothing on the shelf for that topic'); return; }
      this.suggestion = list[Math.floor(Math.random() * list.length)].path;
      this.renderNow();
    });

    const picked = this.suggestion && p.getBook(this.suggestion);
    if (picked && picked.status === 'shelf') {
      const row = this.row(body, picked);
      const ra = row.createDiv({ cls: 'bb-row-actions' });
      const go = ra.createEl('button', { cls: 'mod-cta', text: 'Skim this week' });
      go.addEventListener('click', () => { this.suggestion = null; p.setThisWeek(picked); });
      const deck = ra.createEl('button', { text: 'On deck' });
      deck.addEventListener('click', () => { this.suggestion = null; p.putOnDeck(picked); });
    }
  }

  row(parent, b) {
    const row = parent.createDiv({ cls: 'bb-row' });
    renderCover(row, b, 'bb-cover-xs').addEventListener('click', () => this.plugin.openBook(b));
    const body = row.createDiv({ cls: 'bb-row-body' });
    const a = body.createEl('a', { cls: 'bb-title', text: b.title, href: '#' });
    a.addEventListener('click', (e) => { e.preventDefault(); this.plugin.openBook(b); });
    const sub = [b.author, b.topics.join(', ')].filter(Boolean).join(' · ');
    if (sub) body.createDiv({ cls: 'bb-author', text: sub });
    row.bodyEl = body;
    return row;
  }

  /* ----- Shelf ----- */
  renderShelf(c, books) {
    const p = this.plugin;
    const bar = c.createDiv({ cls: 'bb-filterbar' });
    const search = bar.createEl('input', { type: 'search', attr: { placeholder: 'Search title or author' } });
    search.value = this.query;
    const status = bar.createEl('select', { cls: 'dropdown' });
    for (const [v, l] of [['all', 'Shelf + on deck'], ['shelf', 'On the shelf'], ['on deck', 'On deck'], ['everything', 'Everything']]) status.createEl('option', { value: v, text: l });
    status.value = this.shelfFilter;
    status.addEventListener('change', () => { this.shelfFilter = status.value; this.renderNow(); });
    const covers = bar.createEl('button', { attr: { 'aria-label': 'Find missing covers' } });
    setIcon(covers, 'image-down');
    covers.addEventListener('click', () => p.findMissingCovers());

    const scope = books.filter((b) => this.shelfFilter === 'everything' || (this.shelfFilter === 'all' ? (b.status === 'shelf' || b.status === 'on deck') : b.status === this.shelfFilter));
    const topics = [...new Set(scope.flatMap((b) => b.topics))].sort((a, b) => a.localeCompare(b));
    if (this.topic && !topics.includes(this.topic)) this.topic = null;
    const chips = c.createDiv({ cls: 'bb-chips' });
    const mk = (label, val) => {
      const n = val ? scope.filter((b) => b.topics.includes(val)).length : scope.length;
      const b = chips.createEl('button', { cls: `bb-chip ${this.topic === val ? 'is-active' : ''}`, text: `${label} ${n}` });
      b.addEventListener('click', () => { this.topic = val; this.renderNow(); });
    };
    mk('All', null);
    topics.forEach((t) => mk(t, t));

    const list = c.createDiv({ cls: 'bb-list' });
    const draw = () => {
      list.empty();
      const q = this.query.toLowerCase();
      const shown = scope.filter((b) => (!this.topic || b.topics.includes(this.topic)) && (!q || b.title.toLowerCase().includes(q) || b.author.toLowerCase().includes(q))).sort(byTitle);
      if (!shown.length) { list.createDiv({ cls: 'bb-empty', text: 'No books match.' }); return; }
      for (const b of shown) {
        const row = this.row(list, b);
        const acts = row.createDiv({ cls: 'bb-row-actions' });
        if (b.status === 'on deck') chip(acts, 'On deck', 'bb-chip-deck');
        if (b.status === 'skimming') chip(acts, 'This week', 'bb-chip-deck');
        if (b.status === 'skimmed') chip(acts, VERDICT_LABEL[b.verdict] || 'Skimmed');
        if (b.status === 'shelf') {
          const d = acts.createEl('button', { text: 'On deck' });
          d.addEventListener('click', () => p.putOnDeck(b));
        }
        if (b.status === 'shelf' || b.status === 'on deck') {
          const w = acts.createEl('button', { attr: { 'aria-label': 'Skim this week' } });
          setIcon(w, 'coffee');
          w.addEventListener('click', () => p.setThisWeek(b));
        }
      }
    };
    search.addEventListener('input', () => { this.query = search.value; draw(); });
    draw();
  }

  /* ----- Skimmed ----- */
  renderSkimmed(c, books) {
    const p = this.plugin;
    const done = books.filter((b) => b.status === 'skimmed');
    if (!done.length) { c.createDiv({ cls: 'bb-empty', text: 'Nothing skimmed yet. Your verdicts will collect here.' }); return; }
    for (const [v, label] of [...VERDICTS, ['', 'No verdict']]) {
      const list = done.filter((b) => b.verdict === v).sort((a, b) => (b.skimmed || '').localeCompare(a.skimmed || ''));
      if (!list.length) continue;
      const sec = c.createDiv({ cls: 'bb-section' });
      sec.createDiv({ cls: 'bb-label', text: `${label} · ${list.length}` });
      for (const b of list) {
        const row = this.row(sec, b);
        if (b.idea) row.bodyEl.createDiv({ cls: 'bb-idea', text: b.idea });
        const acts = row.createDiv({ cls: 'bb-row-actions' });
        if (b.skimmed) acts.createSpan({ cls: 'bb-muted', text: shortDate(b.skimmed) });
        const again = acts.createEl('button', { attr: { 'aria-label': 'Put back on deck for another session' } });
        setIcon(again, 'rotate-ccw');
        again.addEventListener('click', () => p.reopenBook(b));
      }
    }
  }

  /* ----- Chapters ----- */
  renderChapters(c, books) {
    const p = this.plugin;
    const wrap = c.createDiv({ cls: 'bb-section' });
    wrap.createDiv({ cls: 'bb-muted', text: 'Chapters you marked as worth reading, across every book you\'ve skimmed. Check one off when you\'ve read it.' });
    const list = c.createDiv();
    p.readChapters(books).then((entries) => renderChapterList(list, p, entries, ''));
  }

  /* ----- Topics ----- */
  renderTopics(c, books) {
    const p = this.plugin;
    const paths = p.getTopicPaths();
    const names = p.getTopicNames();
    c.createEl('p', { cls: 'bb-muted', text: 'Keep the list short. Each topic is a note in the Topics folder that lists its books.' });
    const add = c.createDiv({ cls: 'bb-topic-add' });
    const input = add.createEl('input', { type: 'text', attr: { placeholder: 'New topic' } });
    const btn = add.createEl('button', { cls: 'mod-cta', text: 'Add' });
    const doAdd = async () => {
      const v = input.value.trim();
      if (!v) return;
      if (names.some((n) => n.toLowerCase() === v.toLowerCase())) { new Notice(`${v} is already a topic`); return; }
      await p.ensureTopicNote(v);
      this.renderNow();
    };
    btn.addEventListener('click', doAdd);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') doAdd(); });
    for (const name of names) {
      const row = c.createDiv({ cls: 'bb-topic-row' });
      const tagged = books.filter((b) => b.topics.includes(name));
      const a = row.createEl('a', { cls: 'bb-title', text: name, href: '#' });
      a.addEventListener('click', async (e) => {
        e.preventDefault();
        if (paths[name]) p.app.workspace.openLinkText(paths[name], '', 'tab'); else { await p.ensureTopicNote(name); this.renderNow(); }
      });
      row.createSpan({ cls: 'bb-muted bb-grow', text: `${tagged.filter((b) => b.status === 'skimmed').length} skimmed · ${tagged.length} books` });
      const ren = row.createEl('button', { attr: { 'aria-label': `Rename ${name}` } });
      setIcon(ren, 'pencil');
      ren.addEventListener('click', () => new PromptModal(this.app, `Rename ${name}`, name, async (v) => { await p.renameTopic(name, v.trim()); this.renderNow(); }).open());
      const del = row.createEl('button', { cls: 'mod-warning', attr: { 'aria-label': `Delete ${name}` } });
      setIcon(del, 'trash-2');
      del.addEventListener('click', () => new ConfirmModal(this.app, `Delete the ${name} topic?`,
        tagged.length ? `It comes off ${tagged.length} ${tagged.length === 1 ? 'book' : 'books'}, and the topic note goes to the vault's trash.` : 'The topic note goes to the vault\'s trash.',
        async () => { await p.deleteTopic(name); this.renderNow(); }).open());
    }
  }
}

function renderChapterList(el, plugin, entries, sourcePath) {
  el.empty();
  const open = entries.filter((e) => e.chapters.some((ch) => !ch.done));
  if (!open.length) { el.createDiv({ cls: 'bb-empty', text: 'No chapters waiting. Mark keepers under "Chapters worth reading" during a skim.' }); return; }
  for (const e of open.sort((a, b) => byTitle(a.book, b.book))) {
    const sec = el.createDiv({ cls: 'bb-chapters' });
    const h = sec.createEl('a', { cls: 'bb-title', text: e.book.title, href: '#' });
    h.addEventListener('click', (ev) => { ev.preventDefault(); plugin.openBook(e.book, sourcePath); });
    for (const ch of e.chapters.filter((x) => !x.done)) {
      const lab = sec.createEl('label', { cls: 'bb-chapter' });
      const cb = lab.createEl('input', { type: 'checkbox' });
      lab.createSpan({ text: ch.text });
      cb.addEventListener('change', () => plugin.toggleChapter(e.book, ch, cb.checked));
    }
  }
}

/* ------------------------------------------------------------------ */
/* Code block: ```brown-bag``` inside notes                            */
/* ------------------------------------------------------------------ */

class BagBlock extends MarkdownRenderChild {
  constructor(el, plugin, source, sourcePath) {
    super(el);
    this.plugin = plugin;
    this.sourcePath = sourcePath;
    this.opts = {};
    for (const line of source.split('\n')) { const m = line.match(/^\s*([\w ]+?)\s*:\s*(.*?)\s*$/); if (m) this.opts[m[1].toLowerCase()] = m[2]; }
    this.render = debounce(() => this.renderNow(), 200, true);
  }
  onload() {
    this.registerEvent(this.plugin.app.metadataCache.on('changed', () => this.render()));
    this.registerEvent(this.plugin.app.vault.on('delete', () => this.render()));
    this.registerEvent(this.plugin.app.vault.on('rename', () => this.render()));
    this.renderNow();
  }

  renderNow() {
    const el = this.containerEl, p = this.plugin;
    el.empty();
    el.addClass('bb-block');
    const show = (this.opts.show || '').toLowerCase();
    const books = p.getBooks();

    if (show === 'book') {
      const b = books.find((x) => x.path === this.sourcePath);
      if (!b) return;
      const bar = el.createDiv({ cls: 'bb-bookbar' });
      chip(bar, STATUS_LABEL[b.status], b.status === 'skimming' ? 'bb-chip-deck' : '');
      if (b.verdict) chip(bar, VERDICT_LABEL[b.verdict], `bb-v-${b.verdict.replace(/\s+/g, '-')}`);
      if (b.sessions.length) bar.createSpan({ cls: 'bb-muted', text: `${b.sessions.length} ${b.sessions.length === 1 ? 'session' : 'sessions'}` });
      const acts = bar.createDiv({ cls: 'bb-row-actions' });
      const btn = (label, fn, cta) => { const x = acts.createEl('button', { cls: cta ? 'mod-cta' : '', text: label }); x.addEventListener('click', fn); };
      if (b.status === 'shelf') { btn('On deck', () => p.putOnDeck(b)); btn('Skim this week', () => p.setThisWeek(b)); }
      if (b.status === 'on deck') btn('Skim this week', () => p.setThisWeek(b));
      if (b.status === 'skimming') { btn('Start the hour', () => p.startSession(b), true); btn('Record verdict', () => new VerdictModal(p, b).open()); }
      if (b.status === 'skimmed') btn('Another session', () => p.reopenBook(b));
      if (!b.cover) btn('Find cover', () => new CoverModal(p, b).open());
      return;
    }

    if (show === 'topic' || this.opts.topic) {
      const topic = this.opts.topic || this.sourcePath.split('/').pop().replace(/\.md$/, '');
      const tagged = books.filter((b) => b.topics.includes(topic));
      if (!tagged.length) { el.createDiv({ cls: 'bb-empty', text: `No books in ${topic} yet.` }); return; }
      for (const st of ['skimming', 'on deck', 'skimmed', 'shelf']) {
        const list = tagged.filter((b) => b.status === st).sort(byTitle);
        if (!list.length) continue;
        el.createDiv({ cls: 'bb-label', text: `${STATUS_LABEL[st]} · ${list.length}` });
        const ul = el.createEl('ul', { cls: 'bb-plain' });
        for (const b of list) {
          const li = ul.createEl('li');
          const a = li.createEl('a', { cls: 'internal-link', text: b.title, href: b.path, attr: { 'data-href': b.path } });
          a.addEventListener('click', (e) => { e.preventDefault(); p.openBook(b, this.sourcePath); });
          if (b.author) li.createSpan({ cls: 'bb-muted', text: ` — ${b.author}` });
          if (b.verdict) li.createSpan({ cls: 'bb-muted', text: ` · ${VERDICT_LABEL[b.verdict]}` });
        }
      }
      return;
    }

    if (show === 'week') {
      const cur = books.find((b) => b.status === 'skimming');
      const deck = books.filter((b) => b.status === 'on deck').sort((a, b) => (a.decked || '').localeCompare(b.decked || ''));
      const row = el.createDiv({ cls: 'bb-bookbar' });
      row.createSpan({ cls: 'bb-label', text: 'This week' });
      if (cur) {
        const a = row.createEl('a', { cls: 'internal-link bb-title', text: cur.title, href: cur.path, attr: { 'data-href': cur.path } });
        a.addEventListener('click', (e) => { e.preventDefault(); p.openBook(cur, this.sourcePath); });
      } else row.createSpan({ cls: 'bb-muted', text: 'not picked yet' });
      const open = row.createEl('button', { cls: 'mod-cta', text: 'Open Brown Bag' });
      open.addEventListener('click', () => p.activateView());
      if (deck.length) {
        el.createDiv({ cls: 'bb-label', text: 'On deck' });
        const ul = el.createEl('ul', { cls: 'bb-plain' });
        for (const b of deck) {
          const a = ul.createEl('li').createEl('a', { cls: 'internal-link', text: b.title, href: b.path, attr: { 'data-href': b.path } });
          a.addEventListener('click', (e) => { e.preventDefault(); p.openBook(b, this.sourcePath); });
        }
      }
      return;
    }

    if (show === 'chapters') {
      const holder = el.createDiv();
      p.readChapters(books).then((entries) => renderChapterList(holder, p, entries, this.sourcePath));
      return;
    }

    el.createDiv({ cls: 'bb-empty', text: 'brown-bag: use show: book, topic, week or chapters.' });
  }
}

/* ------------------------------------------------------------------ */
/* Modals                                                             */
/* ------------------------------------------------------------------ */

async function searchOpenLibrary(title, author, limit) {
  const fields = 'key,title,author_name,cover_i,first_publish_year';
  const go = async (withAuthor) => {
    const q = new URLSearchParams({ title, limit: String(limit ? Math.max(limit, 5) : 12), fields });
    if (withAuthor && author && !/unknown|unclear/i.test(author)) q.set('author', author);
    const res = await requestUrl({ url: `https://openlibrary.org/search.json?${q}` });
    return (res.json.docs || []).filter((d) => d.cover_i);
  };
  let docs = await go(true);
  if (!docs.length && author) docs = await go(false);
  if (limit) docs = docs.slice(0, limit);
  return docs.map((d) => ({
    title: d.title,
    author: (d.author_name || []).join(', '),
    year: d.first_publish_year,
    cover: `https://covers.openlibrary.org/b/id/${d.cover_i}-M.jpg`,
  }));
}

function coverPicker(el, getQuery, onPick) {
  const status = el.createDiv({ cls: 'bb-muted' });
  const results = el.createDiv({ cls: 'bb-cover-results' });
  return async () => {
    const { title, author } = getQuery();
    if (!title) { status.setText('Enter a title first.'); return; }
    status.setText('Searching Open Library…');
    results.empty();
    try {
      const found = await searchOpenLibrary(title, author);
      if (!found.length) { status.setText('No covers found. Paste an image URL instead.'); return; }
      status.setText('Tap the right cover.');
      for (const r of found) {
        const b = results.createEl('button', { cls: 'bb-cover-option', attr: { title: `${r.title}${r.author ? ` — ${r.author}` : ''}${r.year ? ` (${r.year})` : ''}` } });
        b.createEl('img', { attr: { src: r.cover, alt: r.title, loading: 'lazy' } });
        b.addEventListener('click', () => { results.querySelectorAll('.bb-cover-option').forEach((x) => x.removeClass('is-picked')); b.addClass('is-picked'); onPick(r); });
      }
    } catch (e) { status.setText("Couldn't reach Open Library. Paste a cover URL instead."); }
  };
}

class VerdictModal extends Modal {
  constructor(plugin, book) {
    super(plugin.app);
    this.plugin = plugin;
    this.book = book;
    this.data = { verdict: book.verdict || '', idea: book.idea || '', applies: '', link: book.link || '' };
  }
  onOpen() {
    const { contentEl } = this, d = this.data;
    contentEl.addClass('bb-modal');
    this.titleEl.setText(`Verdict: ${this.book.title}`);

    const whyBox = contentEl.createDiv({ cls: 'bb-why bb-why-recall' });
    this.plugin.readWhy(this.book).then((w) => { if (w) whyBox.setText(`Why you picked it: ${w}`); else whyBox.remove(); });

    contentEl.createDiv({ cls: 'bb-label', text: 'The one idea worth keeping' });
    const idea = contentEl.createEl('textarea', { cls: 'bb-textarea', attr: { rows: '3', placeholder: 'If you remember one thing from this book…' } });
    idea.value = d.idea;
    idea.addEventListener('input', () => { d.idea = idea.value; });
    window.setTimeout(() => idea.focus(), 50);

    contentEl.createDiv({ cls: 'bb-label', text: 'Where it applies right now' });
    const applies = contentEl.createEl('textarea', { cls: 'bb-textarea', attr: { rows: '3', placeholder: 'A team, a project, a conversation, a coaching client…' } });
    applies.addEventListener('input', () => { d.applies = applies.value; });
    this.plugin.app.vault.cachedRead(this.book.file).then((txt) => {
      const sec = getSection(txt, 'Verdict');
      const m = sec && sec.text.match(/\*\*Where it applies right now:\*\*\s*(.+)/);
      if (m && m[1].trim() !== '—' && !applies.value) { applies.value = m[1].trim(); d.applies = applies.value; }
    });

    contentEl.createDiv({ cls: 'bb-label', text: 'What happens to the book next' });
    const seg = contentEl.createDiv({ cls: 'bb-verdicts' });
    const draw = () => {
      seg.empty();
      for (const [v, label] of VERDICTS) {
        const b = seg.createEl('button', { cls: d.verdict === v ? 'is-active mod-cta' : '', text: label });
        b.addEventListener('click', () => { d.verdict = v; draw(); });
      }
    };
    draw();

    new Setting(contentEl).setName('Link').setDesc('Optional. A Bookpile, Goodreads or StoryGraph page.').addText((t) => t.setPlaceholder('https://…').setValue(d.link).onChange((v) => { d.link = v.trim(); }));
    new Setting(contentEl).addButton((b) => b.setButtonText('Save verdict').setCta().onClick(async () => {
      if (!d.verdict) { new Notice('Pick what happens to the book next'); return; }
      await this.plugin.recordVerdict(this.book, d);
      this.close();
    }));
  }
  onClose() { this.contentEl.empty(); }
}

class AddBookModal extends Modal {
  constructor(plugin) { super(plugin.app); this.plugin = plugin; this.data = { title: '', author: '', cover: '', link: '', topics: [], status: 'shelf' }; }
  onOpen() {
    const { contentEl } = this, d = this.data;
    contentEl.addClass('bb-modal');
    this.titleEl.setText('Add a book to the library');
    let coverInput, authorInput;
    new Setting(contentEl).setName('Title').addText((t) => { t.setPlaceholder('Required').onChange((v) => { d.title = v.trim(); }); window.setTimeout(() => t.inputEl.focus(), 50); });
    new Setting(contentEl).setName('Author').addText((t) => { authorInput = t; t.onChange((v) => { d.author = v.trim(); }); });
    new Setting(contentEl).setName('Link').setDesc('Optional. A Bookpile, Goodreads or StoryGraph page.').addText((t) => t.setPlaceholder('https://…').onChange((v) => { d.link = v.trim(); }));
    new Setting(contentEl).setName('Where it goes').addDropdown((dd) => dd.addOption('shelf', 'On the shelf').addOption('on deck', 'On deck').setValue('shelf').onChange((v) => { d.status = v; }));
    new Setting(contentEl).setName('Topics').settingEl.addClass('bb-setting-block');
    const chips = contentEl.createDiv({ cls: 'bb-chips' });
    const draw = () => {
      chips.empty();
      for (const t of this.plugin.getTopicNames()) {
        const c = chips.createEl('button', { cls: `bb-chip ${d.topics.includes(t) ? 'is-active' : ''}`, text: t });
        c.addEventListener('click', () => { d.topics = d.topics.includes(t) ? d.topics.filter((x) => x !== t) : [...d.topics, t]; draw(); });
      }
      const add = chips.createEl('button', { cls: 'bb-chip bb-chip-add', text: '+ New topic' });
      add.addEventListener('click', () => new PromptModal(this.app, 'New topic', '', async (v) => {
        if (!v.trim()) return;
        const name = await this.plugin.ensureTopicNote(v.trim());
        if (!d.topics.includes(name)) d.topics.push(name);
        draw();
      }).open());
    };
    draw();
    const cs = new Setting(contentEl).setName('Cover');
    cs.addText((t) => { coverInput = t; t.setPlaceholder('Image URL, or find one →').onChange((v) => { d.cover = v.trim(); }); });
    const picker = contentEl.createDiv();
    const search = coverPicker(picker, () => d, (r) => { d.cover = r.cover; coverInput.setValue(r.cover); if (!d.author && r.author) { d.author = r.author; authorInput.setValue(r.author); } });
    cs.addButton((b) => b.setButtonText('Find cover').onClick(search));
    contentEl.createDiv({ cls: 'bb-label', text: WHY_HEADING });
    const whyTa = contentEl.createEl('textarea', { cls: 'bb-textarea', attr: { rows: '3', placeholder: `${WHY_PROMPT} (Optional)` } });
    whyTa.addEventListener('input', () => { d.why = whyTa.value; });

    new Setting(contentEl).addButton((b) => b.setButtonText('Add book').setCta().onClick(async () => {
      if (!d.title) { new Notice('A title is the one thing I need'); return; }
      if (d.status === 'on deck') d.decked = todayStr();
      await this.plugin.createBook(d);
      new Notice(`Added ${d.title}`);
      this.close();
    }));
  }
  onClose() { this.contentEl.empty(); }
}

class WhyModal extends Modal {
  constructor(plugin, book) { super(plugin.app); this.plugin = plugin; this.book = book; }
  onOpen() {
    const { contentEl } = this;
    contentEl.addClass('bb-modal');
    this.titleEl.setText(`Why ${this.book.title}?`);
    contentEl.createDiv({ cls: 'bb-muted', text: WHY_PROMPT });
    const why = contentEl.createEl('textarea', { cls: 'bb-textarea', attr: { rows: '4' } });
    contentEl.createDiv({ cls: 'bb-label', text: 'Guiding question (optional)' });
    const q = contentEl.createEl('textarea', { cls: 'bb-textarea', attr: { rows: '2', placeholder: 'Something on your mind to read this book against' } });
    this.plugin.app.vault.cachedRead(this.book.file).then((txt) => {
      if (!why.value) why.value = getWhy(txt);
      const sec = getSection(txt, 'Guiding question');
      if (!q.value && sec) q.value = sec.text.trim();
    });
    window.setTimeout(() => why.focus(), 50);
    new Setting(contentEl)
      .addButton((b) => b.setButtonText('Skip').onClick(() => this.close()))
      .addButton((b) => b.setButtonText('Save').setCta().onClick(async () => {
        await this.plugin.saveWhy(this.book, why.value, q.value);
        this.close();
      }));
  }
  onClose() { this.contentEl.empty(); }
}

class CoverModal extends Modal {
  constructor(plugin, book) { super(plugin.app); this.plugin = plugin; this.book = book; }
  onOpen() {
    const { contentEl } = this;
    contentEl.addClass('bb-modal');
    this.titleEl.setText(`Cover for ${this.book.title}`);
    const q = { title: this.book.title, author: this.book.author.split(/;|,/)[0].trim() };
    let urlInput;
    new Setting(contentEl).setName('Search title').addText((t) => t.setValue(q.title).onChange((v) => { q.title = v.trim(); }));
    new Setting(contentEl).setName('Search author').addText((t) => t.setValue(q.author).onChange((v) => { q.author = v.trim(); }));
    const s = new Setting(contentEl).setName('Or paste an image URL').addText((t) => { urlInput = t; t.setValue(this.book.cover); });
    const picker = contentEl.createDiv();
    const search = coverPicker(picker, () => q, (r) => urlInput.setValue(r.cover));
    s.addButton((b) => b.setButtonText('Find cover').onClick(search));
    new Setting(contentEl).addButton((b) => b.setButtonText('Save cover').setCta().onClick(async () => {
      const url = (urlInput.getValue() || '').trim();
      await this.plugin.app.fileManager.processFrontMatter(this.book.file, (fm) => { fm.cover = url; });
      this.close();
    }));
    search();
  }
  onClose() { this.contentEl.empty(); }
}

class PromptModal extends Modal {
  constructor(app, title, value, onSubmit) { super(app); this.titleText = title; this.value = value || ''; this.onSubmit = onSubmit; }
  onOpen() {
    this.titleEl.setText(this.titleText);
    let input;
    const submit = () => { const v = input.getValue(); this.close(); this.onSubmit(v); };
    new Setting(this.contentEl).addText((t) => {
      input = t; t.setValue(this.value);
      t.inputEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
      window.setTimeout(() => { t.inputEl.focus(); t.inputEl.select(); }, 50);
    });
    new Setting(this.contentEl).addButton((b) => b.setButtonText('OK').setCta().onClick(submit));
  }
  onClose() { this.contentEl.empty(); }
}

class ConfirmModal extends Modal {
  constructor(app, title, body, onYes) { super(app); this.t = title; this.b = body; this.onYes = onYes; }
  onOpen() {
    this.titleEl.setText(this.t);
    this.contentEl.createEl('p', { text: this.b });
    new Setting(this.contentEl)
      .addButton((b) => b.setButtonText('Cancel').onClick(() => this.close()))
      .addButton((b) => b.setButtonText('Delete').setWarning().onClick(() => { this.close(); this.onYes(); }));
  }
  onClose() { this.contentEl.empty(); }
}

/* ------------------------------------------------------------------ */
/* Settings                                                           */
/* ------------------------------------------------------------------ */

class BagSettingTab extends PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }
  display() {
    const { containerEl } = this, s = this.plugin.settings, save = () => this.plugin.saveSettings();
    containerEl.empty();
    new Setting(containerEl).setName('Open Brown Bag when the vault opens').addToggle((t) => t.setValue(s.openOnStartup).onChange(async (v) => { s.openOnStartup = v; await save(); }));
    new Setting(containerEl).setName('The hour').setHeading();
    s.phases.forEach((ph, i) => {
      new Setting(containerEl).setName(ph.name).setDesc(ph.prompt).addText((t) => t.setValue(String(ph.minutes)).onChange(async (v) => {
        const n = parseInt(v, 10);
        if (n >= 1) { s.phases[i] = { ...ph, minutes: n }; await save(); }
      }));
    });
    new Setting(containerEl).setName('Reset the phases').addButton((b) => b.setButtonText('Reset').onClick(async () => { s.phases = DEFAULT_PHASES.map((x) => ({ ...x })); await save(); this.display(); }));
    new Setting(containerEl).setName('Retros').setHeading();
    new Setting(containerEl).setName('Suggest a retro every').setDesc('Number of sessions. 0 turns the prompt off.').addText((t) => t.setValue(String(s.retroEvery)).onChange(async (v) => {
      const n = parseInt(v, 10);
      if (n >= 0) { s.retroEvery = n; await save(); }
    }));
    new Setting(containerEl).setName('Folders').setHeading();
    const folder = (name, key) => new Setting(containerEl).setName(name).addText((t) => t.setValue(s[key]).onChange(async (v) => { s[key] = v.trim() || DEFAULT_SETTINGS[key]; await save(); }));
    folder('Books', 'booksFolder');
    folder('Topics', 'topicsFolder');
    folder('Exports', 'exportsFolder');
    folder('Retros', 'retrosFolder');
    new Setting(containerEl).setName('Exports').setHeading();
    new Setting(containerEl).setName('Reset "since last export"')
      .setDesc(s.lastExportDate ? `Last export: ${niceDate(s.lastExportDate)}.` : 'No export yet.')
      .addButton((b) => b.setButtonText('Reset').onClick(async () => { s.lastExportDate = ''; s.exportedKeys = []; await save(); this.display(); }));
  }
}

module.exports = BrownBagPlugin;
module.exports.default = BrownBagPlugin;
module.exports.helpers = {
  todayStr, toDateStr, stripLink, toList, normStatus, normVerdict, dateList, bookFromFrontmatter,
  getSection, setSection, getWhy, setWhy, parseChapters, noteDetails, exportYearReport, buildYearReport, renderReportMarkdown, longestWeekStreak, linkLabel, toggleChapterLine, sessionState, fmtMs, safeFileName,
  buildBookNote, buildTopicNote, buildRetroNote, verdictBody, exportSkimNotes, exportChapters,
  exportLibraryMarkdown, exportLibraryCsv, totalSessions, DEFAULT_SETTINGS, DEFAULT_PHASES,
};
