import { timingSafeEqual } from 'node:crypto';
import type { Request, RequestHandler, Response } from 'express';
import type { Config } from '../../config.ts';
import { FailureLimiter } from './ratelimit.ts';
import { newSecret, type AuthStore } from './store.ts';

/**
 * The owner's browser session: a cookie set after the passphrase was typed, good for 30 days.
 * It opens the status page and the API, and lets an assistant's authorization through with one
 * click instead of the passphrase again.
 */

export const COOKIE = 'wuzapi_owner';
const SESSION_DAYS = 30;
/** Five wrong passphrases from one address, then a quarter of an hour of 429s. */
const LOGIN_LIMIT = new FailureLimiter(5, 15 * 60 * 1000);

export const parseCookies = (req: Request): Record<string, string> =>
  Object.fromEntries(
    (req.headers.cookie ?? '')
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const eq = part.indexOf('=');
        return eq === -1 ? [part, ''] : [part.slice(0, eq), decodeURIComponent(part.slice(eq + 1))];
      }),
  );

export class Owner {
  private readonly config: Config;
  private readonly store: AuthStore;

  constructor(config: Config, store: AuthStore) {
    this.config = config;
    this.store = store;
  }

  private get secure(): boolean {
    return this.config.PUBLIC_URL.startsWith('https:');
  }

  /** Constant-time comparison; a wrong length still costs the same. */
  passphraseMatches(given: string | undefined): boolean {
    const expected = Buffer.from(this.config.OWNER_PASSPHRASE ?? '');
    const actual = Buffer.from(typeof given === 'string' ? given : '');
    if (expected.length === 0) return false;
    const padded = Buffer.alloc(expected.length);
    actual.copy(padded, 0, 0, Math.min(actual.length, expected.length));
    return timingSafeEqual(expected, padded) && actual.length === expected.length;
  }

  /** The address attempts are counted by; behind Caddy `trust proxy` makes it the real client. */
  private key(req: Request): string {
    return req.ip ?? 'unknown';
  }

  blocked(req: Request): boolean {
    return LOGIN_LIMIT.blocked(this.key(req));
  }

  /** Checks a typed passphrase, counting failures per address. */
  attempt(req: Request, passphrase: string | undefined): 'ok' | 'wrong' | 'blocked' {
    if (this.blocked(req)) return 'blocked';
    if (this.passphraseMatches(passphrase)) {
      LOGIN_LIMIT.clear(this.key(req));
      return 'ok';
    }
    LOGIN_LIMIT.fail(this.key(req));
    return 'wrong';
  }

  isSignedIn(req: Request): boolean {
    const id = parseCookies(req)[COOKIE];
    return !!id && this.store.hasSession(id);
  }

  signIn(res: Response): void {
    const id = newSecret();
    const expires = Math.floor(Date.now() / 1000) + SESSION_DAYS * 86400;
    this.store.saveSession(id, expires);
    res.cookie(COOKIE, id, { httpOnly: true, secure: this.secure, sameSite: 'lax', path: '/', maxAge: SESSION_DAYS * 86400 * 1000 });
  }

  signOut(req: Request, res: Response): void {
    const id = parseCookies(req)[COOKIE];
    if (id) this.store.deleteSession(id);
    res.clearCookie(COOKIE, { path: '/' });
  }

  /**
   * Refuses a request whose Origin is another site. Browsers send Origin on every POST; a request
   * with none (curl, the assistant) is not a cross-site form and passes.
   */
  sameOrigin(req: Request): boolean {
    const origin = req.headers.origin;
    if (!origin) return true;
    try {
      return new URL(origin).origin === new URL(this.config.PUBLIC_URL).origin;
    } catch {
      return false;
    }
  }

  /** For the JSON API: 401 when the cookie is missing or dead. */
  requireSignedIn(): RequestHandler {
    return (req, res, next) => {
      if (!this.isSignedIn(req)) {
        res.status(401).json({ error: 'sign in first' });
        return;
      }
      next();
    };
  }
}
