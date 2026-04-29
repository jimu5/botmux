import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  verifyHmac, generateToken, parseCookie,
} from '../src/dashboard/auth.js';

const SECRET = 'a'.repeat(43); // base64url 32 bytes

function sign(ts: string, nonce: string): string {
  return createHmac('sha256', SECRET).update(`${ts}:${nonce}`).digest('base64url');
}

describe('verifyHmac', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date(0)); });
  afterEach(() => { vi.useRealTimers(); });

  it('accepts valid signature', () => {
    const ts = '0', nonce = 'n1';
    const r = verifyHmac(SECRET, { ts, nonce, sig: sign(ts, nonce) }, '127.0.0.1');
    expect(r.ok).toBe(true);
  });

  it('rejects wrong secret', () => {
    const ts = '0', nonce = 'n2';
    const r = verifyHmac(SECRET, { ts, nonce, sig: sign(ts, nonce).replace(/^./, 'X') }, '127.0.0.1');
    expect(r.ok).toBe(false);
  });

  it('rejects expired ts (>30s)', () => {
    vi.setSystemTime(new Date(60_000));
    const ts = '0', nonce = 'n3';
    const r = verifyHmac(SECRET, { ts, nonce, sig: sign(ts, nonce) }, '127.0.0.1');
    expect(r.ok).toBe(false);
  });

  it('rejects non-loopback IP', () => {
    const ts = '0', nonce = 'n4';
    const r = verifyHmac(SECRET, { ts, nonce, sig: sign(ts, nonce) }, '192.168.1.5');
    expect(r.ok).toBe(false);
  });

  it('rejects replayed nonce within window', () => {
    const ts = '0', nonce = 'n5';
    const a = verifyHmac(SECRET, { ts, nonce, sig: sign(ts, nonce) }, '127.0.0.1');
    expect(a.ok).toBe(true);
    const b = verifyHmac(SECRET, { ts, nonce, sig: sign(ts, nonce) }, '127.0.0.1');
    expect(b.ok).toBe(false);
  });
});

describe('generateToken', () => {
  it('returns 43-char base64url (32 bytes)', () => {
    const t = generateToken();
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});

describe('parseCookie', () => {
  it('extracts botmux_dashboard_token value', () => {
    const v = parseCookie('foo=bar; botmux_dashboard_token=tk_abc; x=1');
    expect(v).toBe('tk_abc');
  });
  it('returns undefined when absent', () => {
    expect(parseCookie('foo=bar')).toBeUndefined();
  });
});
