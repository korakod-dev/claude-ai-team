import { NO_DATA } from './model.js';

/**
 * stellar/hud.js - Planet HUD panel (DOM only). Shows one snapshot from store.js for the focused planet.
 * The markup lives in index.html (#planet-hud with data-hud="..." parts). Text is written with textContent only.
 */

/** HH:MM (local time) from an ISO timestamp; '--:--' when it cannot be parsed. */
function hhmm(ts) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '--:--';
  const pad = (n) => (n < 10 ? `0${n}` : String(n));
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Create one list item with a text node (no innerHTML). */
function item(text, status) {
  const li = document.createElement('li');
  li.textContent = text;
  if (status) li.dataset.status = status;
  return li;
}

/**
 * Bind the HUD to its root element. options.onClose is called when the close button is pressed.
 * Returns { show(snapshot), hide(), isOpen() }.
 */
export function createHud(root, options = {}) {
  const part = (name) => root.querySelector(`[data-hud="${name}"]`);
  const refs = {
    name: part('name'),
    status: part('status'),
    current: part('current'),
    recent: part('recent'),
    logs: part('logs'),
    metrics: part('metrics'),
    close: part('close'),
  };
  if (refs.close && options.onClose) {
    refs.close.addEventListener('click', () => options.onClose());
  }

  /** Replace the children of a list with items, or with one placeholder line when there are none. */
  function fill(list, items, emptyText) {
    if (!list) return;
    list.textContent = '';
    if (items.length === 0) {
      list.appendChild(item(emptyText, null));
      return;
    }
    items.forEach((it) => list.appendChild(it));
  }

  /** Draw a snapshot from store.snapshot(). */
  function show(snap) {
    if (!snap || !refs.name) return;
    refs.name.textContent = snap.label;
    if (refs.status) {
      refs.status.textContent = snap.status;
      refs.status.dataset.status = snap.status;
    }
    // Open tasks: STALE? = open for longer than the store's staleMs (genuinely old, its end event may be missing).
    // ~ = the task has no tool_use_id, so its end will be matched by FIFO (approximate).
    fill(refs.current, snap.currentTasks.map((t) => {
      const li = item(`${t.stale ? 'STALE? ' : ''}${t.approx ? '~ ' : ''}${hhmm(t.ts)}  ${t.text}`, 'PROCESSING');
      if (t.stale) {
        li.dataset.stale = 'true';
        li.title = 'Open for more than 30 min with no end event.';
      }
      if (t.approx) {
        li.dataset.approx = 'true';
        li.title = `${li.title ? `${li.title} ` : ''}No tool_use_id: the end is matched by FIFO (approximate).`.trim();
      }
      return li;
    }), 'No open task');
    // Finished tasks: ~ = closed by FIFO (approximate). Exact matches have no marker.
    fill(refs.recent, snap.recentTasks.map((t) => {
      const li = item(`${t.approx ? '~ ' : ''}${t.status}  ${t.text}`, t.status);
      if (t.approx) {
        li.dataset.approx = 'true';
        li.title = 'Closed by FIFO (no tool_use_id on the end event): approximate.';
      }
      return li;
    }), 'No finished task yet');
    fill(refs.logs, snap.logs.map((l) => item(`${hhmm(l.ts)}  ${l.status}: ${l.message}`, l.status)), 'No log lines');

    if (refs.metrics) {
      refs.metrics.textContent = '';
      snap.metrics.forEach((m) => {
        const dt = document.createElement('dt');
        dt.textContent = m.label;
        const dd = document.createElement('dd');
        dd.textContent = m.text;
        if (m.text === NO_DATA) dd.classList.add('no-data');
        refs.metrics.append(dt, dd);
      });
    }
    root.hidden = false;
  }

  /** Hide the panel. */
  function hide() {
    root.hidden = true;
  }

  /** True while the panel is visible. */
  function isOpen() {
    return !root.hidden;
  }

  return { show, hide, isOpen };
}
