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
type CodexWindow = { used_percent: number; reset_at?: number | null };
type CodexUsage = {
  rate_limit?: {
    primary_window?: CodexWindow | null;
    secondary_window?: CodexWindow | null;
  } | null;
} | null;

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
  sessionLeft: number; // true percent remaining (pill shows this)
  displayLeft: number; // what the fill shows: committed one poll behind
  pending: { to: number } | null;
  pendingEl: HTMLElement | null;
  sessionReset: Date | null;
  weekLeft: number;
  fableLeft: number | null; // scoped per-model weekly, overlaps the session strip
  fableName: string;
  singleMeter: boolean;
  failures: number;
  hasData: boolean;
  setupNeeded: boolean;
  providerGap: "" | "setup" | "error"; // active provider absent from a good envelope
  refillAt: number | null;
  refillAmt: number;
};

const state: State = {
  sessionLeft: 100,
  displayLeft: 100,
  pending: null,
  pendingEl: null,
  sessionReset: null,
  weekLeft: 100,
  fableLeft: null,
  fableName: "fable",
  singleMeter: false,
  failures: 0,
  hasData: false,
  setupNeeded: false,
  providerGap: "",
  refillAt: null,
  refillAmt: 0,
};

// Spans live under the tick overlay so segments read as one surface.
// ttl 0 = persistent (caller manages removal).
function spawnSpan(
  host: HTMLElement,
  cls: string,
  leftPct: number,
  widthPct: number,
  ttl: number,
): HTMLElement {
  const el = document.createElement("div");
  el.className = cls;
  el.style.left = `${leftPct}%`;
  el.style.width = `${widthPct}%`;
  if (ttl > 0) {
    el.style.animationDuration = `${ttl}ms`;
    setTimeout(() => el.remove(), ttl + 200);
  }
  if (host === bar) host.insertBefore(el, ticks);
  else host.appendChild(el);
  return el;
}

const GHOST_FADE_MS = 45_000;

// A pending drop commits on the NEXT poll: the fill drains through the
// ghost span, and the ghost starts its fade. The preview passes a short
// fade so the disappearance is actually watchable.
function commitPending(fadeMs: number = GHOST_FADE_MS) {
  if (!state.pending) return;
  state.displayLeft = state.pending.to;
  fill.classList.add("draining");
  setTimeout(() => fill.classList.remove("draining"), 2000);
  if (state.pendingEl) {
    const el = state.pendingEl;
    el.className = "ghost fading";
    el.style.animationDuration = `${fadeMs}ms`;
    setTimeout(() => el.remove(), fadeMs + 200);
  }
  state.pending = null;
  state.pendingEl = null;
}

function clearPending() {
  if (state.pendingEl) state.pendingEl.remove();
  state.pending = null;
  state.pendingEl = null;
}

// Refill choreography: fills sweep up, a shine crosses the strip, brief glow.
function playRefill(host: HTMLElement, ...fills: HTMLElement[]) {
  for (const f of fills) {
    f.classList.add("refilling");
    setTimeout(() => f.classList.remove("refilling"), 1700);
  }
  const shine = document.createElement("div");
  shine.className = "shine";
  host.appendChild(shine);
  setTimeout(() => shine.remove(), 1400);
  host.classList.add("glow");
  setTimeout(() => host.classList.remove("glow"), 1800);
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
    const providerName = provider === "codex" ? "Codex" : "Claude Code";
    label.textContent = state.setupNeeded
      ? "sign in to Claude Code or Codex to start"
      : state.providerGap === "setup"
        ? `sign in to ${providerName} to start`
        : state.providerGap === "error"
          ? `${providerName} usage unavailable`
          : state.failures >= MAX_FAILURES
            ? "usage unavailable"
            : "syncing…";
    return;
  }

  const left = state.sessionLeft;
  const shown = state.displayLeft;
  fill.style.width = `${Math.max(0, Math.min(100, shown))}%`;
  weekfill.style.width = `${Math.max(0, Math.min(100, state.weekLeft))}%`;

  const fable = state.fableLeft;
  fablefill.style.width = fable === null ? "0%" : `${Math.max(0, Math.min(100, fable))}%`;
  // whichever weekly is lower sits in front; the taller one peeks out behind it
  const fableFront = fable !== null && fable < state.weekLeft;
  fablefill.classList.toggle("front", fableFront);
  weekfill.classList.toggle("front", !fableFront);

  const crit = left <= 10;
  const warn = !crit && left <= 30;
  // fill color follows what the fill SHOWS (one poll behind); pill follows truth
  fill.style.backgroundColor =
    shown <= 10 ? "#e25a5a" : shown <= 30 ? "#e0a83c" : "#5ecbba";
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
  const weekTxt = state.singleMeter
    ? ""
    : `${div}<span class="swatch sw-week"></span><span class="dim">week</span> <span class="week">${Math.round(state.weekLeft)}%</span>`;
  const refillTxt =
    state.refillAt && Date.now() - state.refillAt < REFILL_NOTE_MS
      ? ` <span class="gold">+${Math.round(state.refillAmt)}% mana refilled</span>`
      : "";
  label.innerHTML = sessionTxt + fableTxt + weekTxt + refillTxt;
  document.body.classList.toggle("single-meter", state.singleMeter);
}

