/* Werewolf Stream — omniscient spectator for AI-vs-AI werewolf games.
 * Plain static script (deliberately NOT an ES module so file:// keeps working).
 * No build step, no dependencies.
 *
 * Data contract (see games/sample.jsonl):
 *   games.json          -> { updated_at, live, games: [{id, file, started_at, status, ...}] }
 *   games/<id>.jsonl    -> one JSON object per line:
 *     game_start  { players: {Seat: {name, role, model}}, player_count, ... }
 *     turn_start  { step, day, phase, active_player, model }
 *     turn_result { step, day, phase, status, elimination_log: [], detail: {...} }
 *     game_over   { winner: "village"|"werewolves", players, ... }
 */
"use strict";

/* ================= configuration ================= */

const DEFAULT_API_BASE = "https://werewolf.gr33n.lol";
const LIST_POLL_MS = 15_000; // games.json refresh cadence
const TRANSCRIPT_POLL_MS = 5_000; // live transcript refresh cadence

// API base: ?api=https://host override, trailing slashes stripped.
const API_BASE = (() => {
  const override = new URLSearchParams(location.search).get("api");
  const base = override && override.trim() ? override.trim() : DEFAULT_API_BASE;
  return base.replace(/\/+$/, "");
})();

/* ================= vocabulary ================= */

const ROLE_ICONS = {
  werewolf: "\u{1F43A}", // wolf
  villager: "\u{1F33E}", // sheaf of rice
  doctor: "\u{1FA7A}", // stethoscope
  seer: "\u{1F52E}", // crystal ball
};
const DEFAULT_ROLE_ICON = "\u{1F9D1}"; // person

const ROLE_TITLES = {
  werewolf: "Werewolf",
  villager: "Villager",
  doctor: "Doctor",
  seer: "Seer",
};

// Flavour only — a stable epithet per name, so a seat reads as a character
// rather than a row in a table. Deterministic: same name, same epithet.
const EPITHETS = [
  "the Wary",
  "the Quiet",
  "the Bold",
  "the Restless",
  "the Kind",
  "the Sly",
  "the Grim",
  "the Curious",
  "the Steadfast",
  "the Somber",
  "the Keen",
  "the Weary",
  "the Stubborn",
  "the Gentle",
  "the Sharp",
  "the Hollow",
  "the Watchful",
  "the Brash",
  "the Patient",
  "the Uneasy",
];

const PHASE_LABELS = {
  wolf_discussion: "Wolf Council",
  night: "Night",
  last_words_night: "Last Words",
  private_meeting: "Private Meeting",
  day_discussion: "Village Discussion",
  day_voting: "The Vote",
  runoff_discussion: "Runoff Discussion",
  day_trial: "Trial",
  last_words_day: "Last Words",
  reveal: "Reveal",
};

const WINNER_LABELS = {
  village: "The village prevails",
  werewolves: "The werewolves feast",
};

// Transcripts say "villagers"; games.json says "village". Normalise both.
function canonicalWinner(w) {
  if (!w) return null;
  const s = String(w).toLowerCase();
  if (s.includes("wolf") || s.includes("wolves")) return "werewolves";
  if (s.includes("village")) return "village";
  return s;
}

/* ================= tiny DOM helpers ================= */

const $ = (sel) => document.querySelector(sel);

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

function roleIcon(role) {
  return ROLE_ICONS[role] || DEFAULT_ROLE_ICON;
}

function roleTitle(role) {
  if (!role) return "Unknown";
  return ROLE_TITLES[role] || role.replace(/\b\w/g, (c) => c.toUpperCase());
}

/* ================= characters =================
 * Every seat gets one stable visual identity, derived from its display name so
 * the same player looks the same in the roster, the feed, the tally, the
 * elimination banner and the winner card. Identity = tinted disc + initials
 * (always distinct, no emoji font needed); role = the ring colour and the
 * sigil badge; death = drained colours plus a skull veil.
 */

