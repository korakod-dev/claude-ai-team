#!/usr/bin/env node
'use strict';
/**
 * timing-analysis.js
 * READ-ONLY timing analysis of data/events.jsonl (never writes to the events file).
 *
 * Question it answers: where does wall-clock time go in AI-Team task runs?
 *
 * How runs are reconstructed (from the hook schema actually present in the log):
 *   PreToolUse(Agent)  -> secretary decides to delegate (tool_use_id, subagent_type, description)
 *   PostToolUse(Agent) -> carries agent_ref (= agent_id of the launched run) + response_status
 *   SubagentStart/Stop -> same agent_id; duration = Stop.ts - Start.ts
 *   UserPromptSubmit/Stop (no agent_id) -> main-session ("secretary") turn boundaries
 *
 * Ignored on purpose: SubagentStop records that have NO matching SubagentStart and no agent_ref.
 * In this log they are the "prompt suggestion" side-calls of the main session (last_message is a
 * suggested next prompt), not real task runs.
 *
 * Usage:
 *   node scripts/timing-analysis.js                       text report to stdout
 *   node scripts/timing-analysis.js --json                full machine-readable result
 *   node scripts/timing-analysis.js --file <events.jsonl>  analyse another file
 *   node scripts/timing-analysis.js --chain-gap 600       seconds of silence that split two chains
 *   node scripts/timing-analysis.js --break 600           idle gap (s) treated as a break, not waiting
 */

const fs = require('fs');
const path = require('path');

// ---------- config ----------
const DEFAULT_FILE = path.join(__dirname, '..', 'data', 'events.jsonl');
const NOTIFY_WINDOW_S = 2; // a UserPromptSubmit this close after a run's Stop = task-notification turn
const TRIVIAL_RUN_S = 10; // runs shorter than this are counted as "trivial/aborted"

// The team was renamed during the log period; fold every historical name into one role.
const ROLE_BY_TYPE = {
  'เก่ง': 'Dev', 'app-dev': 'Dev', 'Dev-ไอ้เก่ง': 'Dev',
  'ละเอียด': 'QA', 'qa-reviewer': 'QA', 'QA-คุณละเอียด': 'QA',
  'หนอนหนังสือ': 'Writer', 'study-writer': 'Writer', 'Writer-ยัยแว่นหนา': 'Writer',
  'กวีโปรเจกต์': 'Content', 'portfolio-writer': 'Content', 'Content Director': 'Content',
  'PM-Professor-X': 'PM', pm: 'PM',
  'ป้าแจ๋ว': 'Secretary', secretary: 'Secretary', 'เลขาคนสวย': 'Secretary',
};
const roleOf = (t) => ROLE_BY_TYPE[t] || `other:${t}`;

// ---------- small helpers ----------
const ts = (s) => Date.parse(s) / 1000; // seconds (float)
const sum = (a) => a.reduce((x, y) => x + y, 0);
function median(a) {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function pct(a, p) {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
}
const r1 = (n) => (n == null ? null : Math.round(n * 10) / 10);
function stats(a) {
  return {
    n: a.length, total: r1(sum(a)), avg: r1(a.length ? sum(a) / a.length : null),
    median: r1(median(a)), p90: r1(pct(a, 90)), max: r1(a.length ? Math.max(...a) : null),
  };
}
function fmt(sec) { // 75 -> "1m15s"
  if (sec == null) return '-';
  const s = Math.round(sec);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m${String(s % 60).padStart(2, '0')}s` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`;
}

function parseArgs(argv) {
  const o = { file: DEFAULT_FILE, json: false, chainGap: 600, brk: 600 };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--json') o.json = true;
    else if (a === '--file') o.file = path.resolve(argv[++i]);
    else if (a === '--chain-gap') o.chainGap = Number(argv[++i]);
    else if (a === '--break') o.brk = Number(argv[++i]);
    else throw new Error(`Unknown flag: ${a}`);
  }
  return o;
}

