#!/usr/bin/env bash
#
# Fetches a single feature flag from the Datadog API by key or ID.
#
# Usage:
#   DD_SITE=datadoghq.com DD_API_KEY=<key> DD_APP_KEY=<key> ./scripts/get-datadog-flag.sh --key=<flag-key>
#   DD_SITE=datadoghq.com DD_API_KEY=<key> DD_APP_KEY=<key> ./scripts/get-datadog-flag.sh --id=<flag-id>
#   DD_SITE=us5.datadoghq.com DD_API_KEY=<key> DD_APP_KEY=<key> ./scripts/get-datadog-flag.sh --key=<flag-key>

set -euo pipefail

usage() {
    cat >&2 <<EOF
Usage: $(basename "$0") [OPTIONS] (--key=<flag-key> | --id=<flag-id>)

Fetch a single feature flag from the Datadog API.

Options:
  --key=<flag-key>   Look up a flag by its key
  --id=<flag-id>     Look up a flag by its UUID
  -h, --help         Show this help message

Environment variables:
  DD_SITE            Datadog site host (required), e.g. us5.datadoghq.com
  DD_API_KEY         Datadog API key (required)
  DD_APP_KEY         Datadog application key (required)
EOF
}

SITE="${DD_SITE:-}"
FLAG_ID=""
FLAG_KEY=""

if [[ $# -eq 0 ]]; then
    usage
    exit 1
fi

for arg in "$@"; do
    case "$arg" in
        --id=*)   FLAG_ID="${arg#--id=}" ;;
        --key=*)  FLAG_KEY="${arg#--key=}" ;;
        -h|--help) usage; exit 0 ;;
        *) echo "Error: unknown argument: $arg" >&2; usage; exit 1 ;;
    esac
done

if [[ -z "$FLAG_ID" && -z "$FLAG_KEY" ]]; then
    echo "Error: either --key or --id is required." >&2
    usage
    exit 1
fi

if [[ -z "$SITE" ]]; then
    echo "Error: DD_SITE environment variable is not set." >&2
    exit 1
fi

if [[ -z "${DD_API_KEY:-}" ]]; then
    echo "Error: DD_API_KEY environment variable is not set." >&2
    exit 1
fi

if [[ -z "${DD_APP_KEY:-}" ]]; then
    echo "Error: DD_APP_KEY environment variable is not set." >&2
    exit 1
fi

DD_HEADERS=(
    -H "dd-api-key: ${DD_API_KEY}"
    -H "dd-application-key: ${DD_APP_KEY}"
    -H "Content-Type: application/vnd.api+json"
)

if [[ -n "$FLAG_KEY" ]]; then
    response=$(curl -sL "${DD_HEADERS[@]}" \
        "https://api.${SITE}/api/v2/feature-flags?key=$(python3 -c "import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1]))" "$FLAG_KEY")")

    FLAG_ID=$(echo "$response" | jq -r --arg key "$FLAG_KEY" '
        .data[] | select(.attributes.key == $key) | .id
    ')

    if [[ -z "$FLAG_ID" ]]; then
        echo "Error: no feature flag found with key '$FLAG_KEY'." >&2
        exit 1
    fi
fi

curl -sL "${DD_HEADERS[@]}" \
    "https://api.${SITE}/api/v2/feature-flags/${FLAG_ID}" \
    | jq .
