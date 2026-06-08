#!/usr/bin/env bash
# Fetch the raw Eppo API response for a single flag and print all fields.
# Usage: ./scripts/eppo-raw.sh <flag-key>
set -euo pipefail

FLAG_KEY="${1:-}"
if [[ -z "$FLAG_KEY" ]]; then
  echo "Usage: $0 <flag-key>" >&2
  exit 1
fi

CONFIG="$HOME/.dd-flag-migration/config.json"
API_KEY="$(python3 -c "import json,sys; print(json.load(open('$CONFIG'))['eppoApiKey'])")"

# Fetch one page at a time until we find the flag (avoids pulling every flag).
OFFSET=0
LIMIT=100
while true; do
  PAGE="$(curl -sf \
    -H "x-eppo-token: $API_KEY" \
    -H "Content-Type: application/json" \
    "https://eppo.cloud/api/v1/feature-flags?include_detailed_allocations=true&offset=$OFFSET&limit=$LIMIT")"

  # Support both array response and {data:[...]} envelope.
  FLAGS="$(echo "$PAGE" | python3 -c "
import json,sys
raw=json.load(sys.stdin)
flags=raw['data'] if isinstance(raw,dict) and 'data' in raw else raw
print(json.dumps(flags))
")"

  MATCH="$(echo "$FLAGS" | python3 -c "
import json,sys
flags=json.load(sys.stdin)
match=[f for f in flags if f.get('key')=='$FLAG_KEY']
print(json.dumps(match, indent=2))
")"

  if [[ "$MATCH" != "[]" ]]; then
    echo "$MATCH"
    exit 0
  fi

  PAGE_LEN="$(echo "$FLAGS" | python3 -c "import json,sys; print(len(json.load(sys.stdin)))")"
  if [[ "$PAGE_LEN" -lt "$LIMIT" ]]; then
    echo "Flag '$FLAG_KEY' not found in Eppo." >&2
    exit 1
  fi
  OFFSET=$((OFFSET + LIMIT))
done
