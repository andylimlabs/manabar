import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";

// Only the primary window polls (the endpoint rate-limits); secondary bars
// on other displays render the same data via broadcast events.
const isMain = getCurrentWebviewWindow().label === "main";

type LimitWindow = { utilization: number; resets_at: string | null };
type Limit = {
  kind: string;
  group: string;
  percent: number;
  severity: string;
  resets_at: string | null;
  scope: { model?: { display_name?: string | null } | null } | null;
};
type Usage = {
  five_hour: LimitWindow | null;
  seven_day: LimitWindow | null;
  limits?: Limit[];
};

// ?poll= override exists for harness testing only; production default is 60s
// (the usage endpoint rate-limits aggressively, do not poll faster).
const POLL_MS =
  Number(new URLSearchParams(location.search).get("poll")) || 60_000;
const RENDER_MS = 10_000;
const MAX_FAILURES = 3;
const GHOST_TTL_MS = 150_000;
const REFILL_TTL_MS = 8_000;
const REFILL_NOTE_MS = 60_000;

const bar = document.getElementById("bar")!;
const sessionbar = document.getElementById("sessionbar")!;
const ticks = document.getElementById("ticks")!;
const fill = document.getElementById("fill")!;
const fablefill = document.getElementById("fablefill")!;
const weekfill = document.getElementById("weekfill")!;
const pill = document.getElementById("pill")!;
const label = document.getElementById("label")!;

type State = {
  sessionLeft: number; // percent remaining, 0..100
  sessionReset: Date | null;
  weekLeft: number;
  fableLeft: number | null; // scoped per-model weekly, overlaps the session strip
  fableName: string;
  failures: number;
  hasData: boolean;
  refillAt: number | null;
  refillAmt: number;
};

const state: State = {
  sessionLeft: 100,
  sessionReset: null,
  weekLeft: 100,
  fableLeft: null,
  fableName: "fable",
  failures: 0,
  hasData: false,
  refillAt: null,
  refillAmt: 0,
};

// Spans live under the tick overlay so segments read as one surface.
function spawnSpan(
  host: HTMLElement,
  cls: string,
  leftPct: number,
  widthPct: number,
  ttl: number,
) {
  const el = document.createElement("div");
  el.className = cls;
  el.style.left = `${leftPct}%`;
  el.style.width = `${widthPct}%`;
  el.style.animationDuration = `${ttl}ms`;
  if (host === bar) host.insertBefore(el, ticks);
  else host.appendChild(el);
  setTimeout(() => el.remove(), ttl + 200);
}

// front edge of the weekly strip = the lower of the two weekly meters
function weekFront(week: number, fable: number | null): number {
  return fable === null ? week : Math.min(week, fable);
}