let demoRunning = false;
let demoBuffer: string | null = null;

// The HUD renders ONE provider's game at a time (Andy's call: no
// multi-sub dashboard). Both are fetched; this picks the active one.
let provider: "claude" | "codex" = "claude";
let lastGoodRaw: string | null = null;

type Meters = {
  sessionLeft: number;
  sessionReset: Date | null;
  weekLeft: number;
  fableLeft: number | null;
  fableName: string;
  singleMeter: boolean;
};

function mapClaude(usage: Usage, raw: string): Meters {
  const limits = usage.limits ?? [];
  const session = limits.find((l) => l.kind === "session");
  const weeklies = limits.filter((l) => l.group === "weekly");
  if (!session && !usage.five_hour) {
    throw new Error(`no meters in response: ${raw.slice(0, 120)}`);
  }
  const weekAll = weeklies.find((l) => l.kind === "weekly_all");
  const scoped = weeklies.find((l) => l.kind === "weekly_scoped");
  return {
    sessionLeft: session
      ? 100 - session.percent
      : 100 - (usage.five_hour?.utilization ?? 0),
    sessionReset: session?.resets_at
      ? new Date(session.resets_at)
      : usage.five_hour?.resets_at
        ? new Date(usage.five_hour.resets_at)
        : null,
    weekLeft: weekAll
      ? 100 - weekAll.percent
      : usage.seven_day
        ? 100 - usage.seven_day.utilization
        : 100,
    fableLeft: scoped ? 100 - scoped.percent : null,
    fableName: (scoped?.scope?.model?.display_name ?? "fable").toLowerCase(),
    singleMeter: false,
  };
}

function mapCodex(codex: CodexUsage, raw: string): Meters {
  const rl = codex?.rate_limit;
  const primary = rl?.primary_window ?? null;
  const secondary = rl?.secondary_window ?? null;
  if (!primary && !secondary) {
    throw new Error(`no codex meters in response: ${raw.slice(0, 120)}`);
  }
  // secondary (short window) plays the mana bar when present; primary
  // (weekly) is the strip. With only one window, the strip hides.
  const mana = (secondary ?? primary) as CodexWindow;
  const week = secondary ? primary : null;
  const toDate = (w: CodexWindow | null) =>
    w?.reset_at ? new Date(w.reset_at * 1000) : null;
  return {
    sessionLeft: 100 - mana.used_percent,
    sessionReset: toDate(mana),
    weekLeft: week ? 100 - week.used_percent : 100,
    fableLeft: null,
    fableName: "fable",
    singleMeter: !week,
  };
}

