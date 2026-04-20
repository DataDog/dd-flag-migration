#!/usr/bin/env bash
#
# Fetches segments from LaunchDarkly for every project/environment and saves
# each segment as a separate JSON file.
#
# Directory structure:
#   launchdarkly-requests/projects/<project-key>/segments/<env-key>/<segment-key>.json
#
# Rate-limit strategy (same as fetch-launchdarkly-flags.sh):
#   - Reads X-Ratelimit-Route-Remaining and X-Ratelimit-Auth-Token-Remaining
#     from every response.
#   - When either remaining count drops below a safety threshold, sleeps
#     until the reset time indicated by the corresponding header.
#   - Adds a small delay between requests to stay under the route limit.
#
# Usage:
#   ./scripts/fetch-launchdarkly-segments.sh           # skips projects that already have segments on disk
#   ./scripts/fetch-launchdarkly-segments.sh --force   # re-fetches all segments even if they exist

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

project_data=$(python3 -c "
import json, sys
data = json.load(sys.stdin)
for p in data.get('items', []):
    envs = ','.join(p.get('environments', {}).get('items', [{}])[0].keys() if False else [e['key'] for e in p.get('environments', {}).get('items', [])])
    print(p['key'] + '|' + envs)
" < "$RESPONSE_BODY_FILE")

# If the projects response doesn't include environment details, fall back to
# discovering environments from existing flag files on disk.
# Try a simpler parse first — just get project keys, then discover envs per project.
project_keys=$(python3 -c "
import json, sys
data = json.load(sys.stdin)
for p in data.get('items', []):
    print(p['key'])
" < "$RESPONSE_BODY_FILE")

project_count=$(echo "$project_keys" | wc -l | tr -d ' ')
log "Found $project_count projects"

# ── Step 2: For each project, discover environments and fetch segments ───────
for project_key in $project_keys; do
    segments_dir="${OUTPUT_DIR}/${project_key}/segments"

    # Skip projects that already have segments on disk unless --force is set
    if [[ "$FORCE" == "false" && -d "$segments_dir" ]]; then
        log "Skipping project: $project_key (segments already exist, use --force to re-fetch)"
        continue
    fi

    log "Processing project: $project_key"

    # Discover environment keys from existing flag files on disk
    flags_dir="${OUTPUT_DIR}/${project_key}/flags"
    if [[ ! -d "$flags_dir" ]]; then
        log "  WARNING: No flags directory found for project, fetching environment list from API"
        sleep "$MIN_DELAY"
        api_get "${BASE_URL}/api/v2/projects/${project_key}?expand=environments"

        if [[ "$HTTP_STATUS" != "200" ]]; then
            log "  WARNING: Failed to fetch project details (HTTP $HTTP_STATUS), skipping"
            continue
        fi

        env_keys=$(python3 -c "
import json, sys
data = json.load(sys.stdin)
for e in data.get('environments', []):
    print(e['key'])
" < "$RESPONSE_BODY_FILE")
    else
        # Extract environment keys from the first flag file
        env_keys=$(python3 -c "
import json, sys, glob, os
flags_dir = sys.argv[1]
for f in sorted(glob.glob(os.path.join(flags_dir, '*.json')))[:1]:
    with open(f) as fh:
        data = json.load(fh)
        for env_key in data.get('environments', {}):
            print(env_key)
" "$flags_dir")
    fi

    if [[ -z "$env_keys" ]]; then
        log "  No environments found, skipping project"
        continue
    fi

    env_list=$(echo "$env_keys" | tr '\n' ', ' | sed 's/,$//')
    log "  Environments: $env_list"

    for env_key in $env_keys; do
        env_segments_dir="${segments_dir}/${env_key}"
        mkdir -p "$env_segments_dir"

        # Paginate through the segment list to collect all segment keys
        offset=0
        limit=20
        total_segments=0
        all_segment_keys=()

        while true; do
            sleep "$MIN_DELAY"
            api_get "${BASE_URL}/api/v2/segments/${project_key}/${env_key}?limit=${limit}&offset=${offset}"

            if [[ "$HTTP_STATUS" != "200" ]]; then
                log "    WARNING: Failed to list segments for ${env_key} at offset $offset (HTTP $HTTP_STATUS), skipping"
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
                total_segments=$(echo "$read_result" | head -1)
                if (( total_segments == 0 )); then
                    break
                fi
                log "    Environment ${env_key}: $total_segments segments"
            fi

            page_keys=$(echo "$read_result" | tail -n +2)
            if [[ -z "$page_keys" ]]; then
                break
            fi

            while IFS= read -r key; do
                all_segment_keys+=("$key")
            done <<< "$page_keys"

            page_count=$(echo "$page_keys" | wc -l | tr -d ' ')
            offset=$(( offset + page_count ))

            if (( offset >= total_segments )); then
                break
            fi
        done

        if (( ${#all_segment_keys[@]} == 0 )); then
            continue
        fi

        # Fetch full details for each segment
        fetched=0
        for segment_key in "${all_segment_keys[@]}"; do
            output_file="${env_segments_dir}/${segment_key}.json"

            # Skip if already fetched (allows resuming interrupted runs)
            if [[ -f "$output_file" ]]; then
                fetched=$(( fetched + 1 ))
                continue
            fi

            sleep "$MIN_DELAY"
            api_get "${BASE_URL}/api/v2/segments/${project_key}/${env_key}/${segment_key}"

            if [[ "$HTTP_STATUS" == "200" ]]; then
                cp "$RESPONSE_BODY_FILE" "$output_file"
                fetched=$(( fetched + 1 ))
                if (( fetched % 50 == 0 )); then
                    log "    Progress: ${fetched}/${#all_segment_keys[@]} segments"
                    log "    Rate limits — route: ${RL_ROUTE_REMAINING:-?} remaining, token: ${RL_TOKEN_REMAINING:-?} remaining"
                fi
            else
                log "    WARNING: Failed to fetch segment '${segment_key}' (HTTP $HTTP_STATUS)"
            fi
        done

        log "    Done: ${fetched}/${#all_segment_keys[@]} segments saved to ${env_segments_dir}"
    done
done

log "All projects complete."
