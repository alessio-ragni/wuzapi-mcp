/** The status page: link state, the QR when not linked, archive numbers, and how to connect Claude. */
export function statusPage(mcpUrl: string): string {
  const addCommand = `claude mcp add --transport http --scope user whatsapp ${mcpUrl}`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>wuzapi-mcp</title>
<style>
  :root { --bg:#f6f7f5; --card:#fff; --ink:#1c2321; --muted:#5f6b67; --line:#dfe4e1; --ok:#1f8a4c; --warn:#b26a00; --bad:#b3261e; }
  @media (prefers-color-scheme: dark) { :root { --bg:#121514; --card:#1b201e; --ink:#e7ecea; --muted:#9aa6a1; --line:#2c3431; --ok:#4cc382; --warn:#e0a23b; --bad:#f2827a; } }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--ink); font:16px/1.5 system-ui, -apple-system, sans-serif; }
  main { max-width:760px; margin:0 auto; padding:32px 16px 64px; }
  h1 { font-size:22px; margin:0 0 4px; }
  .sub { color:var(--muted); margin:0 0 24px; }
  section { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:20px; margin-bottom:16px; }
  h2 { font-size:15px; text-transform:uppercase; letter-spacing:.04em; color:var(--muted); margin:0 0 12px; }
  .state { font-size:20px; font-weight:600; }
  .ok { color:var(--ok); } .warn { color:var(--warn); } .bad { color:var(--bad); }
  #qr { display:block; margin:16px auto 8px; width:280px; height:280px; background:#fff; padding:12px; border-radius:8px; }
  .center { text-align:center; }
  dl { display:grid; grid-template-columns:max-content 1fr; gap:6px 16px; margin:0; }
  dt { color:var(--muted); }
  dd { margin:0; font-variant-numeric:tabular-nums; }
  code, pre { font-family:ui-monospace, SFMono-Regular, Menlo, monospace; font-size:14px; }
  pre { background:var(--bg); border:1px solid var(--line); border-radius:8px; padding:12px; white-space:pre-wrap; word-break:break-all; margin:8px 0; }
  button { font:inherit; border-radius:8px; border:1px solid var(--line); background:var(--card); color:var(--ink); padding:8px 14px; cursor:pointer; }
  button.danger { border-color:var(--bad); color:var(--bad); }
  .hidden { display:none; }
</style>
</head>
<body>
<main>
  <h1>wuzapi-mcp</h1>
  <p class="sub">Your WhatsApp, archived on this machine and available to Claude.</p>

  <section>
    <h2>WhatsApp</h2>
    <div id="state" class="state">Checking…</div>
    <p id="detail" class="sub" style="margin:4px 0 0"></p>
    <div id="qrbox" class="center hidden">
      <img id="qr" alt="QR code to link WhatsApp">
      <p>WhatsApp → Settings → Linked devices → Link a device</p>
    </div>
    <p id="unlinkbox" class="hidden"><button id="unlink" class="danger">Unlink and delete the archive</button></p>
  </section>

  <section>
    <h2>Archive</h2>
    <dl>
      <dt>Chats</dt><dd id="chats">–</dd>
      <dt>Messages</dt><dd id="messages">–</dd>
      <dt>Contacts</dt><dd id="contacts">–</dd>
      <dt>From</dt><dd id="oldest">–</dd>
      <dt>Latest</dt><dd id="newest">–</dd>
      <dt>Import</dt><dd id="backfill">–</dd>
    </dl>
  </section>

  <section>
    <h2>Connect Claude Code</h2>
    <p>Run once in a terminal on this machine, then restart Claude Code:</p>
    <pre>${addCommand}</pre>
    <p class="sub" style="margin:0">MCP endpoint: <code>${mcpUrl}</code></p>
  </section>
</main>
<script>
const $ = (id) => document.getElementById(id);
const fmt = (s) => s ? new Date(s * 1000).toLocaleString() : '–';
const num = (n) => typeof n === 'number' ? n.toLocaleString() : '–';

async function refresh() {
  let s;
  try {
    const res = await fetch('/api/status', { cache: 'no-store' });
    s = await res.json();
  } catch {
    $('state').textContent = 'wuzapi-mcp is not answering';
    $('state').className = 'state bad';
    return;
  }
  const linked = s.whatsapp.loggedIn;
  $('qrbox').classList.toggle('hidden', linked || !s.whatsapp.qr);
  $('unlinkbox').classList.toggle('hidden', !linked);
  if (!s.whatsapp.reachable) {
    $('state').textContent = 'WuzAPI is not answering';
    $('state').className = 'state bad';
    $('detail').textContent = s.whatsapp.error || '';
  } else if (linked) {
    $('state').textContent = 'Linked';
    $('state').className = 'state ok';
    $('detail').textContent = s.whatsapp.phone ? '+' + s.whatsapp.phone : '';
  } else if (s.whatsapp.qr) {
    $('state').textContent = 'Not linked — scan the QR';
    $('state').className = 'state warn';
    $('detail').textContent = 'The code changes every few seconds; this page follows it.';
    if ($('qr').src !== s.whatsapp.qr) $('qr').src = s.whatsapp.qr;
  } else {
    $('state').textContent = 'Not linked — waiting for a QR…';
    $('state').className = 'state warn';
    $('detail').textContent = '';
  }
  $('chats').textContent = num(s.archive.chats);
  $('messages').textContent = num(s.archive.messages);
  $('contacts').textContent = num(s.archive.contacts);
  $('oldest').textContent = fmt(s.archive.oldest);
  $('newest').textContent = fmt(s.archive.newest);
  $('backfill').textContent = s.backfill;
}

$('unlink').addEventListener('click', async () => {
  if (!confirm('Unlink WhatsApp from this server and delete every archived message?')) return;
  $('unlink').disabled = true;
  await fetch('/api/unlink', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  $('unlink').disabled = false;
  refresh();
});

refresh();
setInterval(refresh, 2000);
</script>
</body>
</html>`;
}
