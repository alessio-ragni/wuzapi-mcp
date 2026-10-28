#!/usr/bin/env bash
# Links your WhatsApp to WuzAPI.
#
# Creates the WuzAPI user from .env if it does not exist yet, saves the history settings,
# starts the session, shows the QR in a local page that refreshes itself, and waits until
# the phone has scanned it. Running it again on a linked account just reports the status.
#
# WuzAPI's own /login page is not used: in 1.1.0 it reads the status with the wrong field
# names, says "Connected!" and never shows the QR.
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
  curl -fsS "${user[@]}" "$base/session/status" | jq -e '(.data.loggedIn // .data.LoggedIn) == true' >/dev/null
}

if logged_in; then
  echo "Already linked: WhatsApp is connected."
  exit 0
fi

curl -fsS -o /dev/null "${user[@]}" "${json[@]}" -X POST "$base/session/connect" \
  --data '{"Subscribe":["Message","HistorySync"],"Immediate":true}' 2>/dev/null || true

# A page outside the repository, rewritten every couple of seconds; the browser reloads it.
page="$(mktemp -d)/pair.html"
write_page() { # $1 = body
  printf '<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="2">
<title>Link WhatsApp</title>
<body style="font-family:system-ui;text-align:center;padding:40px">%s</body>' "$1" > "$page"
}
write_page "<p>Waiting for the QR…</p>"
echo "Scan the QR with WhatsApp → Settings → Linked devices → Link a device."
echo "  file://$page"
command -v open >/dev/null && open "$page" || true

for _ in $(seq 1 120); do
  if logged_in; then
    write_page "<h1>Linked ✓</h1><p>You can close this page.</p>"
    echo "Linked: WhatsApp is connected."
    exit 0
  fi
  qr=$(curl -fsS "${user[@]}" "$base/session/qr" 2>/dev/null | jq -r '.data.QRCode // empty' || true)
  if [[ -n "$qr" ]]; then
    write_page "<h1>Link WhatsApp</h1><p>WhatsApp → Settings → Linked devices → Link a device</p><img src=\"$qr\" width=320 height=320>"
  else
    # WhatsApp stops issuing codes after a minute or two; start a fresh round.
    if ! curl -fsS "${user[@]}" "$base/session/status" | jq -e '.data.connected == true' >/dev/null; then
      curl -fsS -o /dev/null "${user[@]}" "${json[@]}" -X POST "$base/session/connect" \
        --data '{"Subscribe":["Message","HistorySync"],"Immediate":true}' 2>/dev/null || true
    fi
    write_page "<p>No QR right now — WuzAPI is between codes. This page refreshes by itself.</p>"
  fi
  sleep 2
done
write_page "<p>Timed out. Run <code>scripts/pair.sh</code> again for a fresh QR.</p>"
echo "Still not linked after 4 minutes. Run scripts/pair.sh again for a fresh QR." >&2
exit 1
