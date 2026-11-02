const escape = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const STYLE = `
  :root { --bg:#f6f7f5; --card:#fff; --ink:#1c2321; --muted:#5f6b67; --line:#dfe4e1; --bad:#b3261e; --accent:#1f8a4c; }
  @media (prefers-color-scheme: dark) { :root { --bg:#121514; --card:#1b201e; --ink:#e7ecea; --muted:#9aa6a1; --line:#2c3431; --bad:#f2827a; --accent:#4cc382; } }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--ink); font:16px/1.5 system-ui, -apple-system, sans-serif; }
  main { max-width:420px; margin:0 auto; padding:48px 16px 64px; }
  h1 { font-size:22px; margin:0 0 4px; }
  .sub { color:var(--muted); margin:0 0 24px; }
  section { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:20px; }
  label { display:block; font-size:14px; color:var(--muted); margin-bottom:6px; }
  input[type=password] { width:100%; font:inherit; padding:10px 12px; border:1px solid var(--line); border-radius:8px; background:var(--bg); color:var(--ink); }
  button { width:100%; margin-top:14px; font:inherit; font-weight:600; border-radius:8px; border:1px solid var(--accent); background:var(--accent); color:#fff; padding:10px 14px; cursor:pointer; }
  .err { color:var(--bad); margin:0 0 12px; }
  .client { margin:0 0 16px; }
  .client b { display:block; font-size:18px; }
  code { font-family:ui-monospace, SFMono-Regular, Menlo, monospace; font-size:14px; }
`;

export interface LoginPageOptions {
  /** Where the form posts. */
  action: string;
  /** Carried through the form unchanged (the OAuth request). */
  hidden?: Record<string, string | undefined>;
  /** The assistant asking for access, when this is an authorization. */
  client?: { name: string; redirectHost: string };
  /** The owner's cookie is valid: one click, no passphrase. */
  signedIn?: boolean;
  error?: string;
}

/** The page where the owner types the passphrase: to open the status page, or to let an assistant in. */
export function loginPage({ action, hidden = {}, client, signedIn = false, error }: LoginPageOptions): string {
  const fields = Object.entries(hidden)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `<input type="hidden" name="${escape(k)}" value="${escape(v!)}">`)
    .join('\n      ');
  const title = client ? 'Allow access to your WhatsApp?' : 'Sign in';
  const who = client
    ? `<p class="client"><b>${escape(client.name)}</b>wants to use wuzapi-mcp as you. After you allow it, it is sent back to <code>${escape(client.redirectHost)}</code>.</p>`
    : '';
  const ask = signedIn
    ? ''
    : `<label for="passphrase">Passphrase</label>
      <input id="passphrase" name="passphrase" type="password" autocomplete="current-password" autofocus required>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>wuzapi-mcp — ${title}</title>
<style>${STYLE}</style>
</head>
<body>
<main>
  <h1>wuzapi-mcp</h1>
  <p class="sub">${title}</p>
  <section>
    ${who}
    ${error ? `<p class="err">${escape(error)}</p>` : ''}
    <form method="post" action="${escape(action)}">
      ${fields}
      ${ask}
      <button type="submit">${client ? 'Allow' : 'Sign in'}</button>
    </form>
  </section>
</main>
</body>
</html>`;
}
