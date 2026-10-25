import type { Request, Response, NextFunction } from 'express';

/**
 * Web cabinets: campus.themultiverse.school plays Whispers in an iframe, so
 * every response may be framed by Whispers itself and by campus — nobody
 * else. Mounted first, so it covers the API, static assets and 404s alike.
 */
export const FRAME_ANCESTORS = "frame-ancestors 'self' https://campus.themultiverse.school";

/** `csp` with any frame-ancestors directive replaced by ours (appended once). */
export function withFrameAncestors(csp: string): string {
  const kept = csp.split(';').map(d => d.trim()).filter(d => d && !/^frame-ancestors(\s|$)/i.test(d));
  return [...kept, FRAME_ANCESTORS].join('; ');
}

export function cabinetFraming(_req: Request, res: Response, next: NextFunction): void {
  const setHeader = res.setHeader.bind(res);
  // A later handler setting its own CSP gets ours merged in; X-Frame-Options
  // would forbid the cabinet outright, so it is never sent.
  res.setHeader = ((name: string, value: number | string | readonly string[]) => {
    const lower = name.toLowerCase();
    if (lower === 'x-frame-options') return res;
    if (lower === 'content-security-policy') {
      return setHeader(name, withFrameAncestors(Array.isArray(value) ? value.join('; ') : String(value)));
    }
    return setHeader(name, value);
  }) as typeof res.setHeader;
  setHeader('Content-Security-Policy', FRAME_ANCESTORS);
  next();
}
