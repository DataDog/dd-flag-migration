#!/usr/bin/env bash
#
# Fetches full flag details from LaunchDarkly for every project and saves
# each flag as a separate JSON file.
#
# Directory structure:
#   launchdarkly-requests/projects/<project-key>/flags/<flag-key>.json
#
# Rate-limit strategy:
#   - Reads X-Ratelimit-Route-Remaining and X-Ratelimit-Auth-Token-Remaining
#     from every response.
#   - When either remaining count drops below a safety threshold, sleeps
#     until the reset time indicated by the corresponding header.
#   - Adds a small delay between requests to stay under the route limit.
#
# Usage:
#   ./scripts/fetch-launchdarkly-flags.sh           # skips projects that already exist on disk
#   ./scripts/fetch-launchdarkly-flags.sh --force   # re-fetches all projects even if they exist

set -euo pipefail

FORCE=false
for arg in "$@"; do
    case "$arg" in
        --force) FORCE=true ;;
        *) echo "Unknown argument: $arg" >&2; echo "Usage: $0 [--force]" >&2; exit 1 ;;
    esac
done

BASE_URL="https://app.launchdarkly.com"
if [[ -z "${LAUNCHDARKLY_API_KEY:-}" ]]; then
    printf "Enter your LaunchDarkly API key: " >&2
    read -r LAUNCHDARKLY_API_KEY
    if [[ -z "$LAUNCHDARKLY_API_KEY" ]]; then
        echo "Error: API key cannot be empty." >&2
        exit 1
    fi
fi
API_KEY="$LAUNCHDARKLY_API_KEY"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
OUTPUT_DIR="${PROJECT_ROOT}/launchdarkly-requests/projects"

# Safety thresholds — sleep when remaining drops to or below these values.
ROUTE_THRESHOLD=5
TOKEN_THRESHOLD=50

# Minimum delay (seconds) between requests to avoid bursting the route limit.
MIN_DELAY=0.25

# Globals set by api_get (written to files to avoid subshell issues)
RESPONSE_BODY_FILE=$(mktemp)
RESPONSE_HEADERS_FILE=$(mktemp)
HTTP_STATUS=""
RL_ROUTE_REMAINING=""
RL_TOKEN_REMAINING=""
RL_ROUTE_RESET=""
RL_TOKEN_RESET=""

trap 'rm -f "$RESPONSE_BODY_FILE" "$RESPONSE_HEADERS_FILE"' EXIT

log() {
    echo "[$(date '+%H:%M:%S')] $*"
}

now_ms() {
    if command -v perl &>/dev/null; then
        perl -e 'use Time::HiRes qw(time); printf "%d\n", time()*1000'
    else
        echo "$(date +%s)000"
    fi
}

# Sleeps until the given epoch-millis reset time (plus a 1-second buffer).
sleep_until_reset() {
    local reset_ms="$1"
    local label="$2"
    local current_ms
    current_ms=$(now_ms)
    local wait_ms=$(( reset_ms - current_ms + 1000 ))
    if (( wait_ms > 0 )); then
        local wait_s
        wait_s=$(perl -e "printf '%.1f', $wait_ms / 1000.0" 2>/dev/null || echo $(( wait_ms / 1000 )))
        log "Rate limit ($label) nearly exhausted — sleeping ${wait_s}s until reset"
        sleep "$wait_s"
    fi
}

# Makes a GET request with rate-limit awareness.
# Response body is written to $RESPONSE_BODY_FILE.
# Sets globals: HTTP_STATUS, RL_ROUTE_REMAINING, RL_TOKEN_REMAINING, RL_ROUTE_RESET, RL_TOKEN_RESET
api_get() {
    local url="$1"

    HTTP_STATUS=$(curl -s -o "$RESPONSE_BODY_FILE" -D "$RESPONSE_HEADERS_FILE" \
        -w '%{http_code}' \
        -H "Authorization: ${API_KEY}" \
        "$url")

    # Parse rate-limit headers (case-insensitive)
    RL_ROUTE_REMAINING=$(grep -i '^x-ratelimit-route-remaining:' "$RESPONSE_HEADERS_FILE" | tr -d '\r' | awk '{print $2}' || true)
    RL_TOKEN_REMAINING=$(grep -i '^x-ratelimit-auth-token-remaining:' "$RESPONSE_HEADERS_FILE" | tr -d '\r' | awk '{print $2}' || true)
    RL_ROUTE_RESET=$(grep -i '^x-ratelimit-reset:' "$RESPONSE_HEADERS_FILE" | tr -d '\r' | awk '{print $2}' || true)
    RL_TOKEN_RESET=$(grep -i '^x-ratelimit-auth-token-reset:' "$RESPONSE_HEADERS_FILE" | tr -d '\r' | awk '{print $2}' || true)

    # If we got 429, sleep and retry (max 3 attempts)
    if [[ "$HTTP_STATUS" == "429" ]]; then
        local retries="${2:-0}"
        if (( retries >= 3 )); then
            log "ERROR: Got 429 Too Many Requests after $retries retries — giving up"
            return 1
        fi
        log "Got 429 Too Many Requests — backing off (attempt $((retries + 1))/3)"
        if [[ -n "$RL_ROUTE_RESET" ]]; then
            sleep_until_reset "$RL_ROUTE_RESET" "429-retry"
        else
            sleep 10
        fi
        api_get "$url" "$((retries + 1))"
        return
    fi

    # Proactive rate-limit check for upcoming requests
    if [[ -n "$RL_ROUTE_REMAINING" ]] && (( RL_ROUTE_REMAINING <= ROUTE_THRESHOLD )); then
        sleep_until_reset "${RL_ROUTE_RESET:-0}" "route"
    fi
    if [[ -n "$RL_TOKEN_REMAINING" ]] && (( RL_TOKEN_REMAINING <= TOKEN_THRESHOLD )); then
        sleep_until_reset "${RL_TOKEN_RESET:-0}" "auth-token"
    fi
}

