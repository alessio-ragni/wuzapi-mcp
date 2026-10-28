import { join } from 'node:path';
import { Archive } from './archive/archive.ts';
import { loadConfig } from './config.ts';
import { buildApp, VERSION } from './http/server.ts';
import { Session } from './session.ts';
import { Wuzapi } from './wuzapi/client.ts';

const log = (...args: unknown[]) => console.log(new Date().toISOString(), ...args);

const config = loadConfig();
const archive = new Archive(join(config.DATA_DIR, 'archive.db'));
const wuzapi = new Wuzapi(config.WUZAPI_URL, config.WUZAPI_USER_TOKEN, config.WUZAPI_ADMIN_TOKEN);
const session = new Session(config, wuzapi, archive);

const app = buildApp({ config, archive, wuzapi, session });
const server = app.listen(config.PORT, config.HOST, () => {
  log(`wuzapi-mcp ${VERSION} listening on ${config.HOST}:${config.PORT} — open ${config.PUBLIC_URL}`);
});

// Bring WuzAPI into shape as soon as it answers: user, events, connection, archive import.
// A linked session reconnects by itself; an unlinked one waits for someone to open the page.
async function check(): Promise<void> {
  const state = await session.state({ connect: false });
  if (!state.reachable) log('WuzAPI not reachable yet:', state.error);
}
void check();
const checker = setInterval(() => void check(), 60_000);

// Contact and group names change; refresh them now and then.
const names = setInterval(() => {
  void session.state({ connect: false }).then(async (s) => {
    if (!s.loggedIn) return;
    await session.syncContacts().catch((err) => log('contacts:', err.message));
    await session.syncGroups().catch((err) => log('groups:', err.message));
  });
}, 30 * 60_000);

function shutdown(): void {
  clearInterval(checker);
  clearInterval(names);
  server.close(() => {
    archive.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 5_000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
