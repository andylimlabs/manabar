import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
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
const pill = document.getElementById("pill")!;
const label = document.getElementById("label")!;

// A curated strip meter: the registry in each provider mapper decides what
// exists, with a chosen label and color. EXPANDABLE, not dynamic: a new
// API dimension gets rendered only when an entry is added for it.
type StripMeter = {
  key: string;
  label: string;
  left: number; // percent remaining
  color: string; // fill color
  textColor: string; // pill value color
  reset?: Date | null; // shown in the pill only when there is no mana pool
};

// generated strip fill elements, keyed by meter key
const stripEls = new Map<string, HTMLElement>();

type State = {
  sessionLeft: number | null; // true percent remaining; null = no session pool
  displayLeft: number; // what the fill shows: committed one poll behind
  pending: { to: number } | null;
  pendingEl: HTMLElement | null;
  sessionReset: Date | null;
  strip: StripMeter[];
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
  strip: [],
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

// front edge of the strip = the lowest remaining among its meters
function stripFront(strip: StripMeter[]): number {
  return strip.length ? Math.min(...strip.map((m) => m.left)) : 100;
}

// THE LEXICON PIVOT: every mode-dependent string lives here, and only
// here. Adding or changing wording means editing both variants of one
// entry — the two modes cannot structurally drift apart.
type Lexicon = {
  session: (left: number, cd: string) => string;
  refillNote: (amt: number, isWeek: boolean) => string;
};

const LEXICONS: Record<"plain" | "gamer", Lexicon> = {
  plain: {
    session: (left, cd) =>
      `<span class="swatch" style="background:#5ecbba"></span><span class="dim">session</span> <span class="session">${left <= 0 ? "tapped" : `${Math.round(left)}%`}</span> <span class="dim">· refills in ${cd}</span>`,
    refillNote: (amt, isWeek) =>
      `+${amt}% ${isWeek ? "week" : "session"} refilled`,
  },
  gamer: {
    session: (left, cd) =>
      left <= 0
        ? `<span class="session">mana tapped</span> <span class="dim">· refills in ${cd}</span>`
        : `<span class="session">${Math.round(left)}% mana left</span> <span class="dim">· refills in ${cd}</span>`,
    refillNote: (amt, isWeek) => `+${amt}% ${isWeek ? "week" : "mana"} refilled`,
  },
};

let gamerMode = false;
function lex(): Lexicon {
  return LEXICONS[gamerMode ? "gamer" : "plain"];
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
  document.body.classList.toggle("no-mana", left === null);
  if (left !== null) {
    fill.style.width = `${Math.max(0, Math.min(100, shown))}%`;
  }

  // reconcile generated strip fills against the curated meter list;
  // lowest remaining renders in front, the taller ones peek out behind
  const liveKeys = new Set(state.strip.map((m) => m.key));
  for (const [key, el] of stripEls) {
    if (!liveKeys.has(key)) {
      el.remove();
      stripEls.delete(key);
    }
  }
  const byFront = [...state.strip].sort((a, b) => a.left - b.left);
  byFront.forEach((m, idx) => {
    let el = stripEls.get(m.key);
    if (!el) {
      el = document.createElement("div");
      el.className = "stripfill";
      bar.insertBefore(el, ticks);
      stripEls.set(m.key, el);
    }
    el.style.width = `${Math.max(0, Math.min(100, m.left))}%`;
    el.style.backgroundColor = m.color;
    el.style.zIndex = String(Math.max(1, 3 - idx));
  });

  const crit = left !== null && left <= 10;
  const warn = !crit && left !== null && left <= 30;
  if (left !== null) {
    // fill color follows what the fill SHOWS (one poll behind); pill truth
    fill.style.backgroundColor =
      shown <= 10 ? "#e25a5a" : shown <= 30 ? "#e0a83c" : "#5ecbba";
  }
  pill.classList.toggle("crit", crit);
  pill.classList.toggle("warn", warn);
  pill.classList.toggle("stale", state.failures >= MAX_FAILURES);

  const sessionTxt =
    left === null ? "" : lex().session(left, countdown(state.sessionReset));
  // pill grammar: the hairline divider separates timescale GROUPS (session
  // vs weekly); dots punctuate within a group, ending with the group reset
  const div = `<span class="divider"></span>`;
  let stripTxt = "";
  if (state.strip.length) {
    const entries = state.strip.map(
      (m) =>
        `<span class="swatch" style="background:${m.color}"></span><span class="dim">${m.label}</span> <span style="color:${m.textColor};font-weight:600">${Math.round(m.left)}%</span>`,
    );
    const groupReset = state.strip.find((m) => m.reset)?.reset ?? null;
    const resetTxt = groupReset
      ? ` <span class="dim">· resets in ${countdown(groupReset)}</span>`
      : "";
    stripTxt =
      (sessionTxt === "" ? "" : div) +
      entries.join(`<span class="gap"></span>`) +
      resetTxt;
  }
  const refillTxt =
    state.refillAt && Date.now() - state.refillAt < REFILL_NOTE_MS
      ? ` <span class="gold">${lex().refillNote(Math.round(state.refillAmt), left === null)}</span>`
      : "";
  label.innerHTML = sessionTxt + stripTxt + refillTxt;
  document.body.classList.toggle("single-meter", state.strip.length === 0);
}

let demoRunning = false;
let demoBuffer: string | null = null;

// The HUD renders ONE provider's game at a time (Andy's call: no
// multi-sub dashboard). Both are fetched; this picks the active one.
let provider: "claude" | "codex" = "claude";
let lastGoodRaw: string | null = null;

type Meters = {
  sessionLeft: number | null; // null = provider has no session-based pool
  sessionReset: Date | null;
  strip: StripMeter[];
};

// The ONLY API-derived string that reaches innerHTML. Strict allowlist:
// anything outside it is dropped, so markup can never ride in on a
// model display name (from the network or a tampered disk cache).
function sanitizeLabel(s: string): string {
  const clean = s
    .toLowerCase()
    .replace(/[^a-z0-9 _.-]/g, "")
    .trim()
    .slice(0, 24);
  return clean || "scoped";
}

// Meter colors, curated. Add a color when adding a registry entry.
const COLOR_WEEK = "#6e7bf2";
const COLOR_WEEK_TEXT = "#98a2ff";
const COLOR_SCOPED = "#d97757";
const COLOR_SCOPED_TEXT = "#e39068";

// The claude meter registry: session plays the mana bar; each entry added
// to `strip` here is one fill + one pill readout. To support a new limit
// dimension, add an entry: key, label, color, extraction.
function mapClaude(usage: Usage, raw: string): Meters {
  const limits = usage.limits ?? [];
  const session = limits.find((l) => l.kind === "session");
  const weeklies = limits.filter((l) => l.group === "weekly");
  if (!session && !usage.five_hour) {
    throw new Error(`no meters in response: ${raw.slice(0, 120)}`);
  }
  const weekAll = weeklies.find((l) => l.kind === "weekly_all");
  const scoped = weeklies.filter((l) => l.kind === "weekly_scoped");
  // registry order = pill order: binding scoped meter first, then week
  const strip: StripMeter[] = [];
  if (scoped[0]) {
    strip.push({
      key: "scoped",
      label: sanitizeLabel(scoped[0].scope?.model?.display_name ?? "scoped"),
      left: 100 - scoped[0].percent,
      color: COLOR_SCOPED,
      textColor: COLOR_SCOPED_TEXT,
      reset: scoped[0].resets_at ? new Date(scoped[0].resets_at) : null,
    });
  }
  if (weekAll || usage.seven_day) {
    strip.push({
      key: "week",
      label: "week",
      left: weekAll
        ? 100 - weekAll.percent
        : 100 - (usage.seven_day?.utilization ?? 0),
      color: COLOR_WEEK,
      textColor: COLOR_WEEK_TEXT,
      reset: weekAll?.resets_at
        ? new Date(weekAll.resets_at)
        : usage.seven_day?.resets_at
          ? new Date(usage.seven_day.resets_at)
          : null,
    });
  }
  // expandable, not dynamic: surface unknowns for a deliberate registry
  // addition instead of auto-rendering them
  for (const extra of scoped.slice(1)) {
    console.warn("manabar: unrendered scoped meter", extra.scope?.model?.display_name);
  }
  for (const l of limits) {
    if (!["session", "weekly_all", "weekly_scoped"].includes(l.kind)) {
      console.warn("manabar: unknown limit kind", l.kind);
    }
  }
  return {
    sessionLeft: session
      ? 100 - session.percent
      : 100 - (usage.five_hour?.utilization ?? 0),
    sessionReset: session?.resets_at
      ? new Date(session.resets_at)
      : usage.five_hour?.resets_at
        ? new Date(usage.five_hour.resets_at)
        : null,
    strip,
  };
}

// The codex meter registry: the weekly (primary) is always the strip, in
// its natural indigo home; the mana bar exists only when the plan has a
// session-style short window (secondary). No hacky slot borrowing.
function mapCodex(codex: CodexUsage, raw: string): Meters {
  const rl = codex?.rate_limit;
  const primary = rl?.primary_window ?? null;
  const secondary = rl?.secondary_window ?? null;
  if (!primary && !secondary) {
    throw new Error(`no codex meters in response: ${raw.slice(0, 120)}`);
  }
  const toDate = (w: CodexWindow | null) =>
    w?.reset_at ? new Date(w.reset_at * 1000) : null;
  const strip: StripMeter[] = [];
  if (primary) {
    strip.push({
      key: "week",
      label: "week",
      left: 100 - primary.used_percent,
      color: COLOR_WEEK,
      textColor: COLOR_WEEK_TEXT,
      reset: toDate(primary),
    });
  }
  return {
    sessionLeft: secondary ? 100 - secondary.used_percent : null,
    sessionReset: toDate(secondary),
    strip,
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
    const prevWeekEdge = state.hasData ? stripFront(state.strip) : null;
    state.sessionLeft = m.sessionLeft;
    state.sessionReset = m.sessionReset;
    state.strip = m.strip;
    if (m.sessionLeft === null) {
      clearPending();
    } else if (prevLeft !== null) {
      const now = m.sessionLeft;
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
      state.displayLeft = state.sessionLeft ?? 100;
    }
    if (prevWeekEdge !== null && state.strip.length) {
      // ghost/refill on the strip's visible front edge (the binding meter)
      const edge = stripFront(state.strip);
      if (edge < prevWeekEdge - 0.01) {
        spawnSpan(bar, "ghost", edge, prevWeekEdge - edge, GHOST_TTL_MS);
      } else if (edge > prevWeekEdge + 1) {
        // weekly reset: same fill-up choreography on the strip; with no
        // mana pool the pill note speaks for the week
        playRefill(bar, ...stripEls.values());
        spawnSpan(bar, "refill", prevWeekEdge, edge - prevWeekEdge, REFILL_TTL_MS);
        if (state.sessionLeft === null) {
          state.refillAt = Date.now();
          state.refillAmt = edge - prevWeekEdge;
        }
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
  // Secondaries read ONLY the authoritative Rust cache (local, no network,
  // no spoofable window-to-window events). 5s poll = imperceptible lag on
  // 60s data.
  let lastApplied = "";
  const pullCache = () =>
    invoke<string | null>("cached_usage")
      .then((raw) => {
        if (!raw || raw === lastApplied) return;
        lastApplied = raw;
        try {
          applyUsage(raw);
        } catch (err) {
          console.error("apply failed:", err);
        }
      })
      .catch(() => {});
  pullCache();
  setInterval(pullCache, 5_000);
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
    strip: state.strip.map((m) => ({ ...m })),
    refillAt: state.refillAt,
    refillAmt: state.refillAmt,
  };
  clearPending();
  const hasMana = state.sessionLeft !== null;
  if (hasMana) {
    state.sessionLeft = 74;
    state.displayLeft = 74;
  }
  const demoLefts = [83, 69];
  state.strip = state.strip.map((m, i) => ({ ...m, left: demoLefts[i] ?? m.left }));
  render();
  await sleep(800);
  if (hasMana) {
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
    state.refillAmt = 100 - (state.sessionLeft ?? 0);
    state.sessionLeft = 100;
    state.displayLeft = 100;
    render();
    await sleep(4600);
  }
  // weekly reset: same choreography, same settled hold after (skipped for
  // single-meter providers with no strip).
  if (state.strip.length) {
    const edge = stripFront(state.strip);
    playRefill(bar, ...stripEls.values());
    spawnSpan(bar, "refill", edge, 100 - edge, 2000);
    state.strip = state.strip.map((m) => ({ ...m, left: 100 }));
    render();
    await sleep(4600);
  }
  // restore reality with animations suppressed.
  document.body.classList.add("noanim");
  document.querySelectorAll(".ghost, .refill, .shine").forEach((el) => el.remove());
  state.sessionLeft = snap.sessionLeft;
  state.displayLeft = snap.displayLeft;
  state.strip = snap.strip;
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

function setGamerMode(on: boolean) {
  gamerMode = on === true;
  render();
}
invoke<boolean>("get_gamer_mode")
  .then(setGamerMode)
  .catch(() => {});
listen<boolean>("gamer-mode", (e) => setGamerMode(e.payload));

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
