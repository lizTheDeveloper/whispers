import { createServer } from 'node:net';
import { WebSocket } from 'ws';
import type { ClientMessage, ServerMessage } from '../../src/shared/protocol.js';

export function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

export function connectWs(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}/ws`);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
    setTimeout(() => reject(new Error('WS connect timeout')), 10_000);
  });
}

export function sendMsg(ws: WebSocket, msg: ClientMessage): void {
  ws.send(JSON.stringify(msg));
}

export class MessageQueue {
  private buffer: ServerMessage[] = [];
  private waiters: Array<{
    types: string[];
    resolve: (msg: ServerMessage) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];

  constructor(private ws: WebSocket) {
    ws.on('message', (data: Buffer) => {
      const msg: ServerMessage = JSON.parse(data.toString());
      const waiterIdx = this.waiters.findIndex(w => w.types.includes(msg.type));
      if (waiterIdx >= 0) {
        const waiter = this.waiters.splice(waiterIdx, 1)[0]!;
        clearTimeout(waiter.timer);
        waiter.resolve(msg);
      } else {
        this.buffer.push(msg);
      }
    });
  }

  waitFor(type: string, timeoutMs = 90_000): Promise<ServerMessage> {
    return this.waitForAny([type], timeoutMs);
  }

  waitForAny(types: string[], timeoutMs = 90_000): Promise<ServerMessage> {
    const idx = this.buffer.findIndex(m => types.includes(m.type));
    if (idx >= 0) {
      return Promise.resolve(this.buffer.splice(idx, 1)[0]!);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const wi = this.waiters.findIndex(w => w.resolve === resolve);
        if (wi >= 0) this.waiters.splice(wi, 1);
        reject(new Error(`Timeout waiting for ${types.length === 1 ? types[0] : `any of [${types.join(',')}]`} after ${timeoutMs}ms`));
      }, timeoutMs);
      this.waiters.push({ types, resolve, reject, timer });
    });
  }

  clear(): void {
    this.buffer.length = 0;
    for (const w of this.waiters) clearTimeout(w.timer);
    this.waiters.length = 0;
  }
}