// ---------- load + reconstruct runs ----------
function load(file) {
  const events = [];
  let bad = 0;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { const e = JSON.parse(line); e.t = ts(e.ts); events.push(e); } catch { bad += 1; }
  }
  events.sort((a, b) => a.t - b.t);
  return { events, bad };
}

function buildRuns(events) {
  const isAgentTool = (e) => e.tool_name === 'Agent' || e.tool_name === 'Task';
  const pre = new Map(); const post = new Map();
  const start = new Map(); const stop = new Map();
  const failures = [];
  for (const e of events) {
    if (e.event === 'PreToolUse' && isAgentTool(e)) pre.set(e.tool_use_id, e);
    else if (e.event === 'PostToolUse' && isAgentTool(e) && e.agent_ref) post.set(e.tool_use_id, e);
    else if (e.event === 'PostToolUseFailure' && isAgentTool(e)) failures.push(e);
    else if (e.event === 'SubagentStart') start.set(e.agent_id, e);
    else if (e.event === 'SubagentStop') stop.set(e.agent_id, e);
  }
  const runs = [];
  for (const [uid, p] of post) {
    const id = p.agent_ref;
    const pr = pre.get(uid); const st = start.get(id); const sp = stop.get(id);
    runs.push({
      id, session: p.session_id,
      subagentType: p.subagent_type, role: roleOf(p.subagent_type),
      description: p.description || '',
      mode: p.response_status === 'completed' ? 'sync' : 'async',
      caller: pr ? pr.agent_type : p.agent_type,
      launch: pr ? pr.t : p.t, // secretary issued the delegation
      start: st ? st.t : null, end: sp ? sp.t : null,
      dur: st && sp ? sp.t - st.t : null,
      launchLatency: pr && st ? st.t - pr.t : null,
    });
  }
  runs.sort((a, b) => a.launch - b.launch);
  return { runs, failures, unmatchedStops: [...stop.values()].filter((s) => !start.has(s.agent_id) && ![...post.values()].some((p) => p.agent_ref === s.agent_id)).length };
}

// ---------- main-session turns ----------
// A turn = UserPromptSubmit -> next Stop (same session). If the prompt arrives within
// NOTIFY_WINDOW_S after a run's end it is a task-notification (relay) turn, otherwise human-driven.
function buildTurns(events, runs) {
  const endsBySession = new Map();
  for (const r of runs) if (r.end) { (endsBySession.get(r.session) || endsBySession.set(r.session, []).get(r.session)).push(r.end); }
  const open = new Map(); const turns = [];
  for (const e of events) {
    if (e.event === 'UserPromptSubmit') open.set(e.session_id, e);
    else if (e.event === 'Stop' && open.has(e.session_id)) {
      const u = open.get(e.session_id); open.delete(e.session_id);
      const ends = endsBySession.get(e.session_id) || [];
      const kind = ends.some((x) => u.t - x >= -0.5 && u.t - x <= NOTIFY_WINDOW_S) ? 'relay' : 'human';
      turns.push({ session: e.session_id, start: u.t, end: e.t, dur: e.t - u.t, kind });
    }
  }
  return turns;
}

// ---------- time attribution per session ----------
// Priority sweep: agent running > secretary relay turn > secretary dispatch turn > waiting/break.
function attribute(runs, turns, brk) {
  const bySession = new Map();
  const add = (s, kind, a, b, pri) => { if (b > a) (bySession.get(s) || bySession.set(s, []).get(s)).push({ kind, a, b, pri }); };
  for (const r of runs) if (r.start && r.end) add(r.session, 'agent', r.start, r.end, 3);
  for (const t of turns) add(t.session, t.kind === 'relay' ? 'relay' : 'dispatch', t.start, t.end, t.kind === 'relay' ? 2 : 1);
  const total = { agent: 0, relay: 0, dispatch: 0, wait: 0, break: 0 };
  for (const iv of bySession.values()) {
    const cuts = [...new Set(iv.flatMap((x) => [x.a, x.b]))].sort((a, b) => a - b);
    for (let i = 0; i < cuts.length - 1; i += 1) {
      const a = cuts[i]; const b = cuts[i + 1];
      const cover = iv.filter((x) => x.a <= a && x.b >= b).sort((x, y) => y.pri - x.pri)[0];
      if (cover) total[cover.kind] += b - a;
      else total[b - a > brk ? 'break' : 'wait'] += b - a;
    }
  }
  return total;
}