function applyUsage(raw: string) {
  if (demoRunning) {
    demoBuffer = raw;
    return;
  }
  const parsed = JSON.parse(raw);
  const isEnvelope =
    parsed && typeof parsed === "object" && ("claude" in parsed || "codex" in parsed);
  const usage = (isEnvelope ? parsed.claude : parsed) as Usage | null;
  const codex = (isEnvelope ? parsed.codex : null) as CodexUsage;
  if (!usage && !codex) {
    throw new Error(`no providers in response: ${raw.slice(0, 120)}`);
  }
  let m: Meters | null = null;
  if (provider === "codex") {
    if (codex?.rate_limit) m = mapCodex(codex, raw);
  } else if (usage) {
    m = mapClaude(usage, raw);
  }
  lastGoodRaw = raw;
  if (!m) {
    // active provider missing from an otherwise good envelope: say so,
    // never render the other provider's numbers under this label
    const err = String(
      (isEnvelope &&
        (provider === "codex" ? parsed.codex_error : parsed.claude_error)) ||
        "",
    );
    state.hasData = false;
    state.providerGap = err.startsWith("no-creds") ? "setup" : "error";
    state.failures = 0;
    render();
    return;
  }
  {
    const prevLeft = state.hasData ? state.sessionLeft : null;
    const prevWeekEdge = state.hasData
      ? weekFront(state.weekLeft, state.fableLeft)
      : null;
    state.sessionLeft = m.sessionLeft;
    state.sessionReset = m.sessionReset;
    state.weekLeft = m.weekLeft;
    state.fableLeft = m.fableLeft;
    state.fableName = m.fableName;
    state.singleMeter = m.singleMeter;
    if (prevLeft !== null) {
      const now = state.sessionLeft;
      if (now > prevLeft + 1) {
        // window reset: fill sweeps back up with shine + glow + gold + note
        clearPending();
        playRefill(sessionbar, fill);
        spawnSpan(sessionbar, "refill", state.displayLeft, now - state.displayLeft, REFILL_TTL_MS);
        state.displayLeft = now;
        state.refillAt = Date.now();
        state.refillAmt = now - prevLeft;
      } else {
        // two-phase drop: commit the previous pending (fill drains through
        // its ghost), then open a new pending for this poll's drop
        if (state.pending) commitPending();
        if (now < state.displayLeft - 0.01) {
          state.pendingEl = spawnSpan(
            sessionbar,
            "ghost pending",
            now,
            state.displayLeft - now,
            0,
          );
          state.pending = { to: now };
        }
      }
    } else {
      state.displayLeft = state.sessionLeft;
    }
    if (prevWeekEdge !== null) {
      // ghost/refill on the weekly strip's visible front edge (the binding meter)
      const edge = weekFront(state.weekLeft, state.fableLeft);
      if (edge < prevWeekEdge - 0.01) {
        spawnSpan(bar, "ghost", edge, prevWeekEdge - edge, GHOST_TTL_MS);
      } else if (edge > prevWeekEdge + 1) {
        // weekly reset: same fill-up choreography on the weekly strip
        playRefill(bar, weekfill, fablefill);
        spawnSpan(bar, "refill", prevWeekEdge, edge - prevWeekEdge, REFILL_TTL_MS);
      }
    }
  }
  state.failures = 0;
  state.setupNeeded = false;
  state.providerGap = "";
  state.hasData = true;
  render();
}

async function refresh() {
  try {
    const raw = await invoke<string>("fetch_usage");
    applyUsage(raw);
    emit("usage-raw", raw);
  } catch (e) {
    state.failures += 1;
    state.setupNeeded = String(e).includes("no-providers");
    console.error("usage fetch failed:", e);
    render();
  }
  // Back off while failing (e.g. the endpoint 429s) instead of hammering it.
  const delay = Math.min(POLL_MS * 2 ** state.failures, 10 * 60_000);
  setTimeout(refresh, delay);
}

