import { randomBytes, scrypt, scryptSync, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { HttpError } from './subtitles.js';

const derive = promisify(scrypt);
export function validatePassword(password) {
  if (typeof password !== 'string' || password.length < 12 || password.length > 1024) throw new HttpError(400, 'Use a password containing between 12 and 1024 characters.');
}

export class Authentication {
  constructor(library, envPassword = '') {
    this.library = library;
    this.sessions = new Map();
    this.attempts = new Map();
    this.activeChecks = 0;
    this.environmentCredential = '';
    if (envPassword) {
      validatePassword(envPassword);
      const salt = randomBytes(16).toString('hex');
      this.environmentCredential = `${salt}:${scryptSync(envPassword, salt, 64).toString('hex')}`;
    }
  }
  credential() { return this.environmentCredential || this.library.getSetting('adminCredential'); }
  ready() { return !!this.credential(); }
  authenticated(req) {
    const token = req.headers.cookie?.match(/(?:^|;\s*)cs_session=([a-f0-9]{64})(?:;|$)/)?.[1];
    return !!token && (this.sessions.get(token) ?? 0) > Date.now();
  }
  async setup(password) {
    if (this.ready()) throw new HttpError(409, 'The administrator password is already configured.');
    validatePassword(password);
    const salt = randomBytes(16).toString('hex');
    const hash = await derive(password, salt, 64);
    // Recheck after asynchronous hashing so two requests cannot replace the owner.
    if (this.ready()) throw new HttpError(409, 'The administrator password is already configured.');
    this.library.setSetting('adminCredential', `${salt}:${hash.toString('hex')}`);
  }
  async login(password, bucket) {
    if (!this.ready()) throw new HttpError(409, 'Create the administrator password on the server first.');
    if (typeof password !== 'string' || password.length > 1024) throw new HttpError(400, 'Enter your password.');
    for (const [key, value] of this.attempts) if (Date.now() > value.until) this.attempts.delete(key);
    const attempt = this.attempts.get(bucket) ?? { count: 0, until: Date.now() + 15 * 60 * 1000 };
    if (attempt.count >= 10 || this.activeChecks >= 4) throw new HttpError(429, 'Too many attempts. Try again later.');
    attempt.count++;
    this.attempts.set(bucket, attempt);
    this.activeChecks++;
    try {
      const [salt, expected] = this.credential().split(':');
      const actual = await derive(password, salt, 64);
      const expectedBuffer = Buffer.from(expected, 'hex');
      if (expectedBuffer.length !== actual.length || !timingSafeEqual(expectedBuffer, actual)) throw new HttpError(401, 'Incorrect password.');
      this.attempts.delete(bucket);
      return this.newSession();
    } finally { this.activeChecks--; }
  }
  newSession() {
    for (const [key, expiry] of this.sessions) if (expiry <= Date.now()) this.sessions.delete(key);
    const token = randomBytes(32).toString('hex');
    this.sessions.set(token, Date.now() + 12 * 60 * 60 * 1000);
    return token;
  }
  logout(req) { this.sessions.delete(req.headers.cookie?.match(/cs_session=([a-f0-9]{64})/)?.[1]); }
}