// ---------- chains ----------
function buildChains(runs, turns, chainGap) {
  const out = [];
  const bySession = new Map();
  for (const r of runs) (bySession.get(r.session) || bySession.set(r.session, []).get(r.session)).push(r);
  for (const [session, list] of bySession) {
    let cur = null;
    for (const r of list) {
      const rEnd = r.end ?? r.launch;
      if (!cur || r.launch - cur.lastEnd > chainGap) { cur = { session, runs: [], lastEnd: rEnd }; out.push(cur); }
      cur.runs.push(r); cur.lastEnd = Math.max(cur.lastEnd, rEnd);
    }
  }
  return out.map((c) => {
    const rs = c.runs;
    const first = rs[0].launch; const last = c.lastEnd;
    const closed = rs.filter((r) => r.dur != null);
    // union of running time (handles overlapping runs)
    const iv = closed.map((r) => [r.start, r.end]).sort((a, b) => a[0] - b[0]);
    let busy = 0; let curEnd = -Infinity;
    for (const [a, b] of iv) { busy += Math.max(0, b - Math.max(a, curEnd)); curEnd = Math.max(curEnd, b); }
    // inter-step gaps: previous end -> next launch. Decomposed by what the main session was doing:
    //   relay    = secretary turn triggered by the previous run's completion notification
    //   dispatch = secretary turn started by a human prompt (approval / next instruction)
    //   idle     = nothing running anywhere (owner thinking/reading, or unknown)
    const sessTurns = turns.filter((t) => t.session === c.session);
    const cover = (kind, a, b) => sum(sessTurns.filter((t) => t.kind === kind)
      .map((t) => Math.max(0, Math.min(t.end, b) - Math.max(t.start, a))));
    const gaps = [];
    for (let i = 1; i < rs.length; i += 1) {
      const prevEnd = Math.max(...rs.slice(0, i).map((r) => r.end ?? 0));
      if (!prevEnd) continue;
      const gap = rs[i].launch - prevEnd;
      if (gap < 0) continue; // overlap = parallel launch, no gap
      const relay = cover('relay', prevEnd, rs[i].launch);
      const dispatch = cover('human', prevEnd, rs[i].launch);
      gaps.push({ gap, relay, dispatch, idle: Math.max(0, gap - relay - dispatch), from: rs[i - 1].role, to: rs[i].role });
    }
    return {
      session: c.session, date: new Date(first * 1000).toISOString(), steps: rs.length,
      pattern: rs.length > 8 ? `${rs.slice(0, 8).map((r) => r.role).join(' > ')} > ...(+${rs.length - 8})` : rs.map((r) => r.role).join(' > '), descriptions: rs.map((r) => r.description),
      wall: last - first, busy, gapTotal: sum(gaps.map((g) => g.gap)),
      relayTotal: sum(gaps.map((g) => g.relay)), dispatchTotal: sum(gaps.map((g) => g.dispatch)), idleTotal: sum(gaps.map((g) => g.idle)),
      gaps,
    };
  });
}

