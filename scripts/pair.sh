#!/usr/bin/env bash
# Links your WhatsApp to WuzAPI.
#
# Creates the WuzAPI user from .env if it does not exist yet, saves the history settings,
# starts the session, opens WuzAPI's QR page on this machine and waits until the phone
# has scanned it. Running it again on a linked account just reports the status.
set -euo pipefail
cd "$(dirname "$0")/.."

[[ -f .env ]] || { echo "No .env — run scripts/init-env.sh first." >&2; exit 1; }
set -a; source .env; set +a

base="http://127.0.0.1:${WUZAPI_HOST_PORT:-8090}"
admin=(-H "Authorization: ${WUZAPI_ADMIN_TOKEN}")
user=(-H "Token: ${WUZAPI_USER_TOKEN}")
json=(-H "Content-Type: application/json")

for _ in $(seq 1 30); do
  curl -fsS -o /dev/null "${admin[@]}" "$base/admin/users" 2>/dev/null && break
  sleep 1
done
curl -fsS -o /dev/null "${admin[@]}" "$base/admin/users" \
  || { echo "WuzAPI is not answering on $base — is 'docker compose up -d' running?" >&2; exit 1; }

exists=$(curl -fsS "${admin[@]}" "$base/admin/users" \
  | jq --arg t "$WUZAPI_USER_TOKEN" '[.data[]? | select(.token == $t)] | length')
if [[ "$exists" == "0" ]]; then
  curl -fsS -o /dev/null "${admin[@]}" "${json[@]}" -X POST "$base/admin/users" \
    --data "$(jq -n --arg n "$WUZAPI_USER_NAME" --arg t "$WUZAPI_USER_TOKEN" \
      '{name: $n, token: $t, events: "Message,HistorySync"}')"
  echo "Created WuzAPI user '$WUZAPI_USER_NAME'."
fi

curl -fsS -o /dev/null "${user[@]}" "${json[@]}" -X POST "$base/session/history" \
  --data "$(jq -n --argjson h "${WUZAPI_HISTORY_PER_CHAT:-1000}" --argjson d "${WUZAPI_SYNC_DAYS:-365}" \
    '{history: $h, days_to_sync_history: $d}')"

logged_in() {
  curl -fsS "${user[@]}" "$base/session/status" | jq -e '.data.LoggedIn == true' >/dev/null
}

if logged_in; then
  echo "Already linked: WhatsApp is connected."
  exit 0
fi

curl -fsS -o /dev/null "${user[@]}" "${json[@]}" -X POST "$base/session/connect" \
  --data '{"Subscribe":["Message","HistorySync"],"Immediate":true}' || true

page="$base/login/?token=${WUZAPI_USER_TOKEN}"
echo "Scan the QR with WhatsApp → Settings → Linked devices → Link a device:"
echo "  $page"
command -v open >/dev/null && open "$page" || true

for _ in $(seq 1 120); do
  if logged_in; then
    echo "Linked: WhatsApp is connected."
    exit 0
  fi
  sleep 2
done
echo "Still not linked after 4 minutes. Reload the page for a fresh QR, then run this again." >&2
exit 1
