import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const DAILY_LIMIT = 10;
export const RESULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export class BridgeError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function shanghaiDay(value) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(value));
}

// This database contains public registration metadata and structured results.
// Image bytes, notes, project lists, OAuth credentials and pairing tokens never
// enter this API. Request tombstones remain after their result expires so an
// uncertain request cannot silently become a second billable request.
export class BridgeStore {
  constructor({ stateDir, now = () => Date.now() }) {
    if (!stateDir || !path.isAbsolute(stateDir)) throw new Error('An absolute bridge state directory is required');
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    this.now = now;
    this.filename = path.join(stateDir, 'bridge.sqlite');
    this.db = new DatabaseSync(this.filename);
    try { fs.chmodSync(this.filename, 0o600); } catch { /* Windows applies directory ACLs. */ }
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 3000;
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS recognitions (
        scope TEXT NOT NULL,
        request_id TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        account_key TEXT NOT NULL,
        model TEXT NOT NULL,
        image_sha256 TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('pending', 'success', 'failed')),
        charged INTEGER NOT NULL CHECK (charged IN (0, 1)),
        day TEXT NOT NULL,
        created_at TEXT NOT NULL,
        finished_at TEXT,
        result_json TEXT,
        error_code TEXT,
        PRIMARY KEY (scope, request_id)
      );
      CREATE INDEX IF NOT EXISTS recognitions_cache ON recognitions(scope, account_key, fingerprint, state, finished_at);
      CREATE INDEX IF NOT EXISTS recognitions_day ON recognitions(day, charged);
    `);
    this.db.prepare('INSERT OR IGNORE INTO metadata(key, value) VALUES (?, ?)').run('host_id', `urn:uuid:${randomUUID()}`);
    this.hostId = this.db.prepare('SELECT value FROM metadata WHERE key = ?').get('host_id').value;
    this.expireResults();
  }

  instant() { return new Date(this.now()).toISOString(); }

  get registration() {
    const row = this.db.prepare('SELECT value FROM metadata WHERE key = ?').get('registration');
    return row ? JSON.parse(row.value) : undefined;
  }

  saveRegistration(registration) {
    const keys = ['host_id', 'client_id', 'subject'];
    if (!registration || typeof registration !== 'object' || Array.isArray(registration)
      || Object.keys(registration).some(key => !keys.includes(key))
      || registration.host_id !== this.hostId
      || typeof registration.client_id !== 'string' || !/^[A-Za-z0-9_-]{3,200}$/.test(registration.client_id) || registration.client_id === 'dynamic_agent_client'
      || typeof registration.subject !== 'string' || registration.subject.length > 512) {
      throw new BridgeError(400, 'REGISTRATION_METADATA', 'Only public host, issued client and subject metadata may be saved');
    }
    const safe = { host_id: this.hostId, client_id: registration.client_id, subject: registration.subject };
    this.db.prepare('INSERT INTO metadata(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run('registration', JSON.stringify(safe));
  }

  expireResults() {
    const cutoff = new Date(new Date(this.now()).getTime() - RESULT_RETENTION_MS).toISOString();
    this.db.prepare("UPDATE recognitions SET result_json = NULL WHERE state = 'success' AND finished_at <= ? AND result_json IS NOT NULL").run(cutoff);
  }

  quota() {
    const day = shanghaiDay(this.now());
    const used = this.db.prepare('SELECT COALESCE(SUM(charged), 0) AS n FROM recognitions WHERE day = ?').get(day).n;
    return { day, used, max: DAILY_LIMIT };
  }

  reserve(input, { allowNew = true } = {}) {
    const { scope, requestId, fingerprint, accountKey, model, imageSha256 } = input;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.expireResults();
      const existing = this.db.prepare('SELECT * FROM recognitions WHERE scope = ? AND request_id = ?').get(scope, requestId);
      if (existing) {
        if (existing.fingerprint !== fingerprint || existing.account_key !== accountKey) {
          throw new BridgeError(409, 'REQUEST_CONFLICT', 'This request ID already belongs to different image, fields, account or model; explicitly start a new recognition');
        }
        if (existing.state === 'pending') throw new BridgeError(409, 'REQUEST_PENDING', 'This request may already have reached Codex; it will not be submitted again');
        if (existing.state === 'failed') throw new BridgeError(409, 'REQUEST_FAILED', 'This request already failed or timed out; it will not be submitted again');
        if (!existing.result_json) throw new BridgeError(410, 'RESULT_EXPIRED', 'The seven-day result expired; explicitly start a new recognition if needed');
        this.db.exec('COMMIT');
        return { cached: true, result: JSON.parse(existing.result_json) };
      }
      const cached = this.db.prepare("SELECT result_json, finished_at FROM recognitions WHERE scope = ? AND account_key = ? AND fingerprint = ? AND state = 'success' AND result_json IS NOT NULL ORDER BY finished_at DESC LIMIT 1")
        .get(scope, accountKey, fingerprint);
      const timestamp = this.instant();
      if (cached) {
        this.db.prepare(`INSERT INTO recognitions
          (scope, request_id, fingerprint, account_key, model, image_sha256, state, charged, day, created_at, finished_at, result_json)
          VALUES (?, ?, ?, ?, ?, ?, 'success', 0, ?, ?, ?, ?)`)
          .run(scope, requestId, fingerprint, accountKey, model, imageSha256, shanghaiDay(timestamp), timestamp, cached.finished_at, cached.result_json);
        this.db.exec('COMMIT');
        return { cached: true, result: JSON.parse(cached.result_json) };
      }
      if (!allowNew) throw new BridgeError(409, 'BRIDGE_BUSY', 'Another recognition is in progress; this request was not submitted');
      if (this.quota().used >= DAILY_LIMIT) throw new BridgeError(429, 'DAILY_LIMIT', 'The local bridge has reached its ten requests for today in Shanghai time');
      this.db.prepare(`INSERT INTO recognitions
        (scope, request_id, fingerprint, account_key, model, image_sha256, state, charged, day, created_at)
        VALUES (?, ?, ?, ?, ?, ?, 'pending', 1, ?, ?)`)
        .run(scope, requestId, fingerprint, accountKey, model, imageSha256, shanghaiDay(timestamp), timestamp);
      this.db.exec('COMMIT');
      return { cached: false };
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* Transaction may already have committed. */ }
      throw error;
    }
  }

  succeed(scope, requestId, result) {
    const json = JSON.stringify(result);
    if (typeof json !== 'string' || Buffer.byteLength(json) > 100_000) {
      throw new BridgeError(502, 'INVALID_RECOGNITION', 'The structured recognition result is invalid or too large');
    }
    const changed = this.db.prepare("UPDATE recognitions SET state = 'success', finished_at = ?, result_json = ?, error_code = NULL WHERE scope = ? AND request_id = ? AND state = 'pending'")
      .run(this.instant(), json, scope, requestId);
    if (changed.changes !== 1) throw new BridgeError(409, 'REQUEST_STATE', 'The recognition is no longer pending');
  }

  fail(scope, requestId, code) {
    const safeCode = typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(code) ? code : 'RECOGNITION_FAILED';
    this.db.prepare("UPDATE recognitions SET state = 'failed', finished_at = ?, result_json = NULL, error_code = ? WHERE scope = ? AND request_id = ? AND state = 'pending'")
      .run(this.instant(), safeCode, scope, requestId);
  }

  close() { this.db.close(); }
}