// ---------- overlap / parallelism ----------
function overlap(runs, chainGap) {
  const closed = runs.filter((r) => r.dur != null);
  const bySession = new Map();
  for (const r of closed) (bySession.get(r.session) || bySession.set(r.session, []).get(r.session)).push(r);
  let maxConc = 0; let overlapSec = 0; const parallelSessions = new Set();
  const candidates = []; // back-to-back runs of the SAME role with different descriptions
  for (const [session, list] of bySession) {
    const pts = list.flatMap((r) => [[r.start, 1], [r.end, -1]]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    let c = 0; let last = null;
    for (const [t, d] of pts) {
      if (c >= 2 && last != null) { overlapSec += t - last; parallelSessions.add(session); }
      c += d; maxConc = Math.max(maxConc, c); last = t;
    }
    list.sort((a, b) => a.launch - b.launch);
    for (let i = 1; i < list.length; i += 1) {
      const a = list[i - 1]; const b = list[i];
      if (a.role === b.role && b.launch >= a.end && b.launch - a.end <= chainGap && a.description !== b.description
        && a.dur > TRIVIAL_RUN_S && b.dur > TRIVIAL_RUN_S) {
        candidates.push({ role: a.role, first: a.description, second: b.description, firstDur: a.dur, secondDur: b.dur, gap: b.launch - a.end, session });
      }
    }
  }
  return { maxConcurrency: maxConc, overlapSeconds: overlapSec, sessionsWithParallel: parallelSessions.size, sessionsTotal: bySession.size, sequentialSameRoleCandidates: candidates };
}

// ---------- tool time inside subagents ----------
// Pre->Post of tool calls made BY subagents (events carrying agent_id). Only tools that the hook
// matcher logged appear here, so this is a lower bound, not a full tool-time accounting.
function toolTime(events) {
  const pre = new Map(); const by = {};
  for (const e of events) {
    if (!e.agent_id || e.tool_name === 'Agent' || e.tool_name === 'Task') continue;
    if (e.event === 'PreToolUse') pre.set(e.tool_use_id, e);
    else if ((e.event === 'PostToolUse' || e.event === 'PostToolUseFailure') && pre.has(e.tool_use_id)) {
      (by[e.tool_name] ||= []).push(e.t - pre.get(e.tool_use_id).t);
    }
  }
  return Object.fromEntries(Object.entries(by).map(([k, v]) => [k, stats(v)]));
}

// ---------- analyse ----------
function analyse(opts) {
  const { events, bad } = load(opts.file);
  const { runs, failures, unmatchedStops } = buildRuns(events);
  const turns = buildTurns(events, runs);
  const closed = runs.filter((r) => r.dur != null);

  const byRole = {};
  for (const r of closed) (byRole[r.role] ||= []).push(r.dur);
  const roleStats = Object.fromEntries(Object.entries(byRole).map(([k, v]) => [k, {
    ...stats(v), trivial: v.filter((x) => x < TRIVIAL_RUN_S).length,
    statsExcludingTrivial: stats(v.filter((x) => x >= TRIVIAL_RUN_S)),
  }]));
  const byMode = { sync: stats(closed.filter((r) => r.mode === 'sync').map((r) => r.dur)), async: stats(closed.filter((r) => r.mode === 'async').map((r) => r.dur)) };

  const roleMode = {};
  for (const r of closed) { const k = `${r.role}/${r.mode}`; (roleMode[k] ||= []).push(r.dur); }
  const roleModeStats = Object.fromEntries(Object.entries(roleMode).map(([k, v]) => [k, stats(v)]));

  const turnStats = {
    relay: stats(turns.filter((t) => t.kind === 'relay').map((t) => t.dur)),
    dispatchOrHuman: stats(turns.filter((t) => t.kind === 'human').map((t) => t.dur)),
  };
  const chains = buildChains(runs, turns, opts.chainGap);
  const multi = chains.filter((c) => c.steps >= 2);

  return {
    meta: {
      file: opts.file, events: events.length, badLines: bad,
      from: new Date(events[0].t * 1000).toISOString(), to: new Date(events.at(-1).t * 1000).toISOString(),
      sessions: new Set(events.map((e) => e.session_id)).size,
      runs: runs.length, runsClosed: closed.length, runsOpen: runs.length - closed.length,
      agentToolFailures: failures.length, ignoredPromptSuggestionStops: unmatchedStops,
      chainGapSeconds: opts.chainGap, breakSeconds: opts.brk,
    },
    byRole: roleStats, byMode, roleModeStats, turnStats,
    launchLatency: stats(runs.map((r) => r.launchLatency).filter((x) => x != null)),
    attribution: attribute(runs, turns, opts.brk),
    chains: { total: chains.length, multiStep: multi.length, list: multi },
    patterns: Object.entries(multi.reduce((m, c) => { m[c.pattern] = (m[c.pattern] || 0) + 1; return m; }, {})).sort((a, b) => b[1] - a[1]).slice(0, 12),
    gapStats: {
      all: stats(multi.flatMap((c) => c.gaps.map((g) => g.gap))),
      relay: stats(multi.flatMap((c) => c.gaps.map((g) => g.relay))),
      dispatch: stats(multi.flatMap((c) => c.gaps.map((g) => g.dispatch))),
      idle: stats(multi.flatMap((c) => c.gaps.map((g) => g.idle))),
    },
    // handoff transitions (role -> next role) with gap stats; shows Dev<->QA rework loops
    transitions: Object.entries(multi.flatMap((c) => c.gaps).reduce((m, g) => { (m[`${g.from} > ${g.to}`] ||= []).push(g.gap); return m; }, {}))
      .map(([k, v]) => ({ transition: k, ...stats(v) })).sort((a, b) => b.n - a.n).slice(0, 8),
    // how much of total agent time sits in long runs
    longRuns: [300, 600, 1200].map((th) => {
      const l = closed.filter((r) => r.dur >= th);
      return { thresholdSec: th, n: l.length, total: r1(sum(l.map((r) => r.dur))), shareOfAgentTime: r1(100 * sum(l.map((r) => r.dur)) / sum(closed.map((r) => r.dur))), byRole: l.reduce((m, r) => { m[r.role] = (m[r.role] || 0) + 1; return m; }, {}), sync: l.filter((r) => r.mode === 'sync').length };
    }),
    retries: closed.filter((r) => /re-?brief|retry|again|redo/i.test(r.description)).map((r) => ({ role: r.role, description: r.description, dur: r1(r.dur) })),
    top5: [...closed].sort((a, b) => b.dur - a.dur).slice(0, 5).map((r) => ({
      role: r.role, type: r.subagentType, mode: r.mode, dur: r1(r.dur), description: r.description, started: new Date(r.start * 1000).toISOString(), session: r.session.slice(0, 8),
    })),
    overlap: overlap(runs, opts.chainGap),
    subagentToolTime: toolTime(events),
    failures: failures.map((f) => ({ ts: f.ts, subagent_type: f.subagent_type, error: String(f.error || '').slice(0, 100) })),
  };
}

// ---------- text output ----------
function printText(R) {
  const L = (s = '') => console.log(s);
  const m = R.meta;
  L(`events=${m.events} bad=${m.badLines} sessions=${m.sessions} ${m.from} -> ${m.to}`);
  L(`runs=${m.runs} closed=${m.runsClosed} open=${m.runsOpen} agentToolFailures=${m.agentToolFailures} ignoredPromptSuggestionStops=${m.ignoredPromptSuggestionStops}`);
  L('\n== 1. Duration per role (Start->Stop, seconds) ==');
  for (const [k, v] of Object.entries(R.byRole).sort((a, b) => b[1].total - a[1].total)) {
    L(`${k.padEnd(10)} n=${v.n} total=${fmt(v.total)} avg=${fmt(v.avg)} med=${fmt(v.median)} p90=${fmt(v.p90)} max=${fmt(v.max)} trivial(<${TRIVIAL_RUN_S}s)=${v.trivial}`);
  }
  L(`sync  : ${JSON.stringify(R.byMode.sync)}`); L(`async : ${JSON.stringify(R.byMode.async)}`);
  L(`launch latency (Pre->Start): ${JSON.stringify(R.launchLatency)}`);
  L('\n== Secretary turns ==');
  L(`relay turns (notification-driven): ${JSON.stringify(R.turnStats.relay)}`);
  L(`dispatch/human turns            : ${JSON.stringify(R.turnStats.dispatchOrHuman)}`);
  L('\n== 2. Wall-clock attribution (priority: agent > relay > dispatch > wait) ==');
  const A = R.attribution; const tot = sum(Object.values(A));
  for (const [k, v] of Object.entries(A)) L(`${k.padEnd(9)} ${fmt(v).padStart(8)}  ${(100 * v / tot).toFixed(1)}%`);
  L(`\nchains: total=${R.chains.total} multiStep=${R.chains.multiStep}`);
  L('top patterns: ' + R.patterns.map(([p, n]) => `${p} x${n}`).join(' | '));
  L(`inter-step gap: ${JSON.stringify(R.gapStats.all)}`); L(`  of which relay: ${JSON.stringify(R.gapStats.relay)}`); L(`  of which dispatch (human-prompted secretary turn): ${JSON.stringify(R.gapStats.dispatch)}`);
  L(`  of which idle (owner/unknown): ${JSON.stringify(R.gapStats.idle)}`);
  L('transitions: ' + R.transitions.map((t) => `${t.transition} n=${t.n} med=${fmt(t.median)}`).join(' | '));
  L('role/mode: ' + Object.entries(R.roleModeStats).map(([k, v]) => `${k} n=${v.n} tot=${fmt(v.total)} med=${fmt(v.median)}`).join(' | '));
  R.longRuns.forEach((l) => L(`runs >= ${fmt(l.thresholdSec)}: n=${l.n} total=${fmt(l.total)} (${l.shareOfAgentTime}% of agent time) roles=${JSON.stringify(l.byRole)} sync=${l.sync}`));
  L(`retry/re-brief runs: ${R.retries.length} total ${fmt(sum(R.retries.map((r) => r.dur)))}`);
  const mc = R.chains.list;
  L(`multi-step chains: wall=${fmt(sum(mc.map((c) => c.wall)))} agentBusy=${fmt(sum(mc.map((c) => c.busy)))} gaps=${fmt(sum(mc.map((c) => c.gapTotal)))} (relay ${fmt(sum(mc.map((c) => c.relayTotal)))}, dispatch ${fmt(sum(mc.map((c) => c.dispatchTotal)))}, idle ${fmt(sum(mc.map((c) => c.idleTotal)))})`);
  L('\n== 3. Top 5 slowest runs ==');
  R.top5.forEach((r, i) => L(`${i + 1}. ${r.role} (${r.type}, ${r.mode}) ${fmt(r.dur)} "${r.description}" ${r.started.slice(0, 16)} sess ${r.session}`));
  L('\n== 4. Overlap ==');
  const o = R.overlap;
  L(`maxConcurrency=${o.maxConcurrency} overlapTime=${fmt(o.overlapSeconds)} sessionsWithParallel=${o.sessionsWithParallel}/${o.sessionsTotal}`);
  L(`back-to-back same-role runs with different descriptions: ${o.sequentialSameRoleCandidates.length}`);
  o.sequentialSameRoleCandidates.slice(0, 15).forEach((c) => L(`  ${c.role}: "${c.first}" (${fmt(c.firstDur)}) -> "${c.second}" (${fmt(c.secondDur)}) gap ${fmt(c.gap)}`));
  L('\n== Tool time inside subagents (logged tools only; lower bound) ==');
  for (const [k, v] of Object.entries(R.subagentToolTime).sort((a, b) => b[1].total - a[1].total)) L(`  ${k.padEnd(14)} n=${v.n} total=${fmt(v.total)} max=${fmt(v.max)}`);
  L('\n== Agent tool failures ==');
  R.failures.forEach((f) => L(`  ${f.ts} ${f.subagent_type}: ${f.error}`));
}

if (require.main === module) {
  const opts = parseArgs(process.argv);
  const R = analyse(opts);
  if (opts.json) console.log(JSON.stringify(R, null, 2)); else printText(R);
}

module.exports = { analyse, roleOf };