# ── Step 1: Fetch all projects ───────────────────────────────────────────────
log "Fetching projects..."
log "Output directory: ${OUTPUT_DIR}"
mkdir -p "$OUTPUT_DIR"
api_get "${BASE_URL}/api/v2/projects"

if [[ "$HTTP_STATUS" != "200" ]]; then
    echo "Failed to fetch projects (HTTP $HTTP_STATUS):" >&2
    cat "$RESPONSE_BODY_FILE" >&2
    exit 1
fi

project_keys=$(python3 -c "
import json, sys
data = json.load(sys.stdin)
for p in data.get('items', []):
    print(p['key'])
" < "$RESPONSE_BODY_FILE")

project_count=$(echo "$project_keys" | wc -l | tr -d ' ')
log "Found $project_count projects"

# ── Step 2: For each project, list flags then fetch full details ─────────────
for project_key in $project_keys; do
    project_dir="${OUTPUT_DIR}/${project_key}/flags"

    # Skip projects that already exist on disk unless --force is set
    if [[ "$FORCE" == "false" && -d "$project_dir" ]]; then
        log "Skipping project: $project_key (already exists, use --force to re-fetch)"
        continue
    fi

    log "Processing project: $project_key"
    mkdir -p "$project_dir"

    # Paginate through the flag list (summary) to collect all flag keys
    offset=0
    limit=20
    total_flags=0
    all_flag_keys=()

    while true; do
        sleep "$MIN_DELAY"
        api_get "${BASE_URL}/api/v2/flags/${project_key}?limit=${limit}&offset=${offset}&summary=true"

        if [[ "$HTTP_STATUS" != "200" ]]; then
            log "  WARNING: Failed to list flags at offset $offset (HTTP $HTTP_STATUS), skipping rest of project"
            break
        fi

        read_result=$(python3 -c "
import json, sys
data = json.load(sys.stdin)
total = data.get('totalCount', 0)
keys = [item['key'] for item in data.get('items', [])]
print(total)
for k in keys:
    print(k)
" < "$RESPONSE_BODY_FILE")

        if [[ $offset -eq 0 ]]; then
            total_flags=$(echo "$read_result" | head -1)
            log "  Total flags: $total_flags"
        fi

        page_keys=$(echo "$read_result" | tail -n +2)
        if [[ -z "$page_keys" ]]; then
            break
        fi

        while IFS= read -r key; do
            all_flag_keys+=("$key")
        done <<< "$page_keys"

        page_count=$(echo "$page_keys" | wc -l | tr -d ' ')
        offset=$(( offset + page_count ))

        if (( offset >= total_flags )); then
            break
        fi
    done

    log "  Collected ${#all_flag_keys[@]} flag keys, fetching full details..."

    if (( ${#all_flag_keys[@]} == 0 )); then
        log "  No flags to fetch, skipping project"
        continue
    fi

    # Fetch full details for each flag
    fetched=0
    for flag_key in "${all_flag_keys[@]}"; do
        output_file="${project_dir}/${flag_key}.json"

        # Skip if already fetched (allows resuming interrupted runs)
        if [[ -f "$output_file" ]]; then
            fetched=$(( fetched + 1 ))
            continue
        fi

        sleep "$MIN_DELAY"
        api_get "${BASE_URL}/api/v2/flags/${project_key}/${flag_key}"

        if [[ "$HTTP_STATUS" == "200" ]]; then
            cp "$RESPONSE_BODY_FILE" "$output_file"
            fetched=$(( fetched + 1 ))
            if (( fetched % 50 == 0 )); then
                log "  Progress: ${fetched}/${#all_flag_keys[@]} flags"
                log "  Rate limits — route: ${RL_ROUTE_REMAINING:-?} remaining, token: ${RL_TOKEN_REMAINING:-?} remaining"
            fi
        else
            log "  WARNING: Failed to fetch flag '${flag_key}' (HTTP $HTTP_STATUS)"
        fi
    done

    log "  Done: ${fetched}/${#all_flag_keys[@]} flags saved to ${project_dir}"
done

log "All projects complete."
