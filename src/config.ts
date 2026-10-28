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
  ALLOWED_HOSTS: z
    .string()
    .default('127.0.0.1,localhost,wuzapi-mcp')
    .transform((s) => s.split(',').map((h) => h.trim()).filter(Boolean)),
  // The address you open in the browser and give to Claude Code.
  PUBLIC_URL: z.url().default('http://127.0.0.1:8091'),
  DATA_DIR: z.string().default('/data'),
  // Files Claude may send must live under this folder (mounted read-only, same path as on the host).
  FILES_ROOT: z.string().optional(),
  // Where downloaded media is written (mounted from the host, same path), so the paths Claude gets back work there.
  DOWNLOADS_DIR: z.string().optional(),
  TRANSCRIPTION_PROVIDER: z.enum(['off', 'openai', 'elevenlabs', 'whisper-local']).default('off'),
  OPENAI_API_KEY: z.string().optional(),
  ELEVENLABS_API_KEY: z.string().optional(),
  WHISPER_URL: z.url().optional(),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // Compose passes unset variables as empty strings: treat them as absent.
  const present = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v !== ''));
  const parsed = schema.safeParse(present);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid configuration:\n${problems}`);
  }
  const config = parsed.data;
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