if (isMain) {
  // Paint the disk-cached payload instantly (restart amnesia fix); the
  // fresh fetch corrects it moments later.
  invoke<string | null>("cached_usage")
    .then((raw) => {
      if (raw && !state.hasData) {
        try {
          applyUsage(raw);
        } catch {
          // stale cache shape mismatch: the fetch will supply good data
        }
      }
    })
    .catch(() => {});
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

function setHudMode(mode: string) {
  document.body.classList.toggle("minimal", mode === "minimal");
}
invoke<string>("get_hud_mode")
  .then(setHudMode)
  .catch(() => {});
listen<string>("hud-mode", (e) => setHudMode(e.payload));

// Scripted preview of every animation, played on the live bars, then the
// real state is restored instantly. Compressed timeline: "polls" 2.6s apart.
function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function runDemo() {
  if (demoRunning || !state.hasData) return;
  demoRunning = true;
  const snap = {
    sessionLeft: state.sessionLeft,
    displayLeft: state.displayLeft,
    weekLeft: state.weekLeft,
    fableLeft: state.fableLeft,
    refillAt: state.refillAt,
    refillAmt: state.refillAmt,
  };
  clearPending();
  state.sessionLeft = 74;
  state.displayLeft = 74;
  state.weekLeft = 83;
  state.fableLeft = 69;
  render();
  await sleep(800);
  // poll 1: drop detected. Numbers update, ghost marks the span, fill holds.
  state.sessionLeft = 65;
  state.pendingEl = spawnSpan(sessionbar, "ghost pending", 65, 9, 0);
  state.pending = { to: 65 };
  render();
  await sleep(2600);
  // poll 2: commit (fill drains through the ghost, ghost fades visibly);
  // a smaller drop pends.
  commitPending(1500);
  state.sessionLeft = 61;
  state.pendingEl = spawnSpan(sessionbar, "ghost pending", 61, 4, 0);
  state.pending = { to: 61 };
  render();
  await sleep(2600);
  // poll 3: commit the second drop, then let the ghosts finish vanishing
  // so the bar is visibly clean before the refill.
  commitPending(1500);
  render();
  await sleep(3400);
  // session refill: sweep up + shine + glow + short gold, then HOLD the
  // settled bar in its original color before moving on.
  clearPending();
  playRefill(sessionbar, fill);
  spawnSpan(sessionbar, "refill", state.displayLeft, 100 - state.displayLeft, 2000);
  state.refillAt = Date.now();
  state.refillAmt = 100 - state.sessionLeft;
  state.sessionLeft = 100;
  state.displayLeft = 100;
  render();
  await sleep(4600);
  // weekly reset: same choreography, same settled hold after.
  const edge = weekFront(state.weekLeft, state.fableLeft);
  playRefill(bar, weekfill, fablefill);
  spawnSpan(bar, "refill", edge, 100 - edge, 2000);
  state.weekLeft = 100;
  state.fableLeft = 100;
  render();
  await sleep(4600);
  // restore reality with animations suppressed.
  document.body.classList.add("noanim");
  document.querySelectorAll(".ghost, .refill, .shine").forEach((el) => el.remove());
  state.sessionLeft = snap.sessionLeft;
  state.displayLeft = snap.displayLeft;
  state.weekLeft = snap.weekLeft;
  state.fableLeft = snap.fableLeft;
  state.refillAt = snap.refillAt;
  state.refillAmt = snap.refillAmt;
  render();
  await sleep(80);
  document.body.classList.remove("noanim");
  demoRunning = false;
  if (demoBuffer) {
    const buffered = demoBuffer;
    demoBuffer = null;
    applyUsage(buffered);
  }
}
listen("demo", () => {
  runDemo();
});
// harness/testing hook: same sequence without the tray
window.addEventListener("manabar-demo", () => {
  runDemo();
});

// Provider switch: reset the display instantly (no bogus delta animations)
// and re-map the last good payload under the new provider.
function setProvider(p: string) {
  const next = p === "codex" ? "codex" : "claude";
  if (next === provider) return;
  provider = next;
  clearPending();
  document.querySelectorAll(".ghost, .refill, .shine").forEach((el) => el.remove());
  state.hasData = false;
  state.providerGap = "";
  document.body.classList.add("noanim");
  if (lastGoodRaw) {
    try {
      applyUsage(lastGoodRaw);
    } catch {
      // active provider absent from the payload: next poll will populate
    }
  }
  render();
  setTimeout(() => document.body.classList.remove("noanim"), 80);
}
invoke<string>("get_provider")
  .then(setProvider)
  .catch(() => {});
listen<string>("provider", (e) => setProvider(e.payload));

function setHudSize(size: string) {
  document.body.classList.remove("size-compact", "size-large");
  if (size === "compact" || size === "large") {
    document.body.classList.add(`size-${size}`);
  }
}
invoke<string>("get_hud_size")
  .then(setHudSize)
  .catch(() => {});
listen<string>("hud-size", (e) => setHudSize(e.payload));
