// Web cabinets: every response may be framed by campus (and Whispers
// itself), and by nobody else.
import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { cabinetFraming, withFrameAncestors, FRAME_ANCESTORS } from '../src/server/framing.js';

let server: Server | null = null;
afterEach(async () => { if (server) await new Promise<void>(r => server!.close(() => r())); server = null; });

async function serve(app: express.Express): Promise<string> {
  server = await new Promise<Server>(r => { const s = app.listen(0, () => r(s)); });
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

describe('withFrameAncestors', () => {
  it('is the bare directive with no CSP', () => {
    expect(FRAME_ANCESTORS).toBe("frame-ancestors 'self' https://campus.themultiverse.school");
    expect(withFrameAncestors('')).toBe(FRAME_ANCESTORS);
  });
  it('appends to an existing CSP', () => {
    expect(withFrameAncestors("default-src 'self'")).toBe(`default-src 'self'; ${FRAME_ANCESTORS}`);
  });
  it('replaces an existing frame-ancestors, never duplicating it', () => {
    expect(withFrameAncestors("default-src 'self'; frame-ancestors 'none'; img-src *")).toBe(`default-src 'self'; img-src *; ${FRAME_ANCESTORS}`);
    expect(withFrameAncestors("FRAME-ANCESTORS https://evil.example")).toBe(FRAME_ANCESTORS);
  });
});

describe('cabinetFraming middleware', () => {
  it('sets the CSP on every response, including 404s', async () => {
    const app = express();
    app.use(cabinetFraming);
    app.get('/ok', (_q, r) => { r.send('ok'); });
    const base = await serve(app);
    const ok = await fetch(`${base}/ok`);
    expect(ok.headers.get('content-security-policy')).toBe(FRAME_ANCESTORS);
    expect(ok.headers.get('x-frame-options')).toBeNull();
    // Express's own 404 sets "default-src 'none'": ours is appended to it, once.
    const missing = await fetch(`${base}/missing`);
    expect(missing.status).toBe(404);
    expect(missing.headers.get('content-security-policy')).toBe(`default-src 'none'; ${FRAME_ANCESTORS}`);
    expect(missing.headers.get('x-frame-options')).toBeNull();
  });

  it('merges a CSP a later handler sets, and drops X-Frame-Options', async () => {
    const app = express();
    app.use(cabinetFraming);
    app.get('/strict', (_q, r) => {
      r.setHeader('X-Frame-Options', 'DENY');
      r.setHeader('Content-Security-Policy', "default-src 'self'; frame-ancestors 'none'");
      r.send('x');
    });
    app.get('/set', (_q, r) => { r.set({ 'x-frame-options': 'SAMEORIGIN' }); r.send('y'); });
    const base = await serve(app);
    const res = await fetch(`${base}/strict`);
    expect(res.headers.get('content-security-policy')).toBe(`default-src 'self'; ${FRAME_ANCESTORS}`);
    expect(res.headers.get('x-frame-options')).toBeNull();
    const res2 = await fetch(`${base}/set`);
    expect(res2.headers.get('x-frame-options')).toBeNull();
  });
});
