import { z } from 'zod';

const schema = z.object({
  WUZAPI_URL: z.url().default('http://wuzapi:8080'),
  WUZAPI_ADMIN_TOKEN: z.string().min(16),
  WUZAPI_USER_NAME: z.string().min(1).default('owner'),
  WUZAPI_USER_TOKEN: z.string().min(16),
  WUZAPI_GLOBAL_HMAC_KEY: z.string().min(32),
  WUZAPI_HISTORY_PER_CHAT: z.coerce.number().int().min(0).default(0),
  WUZAPI_SYNC_DAYS: z.coerce.number().int().min(0).max(365).default(365),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().positive().default(3000),
  // Host headers the server answers to. Anything else gets a 403 (DNS rebinding protection).
  // The host of PUBLIC_URL is always added.
  ALLOWED_HOSTS: z
    .string()
    .default('127.0.0.1,localhost,wuzapi-mcp')
    .transform((s) => s.split(',').map((h) => h.trim()).filter(Boolean)),
  // The address you open in the browser and give to your assistant. On a server: https://your.host.
  PUBLIC_URL: z.url().default('http://127.0.0.1:8091'),
  // Hosted mode: the passphrase that signs the owner in, on the page and when an assistant connects.
  // Required as soon as PUBLIC_URL is not this computer; unset locally, where nothing else can reach the server.
  OWNER_PASSPHRASE: z.string().min(12, 'at least 12 characters').optional(),
  // The host name Caddy serves (docker-compose.hosted.yml). Must agree with PUBLIC_URL when both are set.
  PUBLIC_HOST: z.string().optional(),
  DATA_DIR: z.string().default('/data'),
  // Files Claude may send must live under this folder on the host (e.g. /Users/me or C:\Users\me).
  FILES_ROOT: z.string().optional(),
  // Where that folder is mounted inside the container (/files in Docker). Defaults to FILES_ROOT:
  // outside Docker the two are the same path.
  FILES_MOUNT: z.string().optional(),
  // Where downloaded media lands on the host: the path Claude reports back.
  DOWNLOADS_DIR: z.string().optional(),
  // Where that folder is mounted inside the container (/downloads in Docker). Defaults to DOWNLOADS_DIR.
  DOWNLOADS_MOUNT: z.string().optional(),
  TRANSCRIPTION_PROVIDER: z.enum(['off', 'openai', 'elevenlabs', 'whisper-local']).default('off'),
  OPENAI_API_KEY: z.string().optional(),
  ELEVENLABS_API_KEY: z.string().optional(),
  WHISPER_URL: z.url().optional(),
});

export type Config = z.infer<typeof schema> & {
  /** True when OWNER_PASSPHRASE is set: the page, the API and the MCP endpoint require a login. */
  hosted: boolean;
};

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // Compose passes unset variables as empty strings: treat them as absent.
  const present = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v !== ''));
  const parsed = schema.safeParse(present);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid configuration:\n${problems}`);
  }
  const config: Config = { ...parsed.data, hosted: parsed.data.OWNER_PASSPHRASE !== undefined };
  config.FILES_MOUNT ??= config.FILES_ROOT;
  config.DOWNLOADS_MOUNT ??= config.DOWNLOADS_DIR;
  config.PUBLIC_URL = config.PUBLIC_URL.replace(/\/+$/, '');

  const publicUrl = new URL(config.PUBLIC_URL);
  if (!LOOPBACK.has(publicUrl.hostname)) {
    if (!config.hosted) {
      throw new Error(`PUBLIC_URL=${config.PUBLIC_URL} is not this computer: set OWNER_PASSPHRASE in .env so that only you can get in.`);
    }
    if (publicUrl.protocol !== 'https:') {
      throw new Error(`PUBLIC_URL=${config.PUBLIC_URL} must use https when the server is reachable from outside this computer.`);
    }
  }
  if (config.PUBLIC_HOST && config.PUBLIC_HOST.toLowerCase() !== publicUrl.hostname) {
    throw new Error(`PUBLIC_HOST=${config.PUBLIC_HOST} does not match PUBLIC_URL=${config.PUBLIC_URL}: they must name the same host.`);
  }
  if (!config.ALLOWED_HOSTS.includes(publicUrl.hostname)) config.ALLOWED_HOSTS.push(publicUrl.hostname);

  const needsKey = {
    openai: config.OPENAI_API_KEY,
    elevenlabs: config.ELEVENLABS_API_KEY,
    'whisper-local': config.WHISPER_URL,
    off: 'n/a',
  }[config.TRANSCRIPTION_PROVIDER];
  if (!needsKey) {
    throw new Error(`TRANSCRIPTION_PROVIDER=${config.TRANSCRIPTION_PROVIDER} needs its key or URL in .env`);
  }
  return config;
}