// FNV-1a: small, stable across browsers, good spread for short names.
function hashName(s) {
  let h = 0x811c9dc5;
  const str = String(s || "");
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function hueFor(name) {
  return hashName(name) % 360;
}

function epithetFor(name) {
  return EPITHETS[hashName(name + "") % EPITHETS.length];
}

function initialsOf(name) {
  const s = String(name || "?").trim();
  const words = s.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  const w = words[0] || s;
  return w.slice(0, 2).toUpperCase() || "?";
}

// Seat -> display values. Seats are the transcript's keys; `name` is often null.
function seatName(spec, seat) {
  const p = spec && spec.players ? spec.players[seat] : null;
  return (p && p.name) || String(seat == null ? "?" : seat);
}

function seatRole(spec, seat) {
  const p = spec && spec.players ? spec.players[seat] : null;
  return (p && p.role) || "";
}

function seatIsDead(spec, seat) {
  return !!(spec && spec.dead && spec.dead.has(seat));
}

// The avatar itself: <span class="avatar av-md role-seer" style="--hue:210">.
function avatarNode(name, role, dead, size) {
  const node = el(
    "span",
    `avatar av-${size || "md"} role-${role || "unknown"}${dead ? " is-dead" : ""}`,
  );
  node.style.setProperty("--hue", String(hueFor(name)));
  node.setAttribute("role", "img");
  node.setAttribute(
    "aria-label",
    `${name} — ${roleTitle(role)}${dead ? ", dead" : ""}`,
  );
  node.title = `${name} · ${roleTitle(role)}${dead ? " · dead" : ""}`;
  const ini = el("span", "avatar-ini", initialsOf(name));
  ini.setAttribute("aria-hidden", "true");
  const badge = el("span", "avatar-badge", roleIcon(role));
  badge.setAttribute("aria-hidden", "true");
  node.append(ini, badge);
  return node;
}

// Avatar + name, for use inline in narration and in dense rows.
function charChip(spec, seat, size, opts) {
  const o = opts || {};
  const name = seatName(spec, seat);
  const role = seatRole(spec, seat);
  const dead = o.dead != null ? o.dead : seatIsDead(spec, seat);
  const chip = el("span", `char${dead ? " is-dead" : ""}`);
  chip.append(avatarNode(name, o.role || role, dead, size || "sm"));
  chip.append(el("span", "char-name", name));
  if (o.suffix) chip.append(el("span", "char-suffix", o.suffix));
  return chip;
}

function labelPhase(phase) {
  if (!phase) return "";
  return (
    PHASE_LABELS[phase] ||
    phase.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
  );
}

function shortModel(model) {
  if (!model) return "";
  const s = String(model);
  return s.includes("/") ? s.slice(s.lastIndexOf("/") + 1) : s;
}

function fmtTime(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return "";
  return d.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function fmtDate(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return String(iso || "");
  return d.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/* ================= state ================= */

const state = {
  mode: null, // "online" | "demo"
  games: [], // newest first, from games.json (or the demo card)
  liveId: null,
  spectator: null, // active spectator session, or null on home view
  listTimer: null,
  transcriptTimer: null,
};

function apiUrl(path) {
  return API_BASE + "/" + String(path).replace(/^\/+/, "");
}

async function fetchText(url) {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

async function fetchJson(url) {
  return JSON.parse(await fetchText(url));
}

/* ================= boot & data loading ================= */

async function boot() {
  window.addEventListener("hashchange", route);
  const castToggle = $("#cast-toggle");
  if (castToggle) {
    castToggle.addEventListener("click", () => {
      const roster = $("#roster");
      setCastCollapsed(!(roster && roster.classList.contains("is-collapsed")));
    });
  }
  try {
    const data = await fetchJson(apiUrl("games.json"));
    state.mode = "online";
    state.games = Array.isArray(data.games) ? data.games : [];
    state.liveId = data.live != null ? data.live : null;
    startListPolling();
  } catch (err) {
    // API unreachable -> offline demo built from the bundled sample.
    state.mode = "demo";
    state.games = [await loadDemoMeta()];
    setNetStatus("offline demo");
  }
  route();
}

function setNetStatus(text) {
  $("#net-status").textContent = text || "";
}

// Build a game-card's metadata by scanning the bundled sample transcript.
async function loadDemoMeta() {
  const lines = await loadSampleLines();
  return deriveMetaFromLines("sample", "games/sample.jsonl", lines);
}

async function loadSampleLines() {
  try {
    const text = await fetchText("games/sample.jsonl");
    return text.split("\n").filter((l) => l.trim());
  } catch (err) {
    // file:// pages cannot fetch local files; use the embedded mirror.
    return EMBEDDED_SAMPLE_LINES.slice();
  }
}

function deriveMetaFromLines(id, file, lines) {
  const meta = {
    id,
    file,
    started_at: null,
    status: "finished", // the demo never polls; treat the archive as complete
    player_count: 0,
    players: {},
    winner: null,
    steps: 0,
    demo: true,
  };
  for (const line of lines) {
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (ev.type === "game_start") {
      meta.started_at = ev.timestamp || null;
      meta.player_count =
        ev.player_count || Object.keys(ev.players || {}).length;
      meta.players = ev.players || {};
    } else if (ev.type === "turn_result") {
      meta.steps += 1;
    } else if (ev.type === "game_over") {
      meta.winner = canonicalWinner(ev.winner);
      if (ev.players) meta.players = ev.players;
    }
  }
  return meta;
}

/* ================= routing ================= */

function route() {
  const m = location.hash.match(/^#\/game\/(.+)$/);
  if (m) showGame(decodeURIComponent(m[1]));
  else showHome();
}

function showHome() {
  stopTranscriptPolling();
  state.spectator = null;
  $("#game-view").hidden = true;
  $("#home-view").hidden = false;
  renderGameList();
}

function showGame(id) {
  $("#home-view").hidden = true;
  $("#game-view").hidden = false;

  const meta = state.games.find((g) => g.id === id) || {
    id,
    file: `games/${encodeURIComponent(id)}.jsonl`,
    status: id === state.liveId ? "live" : "finished",
    players: {},
  };

  const spec = newSpectator(meta);
  state.spectator = spec;
  resetGameView(spec);
  stopTranscriptPolling();

  loadTranscript(spec).then(() => {
    if (
      state.mode === "online" &&
      spec.meta.status === "live" &&
      !spec.finished
    ) {
      startTranscriptPolling();
    }
  });
}

/* ================= polling =================
 * Two tiny loops:
 *   - the game list refreshes every LIST_POLL_MS while online;
 *   - a live game's transcript refreshes every TRANSCRIPT_POLL_MS while viewed.
 * Both are plain full refetches; the transcript side only *renders* new lines.
 */

function startListPolling() {
  stopListPolling();
  state.listTimer = setInterval(pollGameList, LIST_POLL_MS);
}

function stopListPolling() {
  if (state.listTimer) {
    clearInterval(state.listTimer);
    state.listTimer = null;
  }
}

async function pollGameList() {
  if (state.mode !== "online") return;
  let data;
  try {
    data = await fetchJson(apiUrl("games.json"));
  } catch {
    return;
  } // transient failure: keep showing stale data
  state.games = Array.isArray(data.games) ? data.games : [];
  state.liveId = data.live != null ? data.live : null;

  const spec = state.spectator;
  if (!spec) {
    renderGameList();
    return;
  }

  // If the open game just flipped to finished, grab the tail once and stop.
  const fresh = state.games.find((g) => g.id === spec.meta.id);
  if (fresh) {
    spec.meta = fresh;
    renderGameStatusBadge(spec);
    if (fresh.status !== "live" && state.transcriptTimer) {
      await loadTranscript(spec);
      stopTranscriptPolling();
    }
  }
}

function startTranscriptPolling() {
  stopTranscriptPolling();
  state.transcriptTimer = setInterval(pollTranscript, TRANSCRIPT_POLL_MS);
}

function stopTranscriptPolling() {
  if (state.transcriptTimer) {
    clearInterval(state.transcriptTimer);
    state.transcriptTimer = null;
  }
}

async function pollTranscript() {
  const spec = state.spectator;
  if (!spec) {
    stopTranscriptPolling();
    return;
  }
  await loadTranscript(spec);
  if (spec.finished) stopTranscriptPolling();
}

/* ================= spectator session ================= */

function newSpectator(meta) {
  return {
    meta,
    players: meta.players || {}, // Seat -> {name, role, model}
    order: Object.keys(meta.players || {}),
    dead: new Map(), // Seat -> elimination entry
    day: null,
    phase: null,
    activePlayer: null,
    winner: canonicalWinner(meta.winner),
    finished: false,
    lineCount: 0, // transcript lines already rendered
    seenNightActions: new Set(), // dedupe the cumulative night_actions map
    seenElims: new Set(), // dedupe the cumulative elimination_log
    feedEl: $("#feed"),
    rosterEl: $("#roster"),
  };
}

function resetGameView(spec) {
  $("#game-id").textContent = spec.meta.id;
  clear($("#phase-banner"));
  const wb = $("#winner-banner");
  wb.hidden = true;
  wb.className = "winner-banner";
  clear(wb);
  clear(spec.feedEl);
  clear(spec.rosterEl);
  const castHead = $("#cast-head");
  if (castHead) castHead.hidden = true;
  setCastCollapsed(false); // a fresh game always opens with the cast on show
  renderGameStatusBadge(spec);
  if (spec.meta.status !== "live") renderRoster(spec);
  if (spec.winner) showWinner(spec, spec.winner);
}

function renderGameStatusBadge(spec) {
  const badge = $("#game-status");
  const live = spec.meta.status === "live" && !spec.finished;
  badge.className =
    "status-badge" + (live ? " is-live" : spec.meta.demo ? " is-demo" : "");
  badge.textContent = live
    ? "live"
    : spec.meta.demo
      ? "offline demo"
      : "finished";
}

async function loadTranscript(spec) {
  const path =
    spec.meta.file || `games/${encodeURIComponent(spec.meta.id)}.jsonl`;
  try {
    const text =
      state.mode === "demo"
        ? (await loadSampleLines()).join("\n") + "\n"
        : await fetchText(apiUrl(path));
    ingestTranscript(spec, text);
  } catch (err) {
    if (!spec.lineCount) {
      appendFeed(
        spec,
        el("p", "ev ev-quiet", "The transcript could not be loaded."),
      );
    }
  }
}

// Incremental parse: split into lines, render only those past spec.lineCount.
// A trailing partial line (no newline yet) is left for the next poll.
function ingestTranscript(spec, text) {
  let body = text;
  if (!body.endsWith("\n")) {
    const cut = body.lastIndexOf("\n");
    body = cut < 0 ? "" : body.slice(0, cut + 1);
  }
  if (!body) return;
  // body always ends with "\n" here; slice it off so split() yields exactly
  // one element per complete line and lineCount stays aligned across polls.
  const lines = body.slice(0, -1).split("\n");
  for (let i = spec.lineCount; i < lines.length; i++) {
    const raw = lines[i];
    if (!raw || !raw.trim()) continue;
    let ev;
    try {
      ev = JSON.parse(raw);
    } catch {
      feedGeneric(spec, raw);
      continue;
    }
    processEvent(spec, ev);
  }
  spec.lineCount = Math.max(spec.lineCount, lines.length);
  scrollFeedIfPinned(spec);
}

function processEvent(spec, ev) {
  switch (ev && ev.type) {
    case "game_start":
      return onGameStart(spec, ev);
    case "turn_start":
      return onTurnStart(spec, ev);
    case "turn_result":
      return onTurnResult(spec, ev);
    case "game_over":
      return onGameOver(spec, ev);
    default:
      return feedGeneric(spec, ev);
  }
}

/* ---------- event handlers ---------- */

function onGameStart(spec, ev) {
  if (ev.players && typeof ev.players === "object") {
    spec.players = ev.players;
    spec.order = Object.keys(ev.players);
  }
  spec.day =
    ev.world && typeof ev.world.day_number === "number"
      ? ev.world.day_number
      : 1;
  spec.phase = (ev.world && ev.world.phase) || null;
  updateBanner(spec);
  renderRoster(spec);
  const n = ev.player_count || spec.order.length;
  appendFeed(
    spec,
    el(
      "div",
      "ev ev-start",
      `The game begins — ${n} souls take their seats in the village.`,
    ),
  );
}

function onTurnStart(spec, ev) {
  if (typeof ev.day === "number") spec.day = ev.day;
  if (ev.phase) spec.phase = ev.phase;
  if (ev.active_player) spec.activePlayer = ev.active_player;
  updateBanner(spec);
  renderRoster(spec); // moves the "acting" dot
}

function onTurnResult(spec, ev) {
  if (typeof ev.day === "number") spec.day = ev.day;
  if (ev.phase) spec.phase = ev.phase;
  updateBanner(spec);
  noteEliminations(spec, ev.elimination_log);
  // NB: a turn_result with status "game_over" precedes the final game_over
  // line — keep polling until that line arrives (see pollTranscript).

  const d = ev.detail && typeof ev.detail === "object" ? ev.detail : {};
  // last_words_night / last_words_day / last_words_vote / future variants
  if (ev.phase && ev.phase.startsWith("last_words"))
    return feedLastWords(spec, ev, d);
  // day_voting / runoff_voting share the {votes, latest_vote} detail shape
  if (ev.phase && ev.phase.endsWith("voting")) return feedVote(spec, ev, d);
  switch (ev.phase) {
    case "wolf_discussion":
      if (d.message)
        return feedSpeech(
          spec,
          ev,
          d.speaker,
          d.message,
          "wolf whisper",
          "ev-wolf",
        );
      break;
    case "night":
      return feedNight(spec, ev, d);
    case "day_discussion":
    case "runoff_discussion":
    case "day_trial":
      if (d.statement)
        return feedSpeech(
          spec,
          ev,
          d.speaker,
          d.statement,
          labelPhase(ev.phase).toLowerCase(),
          "ev-speech",
        );
      break;
    case "private_meeting":
      return feedQuiet(
        spec,
        spec.activePlayer
          ? `${spec.activePlayer} slips away to a private meeting — its contents stay hidden.`
          : "A private meeting takes place — its contents stay hidden.",
      );
    default:
      break;
  }
  // Graceful fallbacks for shapes we don't recognise.
  if (d.speaker && (d.statement || d.message)) {
    return feedSpeech(
      spec,
      ev,
      d.speaker,
      d.statement || d.message,
      labelPhase(ev.phase).toLowerCase(),
      "ev-speech",
    );
  }
  if (!Object.keys(d).length && ev.elimination_log) return; // elimination banner already covers it
  feedGeneric(spec, ev);
}

function onGameOver(spec, ev) {
  spec.finished = true;
  const winner = canonicalWinner(ev.winner);
  noteEliminations(spec, ev.elimination_log);
  if (ev.players && typeof ev.players === "object") {
    spec.players = ev.players;
    spec.order = Object.keys(ev.players);
    // final board state: seats the transcript never logged an elimination for
    for (const [seat, p] of Object.entries(ev.players)) {
      if (p && p.status === "dead" && !spec.dead.has(seat)) {
        spec.dead.set(seat, {
          player: seat,
          reason: "eliminated",
          day: ev.day ?? null,
        });
      }
    }
  }
  if (winner) showWinner(spec, winner);
  renderRoster(spec);
  renderGameStatusBadge(spec);
  const item = el(
    "div",
    "ev ev-over" + (winner ? ` winner-${winner}` : ""),
    winner ? WINNER_LABELS[winner] || `${winner} win` : "The game is over.",
  );
  appendFeed(spec, item);
  stopTranscriptPolling();
}

/* ---------- feed renderers ---------- */

function feedHead(spec, ev, who, tag) {
  const head = el("div", "ev-head");
  if (who) {
    const dead = seatIsDead(spec, who);
    head.append(
      avatarNode(seatName(spec, who), seatRole(spec, who), dead, "md"),
    );
    head.append(el("span", "ev-who", seatName(spec, who)));
  }
  if (tag) head.append(el("span", "ev-tag", tag));
  const t = fmtTime(ev && ev.timestamp);
  if (t) head.append(el("time", "ev-time", t));
  return head;
}

function feedSpeech(spec, ev, speaker, text, tag, extraClass) {
  const role = (spec.players[speaker] || {}).role || "";
  const item = el("div", `ev ${extraClass} role-${role}`.trim());
  item.append(feedHead(spec, ev, speaker || "Someone", tag));
  item.append(el("p", "ev-text", text));
  appendFeed(spec, item);
}

function feedNight(spec, ev, d) {
  const actions =
    d.night_actions && typeof d.night_actions === "object"
      ? d.night_actions
      : {};
  const fresh = [];
  for (const [player, a] of Object.entries(actions)) {
    if (!a || typeof a !== "object" || !a.action) continue;
    // night_actions is cumulative within a night, and keys repeat across nights.
    const key = JSON.stringify([
      ev.day,
      player,
      a.action,
      a.target ?? null,
      a.result ?? null,
    ]);
    if (spec.seenNightActions.has(key)) continue;
    spec.seenNightActions.add(key);
    fresh.push(nightActionNode(spec, player, a));
  }
  if (!fresh.length) return; // e.g. a villager's night turn: nothing to narrate
  const item = el("div", "ev ev-night");
  item.append(feedHead(spec, ev, null, `night ${ev.day ?? ""}`.trim()));
  const ul = el("ul");
  for (const line of fresh) ul.append(line);
  item.append(ul);
  appendFeed(spec, item);
}

// Narrates one night action as a <li> with the actor (and any target) rendered
// as character chips, so the cast stays recognisable inside the prose.
function nightActionNode(spec, player, a) {
  const li = el("li");
  const say = (t) => li.append(document.createTextNode(t));
  const who = (seat) => li.append(charChip(spec, seat, "sm"));

  switch (a.action) {
    case "choose_victim":
      who(player);
      say(" stalks the dark — ");
      who(a.target);
      say(" is marked as the victim.");
      break;
    case "investigate":
      who(player);
      say(" gazes into ");
      who(a.target);
      say(`'s soul and sees: ${a.result ?? "unclear"}.`);
      break;
    case "protect":
      who(player);
      say(" stands guard over ");
      who(a.target);
      say(".");
      break;
    case "wander":
      who(player);
      say(" wanders the sleeping village.");
      break;
    default:
      who(player);
      say(`: ${a.action}`);
      if (a.target) {
        say(" → ");
        who(a.target);
      }
      if (a.result) say(` (${a.result})`);
  }
  return li;
}

function feedVote(spec, ev, d) {
  const latest =
    d.latest_vote && typeof d.latest_vote === "object" ? d.latest_vote : null;
  const votes = d.votes && typeof d.votes === "object" ? d.votes : {};
  if (!latest && !Object.keys(votes).length) return feedGeneric(spec, ev);

  const item = el("div", "ev ev-vote");
  item.append(feedHead(spec, ev, latest && latest.voter, "vote"));
  if (latest && latest.voter) {
    const line = el("p", "ev-text");
    line.append(charChip(spec, latest.voter, "sm"));
    line.append(document.createTextNode(" votes to eliminate "));
    line.append(charChip(spec, latest.target, "sm"));
    line.append(document.createTextNode("."));
    item.append(line);
  }
  const tally = {};
  for (const target of Object.values(votes))
    tally[target] = (tally[target] || 0) + 1;
  const entries = Object.entries(tally).sort((a, b) => b[1] - a[1]);
  if (entries.length) {
    const chips = el("div", "tally");
    const top = entries[0][1];
    for (const [target, n] of entries) {
      const chip = charChip(spec, target, "sm", {
        suffix: `\u00D7${n}`,
      });
      chip.classList.add("chip");
      if (n === top && entries.length > 1) chip.classList.add("is-leading");
      chips.append(chip);
    }
    item.append(chips);
  }
  appendFeed(spec, item);
}

function feedLastWords(spec, ev, d) {
  const who = spec.activePlayer || "The condemned";
  const words = d.statement || d.message || d.words || null;
  const item = el("div", "ev ev-lastwords");
  item.append(feedHead(spec, ev, who, "last words"));
  item.append(
    el("p", "ev-text", words || `${who} delivers their final words.`),
  );
  appendFeed(spec, item);
}

function feedQuiet(spec, text) {
  appendFeed(spec, el("div", "ev ev-quiet", text));
}

function feedGeneric(spec, rawOrObj) {
  const text =
    typeof rawOrObj === "string" ? rawOrObj : JSON.stringify(rawOrObj);
  const item = el("div", "ev ev-generic");
  const pre = el("pre");
  pre.textContent = text;
  item.append(pre);
  appendFeed(spec, item);
}

function noteEliminations(spec, log) {
  if (!Array.isArray(log)) return;
  for (const e of log) {
    if (!e || !e.player) continue;
    const key = `${e.player}|${e.day ?? "?"}|${e.reason ?? "?"}`;
    if (spec.seenElims.has(key)) continue;
    spec.seenElims.add(key);
    spec.dead.set(e.player, e);
    const role = e.role ? ` the ${e.role}` : "";
    const when =
      e.reason === "killed"
        ? "was killed in the night"
        : e.reason === "voted"
          ? "was condemned by the village"
          : `was eliminated (${e.reason || "unknown"})`;
    const item = el("div", "ev ev-elim");
    const line = el("div", "elim-line");
    line.append(el("span", "elim-mark", "\u2620"));
    line.append(charChip(spec, e.player, "md", { dead: true, role: e.role }));
    line.append(el("span", "elim-text", `${role.trim()} ${when}.`.trim()));
    item.append(line);
    appendFeed(spec, item);
  }
  renderRoster(spec);
}

/* ---------- chrome (banner, roster, winner) ---------- */

function updateBanner(spec) {
  const parts = [];
  if (spec.day != null) parts.push(`Day ${spec.day}`);
  if (spec.phase) parts.push(labelPhase(spec.phase));
  $("#phase-banner").textContent = parts.join(" \u00B7 ");
}

function showWinner(spec, winner) {
  spec.winner = winner;
  const wb = $("#winner-banner");
  wb.hidden = false;
  wb.className = "winner-banner" + (winner ? ` winner-${winner}` : "");
  clear(wb);
  wb.append(
    el(
      "div",
      "wb-title",
      WINNER_LABELS[winner] || (winner ? `${winner} win` : "The game is over."),
    ),
  );
  // Final curtain call: the whole cast, survivors first, with the fallen marked.
  const seats = spec.order.length ? spec.order : Object.keys(spec.players);
  if (seats.length) {
    const cast = el("div", "wb-cast");
    const ordered = seats
      .slice()
      .sort(
        (a, b) => Number(seatIsDead(spec, a)) - Number(seatIsDead(spec, b)),
      );
    for (const seat of ordered) cast.append(charChip(spec, seat, "md"));
    wb.append(cast);
  }
}

function renderRoster(spec) {
  const roster = spec.rosterEl;
  clear(roster);
  const seats = spec.order.length ? spec.order : Object.keys(spec.players);
  let alive = 0;
  for (const seat of seats) {
    const p = spec.players[seat] || {};
    const death = spec.dead.get(seat);
    if (!death) alive += 1;
    const name = p.name || seat;
    const card = el(
      "div",
      `pcard role-${p.role || "unknown"}${death ? " is-dead" : ""}${seat === spec.activePlayer && !death ? " is-active" : ""}`,
    );

    card.append(avatarNode(name, p.role, !!death, "lg"));

    const body = el("div", "p-body");
    const top = el("div", "p-top");
    top.append(el("span", "p-name", name));
    top.append(el("span", "p-active-dot"));
    body.append(top);
    body.append(el("span", "p-epithet", epithetFor(name)));

    const meta = el("div", "p-meta");
    meta.append(el("span", "p-role", roleTitle(p.role)));
    const model = shortModel(p.model);
    if (model) meta.append(el("span", "p-model", model));
    body.append(meta);

    body.append(
      el(
        "span",
        "p-state",
        death
          ? `\u2620 ${death.reason || "eliminated"} \u00B7 day ${death.day ?? "?"}`
          : seat === spec.activePlayer
            ? "acting now"
            : "alive",
      ),
    );
    card.append(body);
    roster.append(card);
  }
  renderCastHead(spec, seats.length, alive);
}

// The "The Cast" bar above the roster: headcount plus a collapse toggle, which
// matters most on a phone where the roster would otherwise push the feed down.
function renderCastHead(spec, total, alive) {
  const head = $("#cast-head");
  if (!head) return;
  head.hidden = total === 0;
  const counts = $("#cast-counts");
  if (!counts) return;
  const fallen = total - alive;
  counts.textContent = fallen
    ? `${alive} alive \u00B7 ${fallen} fallen`
    : `${alive} alive`;
}

function setCastCollapsed(collapsed) {
  const roster = $("#roster");
  const toggle = $("#cast-toggle");
  if (!roster || !toggle) return;
  roster.classList.toggle("is-collapsed", collapsed);
  toggle.setAttribute("aria-expanded", collapsed ? "false" : "true");
}

/* ---------- feed plumbing ---------- */

function appendFeed(spec, node) {
  spec.feedEl.append(node);
}

// Keep the view pinned to the newest events unless the reader scrolled up.
function scrollFeedIfPinned(spec) {
  const slack = 160;
  const nearBottom =
    window.innerHeight + window.scrollY >=
    document.documentElement.scrollHeight - slack;
  if (nearBottom)
    window.scrollTo({ top: document.documentElement.scrollHeight });
}

/* ================= game list (home) ================= */

function renderGameList() {
  const list = $("#game-list");
  clear(list);
  if (!state.games.length) {
    list.append(el("p", "list-empty", "No games yet — the village sleeps."));
    return;
  }
  for (const g of state.games) list.append(gameCard(g));
}

function gameCard(g) {
  const live = g.status === "live";
  const card = el("a", "game-card" + (live ? " is-live" : ""));
  card.href = `#/game/${encodeURIComponent(g.id)}`;

  const head = el("div", "gc-head");
  head.append(el("span", "gc-title", g.id));
  if (g.started_at) head.append(el("time", "gc-time", fmtDate(g.started_at)));
  const badge = el(
    "span",
    "status-badge" + (live ? " is-live" : g.demo ? " is-demo" : ""),
    live ? "live" : g.demo ? "offline demo" : "finished",
  );
  head.append(badge);
  card.append(head);

  const players = g.players && typeof g.players === "object" ? g.players : {};
  const seats = Object.keys(players);
  if (seats.length) {
    const row = el("div", "gc-players");
    // Finished games reveal the fallen; a live game keeps the board neutral.
    const fake = { players, dead: new Map() };
    for (const seat of seats) {
      const p = players[seat] || {};
      const dead = p.status === "dead";
      const chip = charChip(fake, seat, "sm", { dead });
      chip.classList.add("player-chip", `role-${p.role || "unknown"}`);
      row.append(chip);
    }
    card.append(row);
  }

  const meta = el("div", "gc-meta");
  const bits = [];
  const count = g.player_count || seats.length;
  if (count) bits.push(`${count} players`);
  if (typeof g.steps === "number") bits.push(`${g.steps} steps`);
  const models = [
    ...new Set(seats.map((s) => shortModel(players[s].model)).filter(Boolean)),
  ];
  if (models.length) bits.push(models.join(", "));
  for (const b of bits) meta.append(el("span", null, b));
  const winner = canonicalWinner(g.winner);
  if (winner) {
    meta.append(
      el(
        "span",
        `gc-winner winner-${winner}`,
        WINNER_LABELS[winner] || `${winner} won`,
      ),
    );
  }
  card.append(meta);
  return card;
}

/* ================= embedded offline sample =================
 * Mirror of games/sample.jsonl, used only when neither the API nor a local
 * fetch of the file can succeed (e.g. the page was opened via file://).
 * Regenerate from games/sample.jsonl whenever the sample changes.
 */
const EMBEDDED_SAMPLE_LINES = /*__EMBEDDED_SAMPLE__*/ [
  '{"timestamp":"2026-08-08T03:27:11.214501Z","type":"game_start","player_count":5,"players":{"Bram":{"name":null,"role":"villager","model":"opencode_go/deepseek-v4-flash"},"Cora":{"name":null,"role":"villager","model":"opencode_go/deepseek-v4-flash"},"Felix":{"name":null,"role":"doctor","model":"opencode_go/deepseek-v4-flash"},"Hugo":{"name":null,"role":"seer","model":"opencode_go/deepseek-v4-flash"},"Iris":{"name":null,"role":"werewolf","model":"opencode_go/deepseek-v4-flash"}},"world":{"active_actor_id":"Iris","meeting_requests":{},"votes":{},"pending_elimination":null,"wanderer_results":[],"past_votes":{},"day_number":1,"night_history":[],"phase":"wolf_discussion","meeting_transcripts":[],"character_profiles":{},"current_meeting_messages":[],"discussion_turn_count":0,"discussion_round_limit":0,"journals":{},"turn_order":["Iris"],"backstory_connections":[{"type":"mentor_student","description":"Cora and Iris: the first was once the second\'s mentor and teacher in the village trade.","players":["Cora","Iris"]},{"type":"mentor_student","description":"Hugo and Bram: the first was once the second\'s mentor and teacher in the village trade.","players":["Hugo","Bram"]}],"wolf_chat_transcript":[],"player_items":{},"elimination_log":[],"seer_history":[],"winner":null,"village_event_history":[],"discussion_turn_limit":0,"players":{"Bram":{"status":"alive","role":"villager","model":"opencode_go/deepseek-v4-flash","traits":["observant"]},"Cora":{"status":"alive","role":"villager","model":"opencode_go/deepseek-v4-flash","traits":["observant","cunning"]},"Felix":{"status":"alive","role":"doctor","model":"opencode_go/deepseek-v4-flash","traits":["dramatic"]},"Hugo":{"status":"alive","role":"seer","model":"opencode_go/deepseek-v4-flash","traits":["paranoid","dramatic"]},"Iris":{"status":"alive","role":"werewolf","model":"opencode_go/deepseek-v4-flash","traits":["loyal"]}},"wolf_chat_history":[],"last_words":[],"meeting_pairs":[],"current_village_event":null,"night_actions":{},"runoff_candidates":null,"discussion_transcript":[],"evidence_tokens":[],"current_meeting_index":0,"past_transcripts":{},"status":"in_progress","discussion_round":0,"vote_history":[]}}',
  '{"timestamp":"2026-08-08T03:27:11.221409Z","type":"turn_start","step":1,"day":1,"phase":"wolf_discussion","model":"opencode_go/deepseek-v4-flash","active_player":"Iris"}',
  '{"status":"in_progress","timestamp":"2026-08-08T03:27:18.809767Z","type":"turn_result","step":1,"day":1,"phase":"wolf_discussion","elimination_log":[],"detail":{"message":"No other wolves are with me, so I\'ll act as the lone hunter. Target Cora tonight — she\'s a trusted mentor figure who could organize the village and sniff me out. Tomorrow I\'ll play the confused villager and probe Felix/Hugo for reactions.","speaker":"Iris"},"phase_after":"night"}',
  '{"timestamp":"2026-08-08T03:27:18.809841Z","type":"turn_start","step":2,"day":1,"phase":"night","model":"opencode_go/deepseek-v4-flash","active_player":"Iris"}',
  '{"status":"in_progress","timestamp":"2026-08-08T03:27:24.161759Z","type":"turn_result","step":2,"day":1,"phase":"night","elimination_log":[],"detail":{"night_actions":{"Iris":{"target":"Cora","action":"choose_victim"}},"latest_night_action":{"target":"Cora","action":"choose_victim","player":"Iris"}},"active_player_after":"Hugo"}',
  '{"timestamp":"2026-08-08T03:27:24.161859Z","type":"turn_start","step":3,"day":1,"phase":"night","model":"opencode_go/deepseek-v4-flash","active_player":"Hugo"}',
  '{"status":"in_progress","timestamp":"2026-08-08T03:27:33.899666Z","type":"turn_result","step":3,"day":1,"phase":"night","elimination_log":[],"detail":{"night_actions":{"Hugo":{"result":"villager","target":"Cora","action":"investigate"},"Iris":{"target":"Cora","action":"choose_victim"}},"latest_night_action":{"result":"villager","target":"Cora","action":"investigate","player":"Hugo"}},"active_player_after":"Felix"}',
  '{"timestamp":"2026-08-08T03:27:33.899753Z","type":"turn_start","step":4,"day":1,"phase":"night","model":"opencode_go/deepseek-v4-flash","active_player":"Felix"}',
  '{"status":"in_progress","timestamp":"2026-08-08T03:27:38.448794Z","type":"turn_result","step":4,"day":1,"phase":"night","elimination_log":[],"detail":{"night_actions":{"Felix":{"target":"Felix","action":"protect"},"Hugo":{"result":"villager","target":"Cora","action":"investigate"},"Iris":{"target":"Cora","action":"choose_victim"}},"latest_night_action":{"target":"Felix","action":"protect","player":"Felix"}},"active_player_after":"Bram"}',
  '{"timestamp":"2026-08-08T03:27:38.448899Z","type":"turn_start","step":5,"day":1,"phase":"night","model":"opencode_go/deepseek-v4-flash","active_player":"Bram"}',
  '{"status":"in_progress","timestamp":"2026-08-08T03:27:45.247282Z","type":"turn_result","step":5,"day":1,"phase":"night","elimination_log":[],"detail":{"night_actions":{"Bram":{"action":"wander"},"Felix":{"target":"Felix","action":"protect"},"Hugo":{"result":"villager","target":"Cora","action":"investigate"},"Iris":{"target":"Cora","action":"choose_victim"}}},"active_player_after":"Cora"}',
  '{"timestamp":"2026-08-08T03:27:45.247378Z","type":"turn_start","step":6,"day":1,"phase":"night","model":"opencode_go/deepseek-v4-flash","active_player":"Cora"}',
  '{"status":"in_progress","timestamp":"2026-08-08T03:27:50.203161Z","type":"turn_result","step":6,"day":1,"phase":"night","elimination_log":[],"detail":{"night_actions":{"Bram":{"action":"wander"},"Felix":{"target":"Felix","action":"protect"},"Hugo":{"result":"villager","target":"Cora","action":"investigate"},"Iris":{"target":"Cora","action":"choose_victim"}}},"phase_after":"last_words_night"}',
  '{"timestamp":"2026-08-08T03:27:50.203264Z","type":"turn_start","step":7,"day":1,"phase":"last_words_night","model":"opencode_go/deepseek-v4-flash","active_player":"Cora"}',
  '{"status":"in_progress","timestamp":"2026-08-08T03:27:55.750090Z","type":"turn_result","step":7,"day":1,"phase":"last_words_night","elimination_log":[{"reason":"killed","day":1,"role":"villager","player":"Cora"}],"detail":{},"active_player_after":"Bram","phase_after":"private_meeting"}',
  '{"timestamp":"2026-08-08T03:27:55.750178Z","type":"turn_start","step":8,"day":1,"phase":"private_meeting","model":"opencode_go/deepseek-v4-flash","active_player":"Bram"}',
  '{"status":"in_progress","timestamp":"2026-08-08T03:28:00.873398Z","type":"turn_result","step":8,"day":1,"phase":"private_meeting","elimination_log":[{"reason":"killed","day":1,"role":"villager","player":"Cora"}],"detail":{},"active_player_after":"Hugo"}',
  '{"timestamp":"2026-08-08T03:28:00.873489Z","type":"turn_start","step":9,"day":1,"phase":"private_meeting","model":"opencode_go/deepseek-v4-flash","active_player":"Hugo"}',
  '{"status":"in_progress","timestamp":"2026-08-08T03:28:08.775863Z","type":"turn_result","step":9,"day":1,"phase":"private_meeting","elimination_log":[{"reason":"killed","day":1,"role":"villager","player":"Cora"}],"detail":{},"active_player_after":"Iris"}',
  '{"timestamp":"2026-08-08T03:28:08.775975Z","type":"turn_start","step":10,"day":1,"phase":"private_meeting","model":"opencode_go/deepseek-v4-flash","active_player":"Iris"}',
  '{"status":"in_progress","timestamp":"2026-08-08T03:28:14.498680Z","type":"turn_result","step":10,"day":1,"phase":"private_meeting","elimination_log":[{"reason":"killed","day":1,"role":"villager","player":"Cora"}],"detail":{},"active_player_after":"Felix"}',
  '{"timestamp":"2026-08-08T03:28:14.498756Z","type":"turn_start","step":11,"day":1,"phase":"private_meeting","model":"opencode_go/deepseek-v4-flash","active_player":"Felix"}',
  '{"status":"in_progress","timestamp":"2026-08-08T03:28:23.303281Z","type":"turn_result","step":11,"day":1,"phase":"private_meeting","elimination_log":[{"reason":"killed","day":1,"role":"villager","player":"Cora"}],"detail":{},"active_player_after":"Bram","phase_after":"day_discussion"}',
  '{"timestamp":"2026-08-08T03:28:23.303382Z","type":"turn_start","step":12,"day":1,"phase":"day_discussion","model":"opencode_go/deepseek-v4-flash","active_player":"Bram"}',
  '{"status":"in_progress","timestamp":"2026-08-08T03:28:32.929712Z","type":"turn_result","step":12,"day":1,"phase":"day_discussion","elimination_log":[{"reason":"killed","day":1,"role":"villager","player":"Cora"}],"detail":{"statement":"Cora\'s clue narrows this to Felix or Iris, and I want each of you to account for your night plainly: were either of you near Cora\'s side of the village, and can you speak to your movements? Whoever hedges, deflects, or tries to steer us back to meta talk is who I\'m voting for — I\'d rather hear a bad answer than no answer.","speaker":"Bram"},"active_player_after":"Felix"}',
  '{"timestamp":"2026-08-08T03:28:32.929842Z","type":"turn_start","step":13,"day":1,"phase":"day_discussion","model":"opencode_go/deepseek-v4-flash","active_player":"Felix"}',
  '{"status":"in_progress","timestamp":"2026-08-08T03:28:40.765298Z","type":"turn_result","step":13,"day":1,"phase":"day_discussion","elimination_log":[{"reason":"killed","day":1,"role":"villager","player":"Cora"}],"detail":{"statement":"Iris met my eyes in private and the moment the muddy trail was named, she swept her hand toward Hugo and Bram — desperate to drag us anywhere but the one lead we have. Cora told us exactly who deserves the closest look, and Iris has been the one doing the steering.","speaker":"Felix"},"active_player_after":"Iris"}',
  '{"timestamp":"2026-08-08T03:28:40.765377Z","type":"turn_start","step":14,"day":1,"phase":"day_discussion","model":"opencode_go/deepseek-v4-flash","active_player":"Iris"}',
  '{"status":"in_progress","timestamp":"2026-08-08T03:28:57.706466Z","type":"turn_result","step":14,"day":1,"phase":"day_discussion","elimination_log":[{"reason":"killed","day":1,"role":"villager","player":"Cora"}],"detail":{"statement":"Cora herself said that trail is not proof — it runs past both Felix\'s door and mine. I was on my side of the village all night and never went near her house; I\'ll answer Bram\'s question plainly. What I won\'t accept is Felix seizing a medium lead the second we met privately and twisting it into a one-name case — that\'s exactly the eager steering Cora told us to watch for, and right now Felix is my vote.","speaker":"Iris"},"active_player_after":"Hugo"}',
  '{"timestamp":"2026-08-08T03:28:57.706584Z","type":"turn_start","step":15,"day":1,"phase":"day_discussion","model":"opencode_go/deepseek-v4-flash","active_player":"Hugo"}',
  '{"status":"in_progress","timestamp":"2026-08-08T03:29:41.151090Z","type":"turn_result","step":15,"day":1,"phase":"day_discussion","elimination_log":[{"reason":"killed","day":1,"role":"villager","player":"Cora"}],"detail":{"statement":"Mark me down for Iris. Felix\'s charge that she swept the table toward Bram and me the moment the muddy trail was named rings true — and when she answered, she never once denied it, she just pivoted to accusing Felix. That\'s exactly the eager steering Cora warned us about, and the trail itself runs past her door. I\'m voting Iris.","speaker":"Hugo"},"active_player_after":"Bram","phase_after":"day_voting"}',
  '{"timestamp":"2026-08-08T03:29:41.151195Z","type":"turn_start","step":16,"day":1,"phase":"day_voting","model":"opencode_go/deepseek-v4-flash","active_player":"Bram"}',
  '{"status":"in_progress","timestamp":"2026-08-08T03:30:39.072060Z","type":"turn_result","step":16,"day":1,"phase":"day_voting","elimination_log":[{"reason":"killed","day":1,"role":"villager","player":"Cora"}],"detail":{"votes":{"Bram":"Felix"},"latest_vote":{"target":"Felix","voter":"Bram"}},"active_player_after":"Felix"}',
  '{"timestamp":"2026-08-08T03:30:39.072164Z","type":"turn_start","step":17,"day":1,"phase":"day_voting","model":"opencode_go/deepseek-v4-flash","active_player":"Felix"}',
  '{"status":"in_progress","timestamp":"2026-08-08T03:30:44.047562Z","type":"turn_result","step":17,"day":1,"phase":"day_voting","elimination_log":[{"reason":"killed","day":1,"role":"villager","player":"Cora"}],"detail":{"votes":{"Bram":"Felix","Felix":"Iris"},"latest_vote":{"target":"Iris","voter":"Felix"}},"active_player_after":"Hugo"}',
  '{"timestamp":"2026-08-08T03:30:44.047695Z","type":"turn_start","step":18,"day":1,"phase":"day_voting","model":"opencode_go/deepseek-v4-flash","active_player":"Hugo"}',
  '{"status":"in_progress","timestamp":"2026-08-08T03:30:48.357954Z","type":"turn_result","step":18,"day":1,"phase":"day_voting","elimination_log":[{"reason":"killed","day":1,"role":"villager","player":"Cora"}],"detail":{"votes":{"Bram":"Felix","Felix":"Iris","Hugo":"Iris"},"latest_vote":{"target":"Iris","voter":"Hugo"}},"active_player_after":"Iris"}',
  '{"timestamp":"2026-08-08T03:30:48.358069Z","type":"turn_start","step":19,"day":1,"phase":"day_voting","model":"opencode_go/deepseek-v4-flash","active_player":"Iris"}',
  '{"status":"in_progress","timestamp":"2026-08-08T03:30:55.653768Z","type":"turn_result","step":19,"day":1,"phase":"day_voting","elimination_log":[{"reason":"killed","day":1,"role":"villager","player":"Cora"}],"detail":{"votes":{"Bram":"Felix","Felix":"Iris","Hugo":"Iris","Iris":"Felix"},"latest_vote":{"target":"Felix","voter":"Iris"}},"active_player_after":"Bram","phase_after":"runoff_discussion"}',
  '{"timestamp":"2026-08-08T03:30:55.653921Z","type":"turn_start","step":20,"day":1,"phase":"runoff_discussion","model":"opencode_go/deepseek-v4-flash","active_player":"Bram"}',
  '{"status":"in_progress","timestamp":"2026-08-08T03:32:57.713782Z","type":"turn_result","step":20,"day":1,"phase":"day_discussion","elimination_log":[{"reason":"killed","day":1,"role":"villager","player":"Cora"}],"detail":{"statement":"I came in leaning Felix for dodging my night question, but the runoff changed my read: Felix named a specific private moment and Iris never once denied it — she pivoted to a script about \\"eager steering.\\" An innocent woman accused of sweeping the table toward Hugo and me denies it flat-out. Her own account puts her on her side all night, which is exactly where a trail from her door would lead — Iris is the wolf, and my runoff vote goes to her.","speaker":"Bram"},"active_player_after":"Felix","phase_after":"runoff_discussion"}',
  '{"timestamp":"2026-08-08T03:32:57.713896Z","type":"turn_start","step":21,"day":1,"phase":"runoff_discussion","model":"opencode_go/deepseek-v4-flash","active_player":"Felix"}',
  '{"status":"in_progress","timestamp":"2026-08-08T03:33:08.127970Z","type":"turn_result","step":21,"day":1,"phase":"day_discussion","elimination_log":[{"reason":"killed","day":1,"role":"villager","player":"Cora"}],"detail":{"statement":"Cora\'s muddy trail runs from exactly one of two doors — and I know, with absolute certainty, that mine is clean. Iris had her chance to deny the sweeping and instead gave us theater about \\"eager steering.\\" Bram and Hugo now see what I\'ve seen all along: the spotlight Iris tried to dodge is precisely where the wolf stands. This runoff ends with the truth — my vote is Iris.","speaker":"Felix"},"active_player_after":"Hugo","phase_after":"runoff_discussion"}',
  '{"timestamp":"2026-08-08T03:33:08.128142Z","type":"turn_start","step":22,"day":1,"phase":"runoff_discussion","model":"opencode_go/deepseek-v4-flash","active_player":"Hugo"}',
  '{"status":"in_progress","timestamp":"2026-08-08T03:33:53.323645Z","type":"turn_result","step":22,"day":1,"phase":"day_discussion","elimination_log":[{"reason":"killed","day":1,"role":"villager","player":"Cora"}],"detail":{"statement":"Iris, you\'ve had two chances now to look this village in the eye and say the words \\"I never swept the table toward Hugo and Bram\\" — and twice you\'ve given us theater instead of a denial. Felix named the exact moment, the trail runs past your door, and every time a wolf is cornered she accuses the accuser. The runoff ends here: my vote is Iris.","speaker":"Hugo"},"active_player_after":"Iris","phase_after":"runoff_discussion"}',
  '{"timestamp":"2026-08-08T03:33:53.323822Z","type":"turn_start","step":23,"day":1,"phase":"runoff_discussion","model":"opencode_go/deepseek-v4-flash","active_player":"Iris"}',
  '{"status":"in_progress","timestamp":"2026-08-08T03:34:23.706520Z","type":"turn_result","step":23,"day":1,"phase":"day_discussion","elimination_log":[{"reason":"killed","day":1,"role":"villager","player":"Cora"}],"detail":{"statement":"Here is the flat denial you all demanded: I never swept the table toward Bram or Hugo, in that meeting or anywhere else — Felix asked me for an honest read and I gave him one, and he twisted it into a one-name case. Now he claims \\"absolute certainty\\" his door is clean while building that case on Cora\'s own warning that the trail is not proof. Only the wolf could be that certain about whose door that trail runs from — my vote stays on Felix.","speaker":"Iris"},"active_player_after":"Bram","phase_after":"runoff_voting"}',
  '{"timestamp":"2026-08-08T03:34:23.706694Z","type":"turn_start","step":24,"day":1,"phase":"runoff_voting","model":"opencode_go/deepseek-v4-flash","active_player":"Bram"}',
  '{"status":"in_progress","timestamp":"2026-08-08T03:35:53.008897Z","type":"turn_result","step":24,"day":1,"phase":"day_voting","elimination_log":[{"reason":"killed","day":1,"role":"villager","player":"Cora"}],"detail":{"votes":{"Bram":"Iris"},"latest_vote":{"target":"Iris","voter":"Bram"}},"active_player_after":"Felix","phase_after":"runoff_voting"}',
  '{"timestamp":"2026-08-08T03:35:53.009015Z","type":"turn_start","step":25,"day":1,"phase":"runoff_voting","model":"opencode_go/deepseek-v4-flash","active_player":"Felix"}',
  '{"status":"in_progress","timestamp":"2026-08-08T03:35:57.343899Z","type":"turn_result","step":25,"day":1,"phase":"day_voting","elimination_log":[{"reason":"killed","day":1,"role":"villager","player":"Cora"}],"detail":{"votes":{"Bram":"Iris","Felix":"Iris"},"latest_vote":{"target":"Iris","voter":"Felix"}},"active_player_after":"Hugo","phase_after":"runoff_voting"}',
  '{"timestamp":"2026-08-08T03:35:57.344004Z","type":"turn_start","step":26,"day":1,"phase":"runoff_voting","model":"opencode_go/deepseek-v4-flash","active_player":"Hugo"}',
  '{"status":"in_progress","timestamp":"2026-08-08T03:36:06.455655Z","type":"turn_result","step":26,"day":1,"phase":"day_voting","elimination_log":[{"reason":"killed","day":1,"role":"villager","player":"Cora"}],"detail":{"votes":{"Bram":"Iris","Felix":"Iris","Hugo":"Iris"},"latest_vote":{"target":"Iris","voter":"Hugo"}},"active_player_after":"Iris","phase_after":"runoff_voting"}',
  '{"timestamp":"2026-08-08T03:36:06.455831Z","type":"turn_start","step":27,"day":1,"phase":"runoff_voting","model":"opencode_go/deepseek-v4-flash","active_player":"Iris"}',
  '{"status":"in_progress","timestamp":"2026-08-08T03:36:11.578289Z","type":"turn_result","step":27,"day":1,"phase":"day_voting","elimination_log":[{"reason":"killed","day":1,"role":"villager","player":"Cora"}],"detail":{"votes":{"Bram":"Iris","Felix":"Iris","Hugo":"Iris","Iris":"Felix"},"latest_vote":{"target":"Felix","voter":"Iris"}},"phase_after":"last_words_vote"}',
  '{"timestamp":"2026-08-08T03:36:11.578409Z","type":"turn_start","step":28,"day":1,"phase":"last_words_vote","model":"opencode_go/deepseek-v4-flash","active_player":"Iris"}',
  '{"status":"game_over","timestamp":"2026-08-08T03:36:22.142799Z","type":"turn_result","step":28,"day":1,"phase":"last_words_vote","elimination_log":[{"reason":"killed","day":1,"role":"villager","player":"Cora"},{"reason":"voted","day":1,"role":"werewolf","player":"Iris"}],"detail":{},"phase_after":"game_over"}',
  '{"timestamp":"2026-08-08T03:36:22.144849Z","type":"game_over","day":1,"players":{"Bram":{"name":null,"status":"alive","role":"villager","model":"opencode_go/deepseek-v4-flash"},"Cora":{"name":null,"status":"dead","role":"villager","model":"opencode_go/deepseek-v4-flash"},"Felix":{"name":null,"status":"alive","role":"doctor","model":"opencode_go/deepseek-v4-flash"},"Hugo":{"name":null,"status":"alive","role":"seer","model":"opencode_go/deepseek-v4-flash"},"Iris":{"name":null,"status":"dead","role":"werewolf","model":"opencode_go/deepseek-v4-flash"}},"discussion_transcript":[{"statement":"I came in leaning Felix for dodging my night question, but the runoff changed my read: Felix named a specific private moment and Iris never once denied it — she pivoted to a script about \\"eager steering.\\" An innocent woman accused of sweeping the table toward Hugo and me denies it flat-out. Her own account puts her on her side all night, which is exactly where a trail from her door would lead — Iris is the wolf, and my runoff vote goes to her.","player":"Bram"},{"statement":"Cora\'s muddy trail runs from exactly one of two doors — and I know, with absolute certainty, that mine is clean. Iris had her chance to deny the sweeping and instead gave us theater about \\"eager steering.\\" Bram and Hugo now see what I\'ve seen all along: the spotlight Iris tried to dodge is precisely where the wolf stands. This runoff ends with the truth — my vote is Iris.","player":"Felix"},{"statement":"Iris, you\'ve had two chances now to look this village in the eye and say the words \\"I never swept the table toward Hugo and Bram\\" — and twice you\'ve given us theater instead of a denial. Felix named the exact moment, the trail runs past your door, and every time a wolf is cornered she accuses the accuser. The runoff ends here: my vote is Iris.","player":"Hugo"},{"statement":"Here is the flat denial you all demanded: I never swept the table toward Bram or Hugo, in that meeting or anywhere else — Felix asked me for an honest read and I gave him one, and he twisted it into a one-name case. Now he claims \\"absolute certainty\\" his door is clean while building that case on Cora\'s own warning that the trail is not proof. Only the wolf could be that certain about whose door that trail runs from — my vote stays on Felix.","player":"Iris"}],"elimination_log":[{"reason":"killed","day":1,"role":"villager","player":"Cora"},{"reason":"voted","day":1,"role":"werewolf","player":"Iris"}],"winner":"villagers","performance":{"models":{"opencode_go/deepseek-v4-flash":{"seats":5,"team_wins":4,"votes_for_werewolf":5,"votes_for_villager":3,"successful_kills":1,"wolf_checks_found":0,"doctor_saves":0,"missed_decisions":0,"survived":3,"correct_accusations":0,"false_accusations":0,"seer_checks":1,"protections_of_villagers":1,"protections_of_wolves":0,"role_score_mean":0.6859999999999999,"seer_clears":1}},"players":{"Bram":{"status":"alive","role":"villager","model":"opencode_go/deepseek-v4-flash","statements":1,"votes_for_werewolf":1,"votes_for_villager":1,"successful_kills":0,"wolf_checks_found":0,"doctor_saves":0,"team_won":true,"skip_votes":0,"failed_kills":0,"missed_decisions":0,"role_score":0.775,"survived":true,"correct_accusations":0,"false_accusations":0,"seer_checks":0,"protections_of_villagers":0,"protections_of_wolves":0,"seer_clears":0,"night_actions_used":0,"partner_votes":0,"team":"villagers"},"Cora":{"status":"dead","role":"villager","model":"opencode_go/deepseek-v4-flash","statements":0,"votes_for_werewolf":0,"votes_for_villager":0,"successful_kills":0,"wolf_checks_found":0,"doctor_saves":0,"team_won":true,"skip_votes":0,"failed_kills":0,"missed_decisions":0,"role_score":0.625,"survived":false,"correct_accusations":0,"false_accusations":0,"seer_checks":0,"protections_of_villagers":0,"protections_of_wolves":0,"seer_clears":0,"night_actions_used":0,"partner_votes":0,"team":"villagers"},"Felix":{"status":"alive","role":"doctor","model":"opencode_go/deepseek-v4-flash","statements":1,"votes_for_werewolf":2,"votes_for_villager":0,"successful_kills":0,"wolf_checks_found":0,"doctor_saves":0,"team_won":true,"skip_votes":0,"failed_kills":0,"missed_decisions":0,"role_score":0.85,"survived":true,"correct_accusations":0,"false_accusations":0,"seer_checks":0,"protections_of_villagers":1,"protections_of_wolves":0,"seer_clears":0,"night_actions_used":1,"partner_votes":0,"team":"villagers"},"Hugo":{"status":"alive","role":"seer","model":"opencode_go/deepseek-v4-flash","statements":1,"votes_for_werewolf":2,"votes_for_villager":0,"successful_kills":0,"wolf_checks_found":0,"doctor_saves":0,"team_won":true,"skip_votes":0,"failed_kills":0,"missed_decisions":0,"role_score":0.88,"survived":true,"correct_accusations":0,"false_accusations":0,"seer_checks":1,"protections_of_villagers":0,"protections_of_wolves":0,"seer_clears":1,"night_actions_used":1,"partner_votes":0,"team":"villagers"},"Iris":{"status":"dead","role":"werewolf","model":"opencode_go/deepseek-v4-flash","statements":1,"votes_for_werewolf":0,"votes_for_villager":2,"successful_kills":1,"wolf_checks_found":0,"doctor_saves":0,"team_won":false,"skip_votes":0,"failed_kills":0,"missed_decisions":0,"role_score":0.3,"survived":false,"correct_accusations":0,"false_accusations":0,"seer_checks":0,"protections_of_villagers":0,"protections_of_wolves":0,"seer_clears":0,"night_actions_used":1,"partner_votes":0,"team":"werewolves"}},"benchmark_focus":"hidden-information reasoning, persuasion, and role execution"}}',
];

/* ================= go ================= */

boot();
