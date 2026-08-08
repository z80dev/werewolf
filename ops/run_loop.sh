#!/usr/bin/env bash
# Werewolf stream runner loop: plays LemonSim werewolf games back to back,
# maintains /data/games.json per the shared API contract.
set -u

DATA_DIR="${DATA_DIR:-/data}"
GAMES_DIR="$DATA_DIR/games"
GAMES_JSON="$DATA_DIR/games.json"
MODELS="opencode_go:deepseek-v4-flash,opencode_go:deepseek-v4-flash,opencode_go:deepseek-v4-flash,opencode_go:deepseek-v4-flash,opencode_go:deepseek-v4-flash,opencode_go:deepseek-v4-flash"
SLEEP_AFTER_OK=30
SLEEP_AFTER_FAIL=60
LIVE_AGE_SECONDS=60
KEEP_GAMES=50

log() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*"; }

mkdir -p "$GAMES_DIR"

# Atomic rebuild of /data/games.json from /data/games/*.jsonl.
# Per file: game_start -> players/player_count/started_at; game_over -> winner;
# turn_result line count -> steps. Newest file younger than LIVE_AGE_SECONDS is "live".
rebuild_games_json() {
  local tmp entries newest now newest_age live_id
  tmp="$(mktemp)"
  entries=0
  live_id=""

  newest=""
  for f in "$GAMES_DIR"/*.jsonl; do
    [ -f "$f" ] || continue
    if [ -z "$newest" ] || [ "$f" -nt "$newest" ]; then newest="$f"; fi
  done

  now="$(date +%s)"
  newest_age=999999
  if [ -n "$newest" ]; then
    newest_age=$(( now - $(stat -c %Y "$newest") ))
  fi

  for f in "$GAMES_DIR"/*.jsonl; do
    [ -f "$f" ] || continue
    local id status
    id="$(basename "$f" .jsonl)"
    status="finished"
    if [ "$f" = "$newest" ] && [ "$newest_age" -lt "$LIVE_AGE_SECONDS" ]; then
      status="live"
      live_id="$id"
    fi
    jq -c -n --arg id "$id" --arg status "$status" '
      [inputs] as $lines |
      (($lines | map(select(.type == "game_start")) | first // null) // null) as $start |
      (($lines | map(select(.type == "game_over")) | last // null) // null) as $over |
      {
        id: $id,
        file: ("games/" + $id + ".jsonl"),
        started_at: (($start // {}).timestamp // null),
        status: $status,
        player_count: (($start // {}).player_count // 0),
        players: ((($start // {}).players // {}) | with_entries(.value = {name: .value.name, role: .value.role, model: .value.model})),
        winner: (($over // {}).winner // null),
        steps: ($lines | map(select(.type == "turn_result")) | length)
      }' "$f" >> "$tmp" || { rm -f "$tmp"; return 1; }
    entries=$((entries + 1))
  done

  jq -s --arg updated "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg live "$live_id" '
    {
      updated_at: $updated,
      live: (if $live == "" then null else $live end),
      games: (map(select(.started_at != null)) | sort_by(.started_at) | reverse | .[0:50])
    }' "$tmp" > "$GAMES_JSON.tmp" || { rm -f "$tmp"; return 1; }
  mv "$GAMES_JSON.tmp" "$GAMES_JSON"
  rm -f "$tmp"
  log "games.json rebuilt ($entries games, live=${live_id:-none})"
  return 0
}

# Initial games.json per contract (volume starts empty).
if [ ! -f "$GAMES_JSON" ]; then
  printf '{"updated_at":"%s","live":null,"games":[]}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$GAMES_JSON"
  log "initialized $GAMES_JSON"
fi

while true; do
  id="ww_$(date +%Y%m%d_%H%M%S)"
  while [ -e "$GAMES_DIR/$id.jsonl" ]; do
    sleep 1
    id="ww_$(date +%Y%m%d_%H%M%S)"
  done
  transcript="$GAMES_DIR/$id.jsonl"

  log "starting game $id"

  # Live games.json updater: refresh every 15s while the transcript exists.
  # (Transcript may not exist yet when this starts — mix creates it ~1s in.)
  (
    while true; do
      sleep 15
      rebuild_games_json >/dev/null 2>&1 || true
      [ -e "$transcript" ] || break
    done
  ) &
  updater_pid=$!

  (cd /app && mix lemon.sim.werewolf \
    --player-count 6 \
    --models "$MODELS" \
    --transcript-path "$transcript" \
    --no-persist)
  rc=$?

  kill "$updater_pid" 2>/dev/null || true
  wait "$updater_pid" 2>/dev/null || true

  rebuild_games_json || log "warning: games.json rebuild failed"

  if [ "$rc" -eq 0 ]; then
    log "game $id finished cleanly"
    sleep "$SLEEP_AFTER_OK"
  else
    log "game $id FAILED (rc=$rc); retrying in ${SLEEP_AFTER_FAIL}s"
    sleep "$SLEEP_AFTER_FAIL"
  fi
done
