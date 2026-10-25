import { BlockList, isIP } from 'node:net';

/**
 * The client's IP, derived from trusted proxies only.
 *
 * A client can send any X-Forwarded-For it likes, so the header is read only
 * when the socket peer is itself a trusted proxy, and then from the right:
 * each hop a trusted proxy appended is skipped, and the first address that is
 * not a trusted proxy is the client. Anything to the left of it was written
 * by the client and is ignored. A peer that is not a trusted proxy is the
 * client, whatever the header says.
 *
 * Trusted proxies: TRUSTED_PROXIES (comma-separated IPs or CIDRs). The
 * default is loopback only (local dev behind Vite's proxy). In production it
 * is exactly Traefik's fixed address on the llm-relay network
 * (docker-compose.prod.yml) — never a shared bridge, where any container
 * could forge a client IP. Traefik (no forwardedHeaders.trustedIPs) drops any
 * X-Forwarded-For the client sent and writes its own.
 */
const DEFAULT_TRUSTED = ['127.0.0.0/8', '::1/128'];

export function normalizeIp(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let ip = raw.trim();
  // "[2001:db8::1]:443" and "203.0.113.5:1234" (some proxies keep the port)
  const bracket = /^\[([^\]]+)\](?::\d+)?$/.exec(ip);
  if (bracket) ip = bracket[1]!;
  else if (/^\d{1,3}(?:\.\d{1,3}){3}:\d+$/.test(ip)) ip = ip.replace(/:\d+$/, '');
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (mapped) ip = mapped[1]!;
  return isIP(ip) ? ip : null;
}

export function buildTrustedList(spec: string | undefined = process.env.TRUSTED_PROXIES): BlockList {
  const list = new BlockList();
  const entries = (spec && spec.trim() ? spec.split(',') : DEFAULT_TRUSTED).map(s => s.trim()).filter(Boolean);
  for (const entry of entries) {
    const [addr, bits] = entry.split('/');
    const ip = normalizeIp(addr);
    if (!ip) continue;
    const family = isIP(ip) === 6 ? 'ipv6' : 'ipv4';
    if (bits !== undefined) list.addSubnet(ip, Number(bits), family);
    else list.addAddress(ip, family);
  }
  return list;
}

let cached: { spec: string | undefined; list: BlockList } | null = null;
function trustedList(): BlockList {
  const spec = process.env.TRUSTED_PROXIES;
  if (!cached || cached.spec !== spec) cached = { spec, list: buildTrustedList(spec) };
  return cached.list;
}

export function isTrustedProxy(ip: string, list: BlockList = trustedList()): boolean {
  return list.check(ip, isIP(ip) === 6 ? 'ipv6' : 'ipv4');
}

/**
 * `peer`: the socket's remote address. `forwardedFor`: the X-Forwarded-For
 * header(s) as received. Null only when the peer address is unreadable.
 */
export function clientIp(peer: string | null | undefined, forwardedFor: string | string[] | null | undefined, list: BlockList = trustedList()): string | null {
  const direct = normalizeIp(peer);
  if (!direct) return null;
  if (!isTrustedProxy(direct, list)) return direct;
  const header = Array.isArray(forwardedFor) ? forwardedFor.join(',') : forwardedFor ?? '';
  const hops = header.split(',').map(h => h.trim()).filter(Boolean);
  let client = direct;
  for (let i = hops.length - 1; i >= 0; i--) {
    const hop = normalizeIp(hops[i]);
    if (!hop) break; // garbage: stop at the last address we could trust
    client = hop;
    if (!isTrustedProxy(hop, list)) break;
  }
  return client;
}

/** The client IP of an incoming HTTP request (Express or a raw upgrade request). */
export function requestClientIp(req: { socket?: { remoteAddress?: string | undefined } | null; headers: Record<string, string | string[] | undefined> }): string | null {
  return clientIp(req.socket?.remoteAddress ?? null, req.headers['x-forwarded-for'] ?? null);
}