function countdown(to: Date | null): string {
  if (!to) return "?";
  let s = Math.max(0, (to.getTime() - Date.now()) / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  return `${Math.max(1, m)}m`;
}

function render() {
  if (!state.hasData) {
    label.textContent =
      state.failures >= MAX_FAILURES ? "usage unavailable" : "syncing…";
    return;
  }

  const left = state.sessionLeft;
  fill.style.width = `${Math.max(0, Math.min(100, left))}%`;
  weekfill.style.width = `${Math.max(0, Math.min(100, state.weekLeft))}%`;

  const fable = state.fableLeft;
  fablefill.style.width = fable === null ? "0%" : `${Math.max(0, Math.min(100, fable))}%`;
  // whichever weekly is lower sits in front; the taller one peeks out behind it
  const fableFront = fable !== null && fable < state.weekLeft;
  fablefill.classList.toggle("front", fableFront);
  weekfill.classList.toggle("front", !fableFront);

  const crit = left <= 10;
  const warn = !crit && left <= 30;
  fill.style.backgroundColor = crit ? "#e25a5a" : warn ? "#e0a83c" : "#5ecbba";
  pill.classList.toggle("crit", crit);
  pill.classList.toggle("warn", warn);
  pill.classList.toggle("stale", state.failures >= MAX_FAILURES);

  const sessionTxt =
    left <= 0
      ? `<span class="session">mana tapped</span> <span class="dim">· refills in ${countdown(state.sessionReset)}</span>`
      : `<span class="session">${Math.round(left)}% mana left</span> <span class="dim">· refills in ${countdown(state.sessionReset)}</span>`;
  const div = `<span class="divider"></span>`;
  const fableTxt =
    state.fableLeft === null
      ? ""
      : `${div}<span class="swatch sw-fable"></span><span class="dim">${state.fableName}</span> <span class="fable">${Math.round(state.fableLeft)}%</span>`;
  const weekTxt = `${div}<span class="swatch sw-week"></span><span class="dim">week</span> <span class="week">${Math.round(state.weekLeft)}%</span>`;
  const refillTxt =
    state.refillAt && Date.now() - state.refillAt < REFILL_NOTE_MS
      ? ` <span class="gold">+${Math.round(state.refillAmt)}% mana refilled</span>`
      : "";
  label.innerHTML = sessionTxt + fableTxt + weekTxt + refillTxt;
}

function applyUsage(raw: string) {
  {
    const usage = JSON.parse(raw) as Usage;
    const limits = usage.limits ?? [];
    const session = limits.find((l) => l.kind === "session");
    const weeklies = limits.filter((l) => l.group === "weekly");
    if (!session && !usage.five_hour) {
      throw new Error(`no meters in response: ${raw.slice(0, 120)}`);
    }
    const prevLeft = state.hasData ? state.sessionLeft : null;
    const prevWeekEdge = state.hasData
      ? weekFront(state.weekLeft, state.fableLeft)
      : null;
    if (session) {
      state.sessionLeft = 100 - session.percent;
      state.sessionReset = session.resets_at
        ? new Date(session.resets_at)
        : null;
    } else {
      state.sessionLeft = 100 - (usage.five_hour?.utilization ?? 0);
      state.sessionReset = usage.five_hour?.resets_at
        ? new Date(usage.five_hour.resets_at)
        : null;
    }
    const weekAll = weeklies.find((l) => l.kind === "weekly_all");
    const scoped = weeklies.find((l) => l.kind === "weekly_scoped");
    state.weekLeft = weekAll
      ? 100 - weekAll.percent
      : usage.seven_day
        ? 100 - usage.seven_day.utilization
        : 100;
    state.fableLeft = scoped ? 100 - scoped.percent : null;
    state.fableName = (
      scoped?.scope?.model?.display_name ?? "fable"
    ).toLowerCase();
    state.failures = 0;
    state.hasData = true;
    if (prevLeft !== null) {
      const now = state.sessionLeft;
      if (now < prevLeft - 0.01) {
        // burn since last poll: ghost lingers where the mana was
        spawnSpan(sessionbar, "ghost", now, prevLeft - now, GHOST_TTL_MS);
      } else if (now > prevLeft + 1) {
        // window reset: gold sweep over the regained span + pill note
        spawnSpan(sessionbar, "refill", prevLeft, now - prevLeft, REFILL_TTL_MS);
        state.refillAt = Date.now();
        state.refillAmt = now - prevLeft;
      }
    }
    if (prevWeekEdge !== null) {
      // ghost/refill on the weekly strip's visible front edge (the binding meter)
      const edge = weekFront(state.weekLeft, state.fableLeft);
      if (edge < prevWeekEdge - 0.01) {
        spawnSpan(bar, "ghost", edge, prevWeekEdge - edge, GHOST_TTL_MS);
      } else if (edge > prevWeekEdge + 1) {
        spawnSpan(bar, "refill", prevWeekEdge, edge - prevWeekEdge, REFILL_TTL_MS);
      }
    }
  }
  render();
}

async function refresh() {
  try {
    const raw = await invoke<string>("fetch_usage");
    applyUsage(raw);
    emit("usage-raw", raw);
  } catch (e) {
    state.failures += 1;
    console.error("usage fetch failed:", e);
    render();
  }
  // Back off while failing (e.g. the endpoint 429s) instead of hammering it.
  const delay = Math.min(POLL_MS * 2 ** state.failures, 10 * 60_000);
  setTimeout(refresh, delay);
}

if (isMain) {
  refresh();
} else {
  // Broadcasts give instant updates; the cache poll (local, no network) covers
  // missed broadcasts and late joins so every bar stays in sync.
  let lastApplied = "";
  const apply = (raw: string) => {
    if (raw === lastApplied) return;
    lastApplied = raw;
    try {
      applyUsage(raw);
    } catch (err) {
      console.error("apply failed:", err);
    }
  };
  listen<string>("usage-raw", (e) => apply(e.payload));
  const pullCache = () =>
    invoke<string | null>("cached_usage")
      .then((raw) => raw && apply(raw))
      .catch(() => {});
  pullCache();
  setInterval(pullCache, 15_000);
}
setInterval(render, RENDER_MS);

function setLabelPos(pos: string) {
  if (!["left", "center", "right"].includes(pos)) pos = "right";
  pill.classList.remove("pos-left", "pos-center", "pos-right");
  pill.classList.add(`pos-${pos}`);
}
invoke<string>("get_label_position")
  .then(setLabelPos)
  .catch(() => {});
listen<string>("label-pos", (e) => setLabelPos(e.payload));

function setLabelsOnly(on: boolean) {
  document.body.classList.toggle("labels-only", on === true);
}
invoke<boolean>("get_labels_only")
  .then(setLabelsOnly)
  .catch(() => {});
listen<boolean>("labels-only", (e) => setLabelsOnly(e.payload));
