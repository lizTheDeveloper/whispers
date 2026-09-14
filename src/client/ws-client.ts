import type { ClientMessage, ServerMessage } from '../shared/protocol.js';

type MessageHandler = (msg: ServerMessage) => void;
type StatusHandler = (connected: boolean) => void;

export class WsClient {
  private ws: WebSocket | null = null;
  private handlers = new Map<string, Set<MessageHandler>>();
  private globalHandlers = new Set<MessageHandler>();
  private statusHandlers = new Set<StatusHandler>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = 1000;
  private maxReconnectDelay = 10000;
  private intentionallyClosed = false;
  private rejoinInfo: { joinCode: string; sessionToken: string } | null = null;

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /** Remember who we are so an auto-reconnect lands back in the same seat. */
  setSession(joinCode: string, sessionToken: string): void {
    this.rejoinInfo = { joinCode, sessionToken };
  }

  connect(): Promise<void> {
    this.intentionallyClosed = false;
    return new Promise((resolve, reject) => {
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const base = location.pathname.replace(/\/+$/, '');
      this.ws = new WebSocket(`${proto}//${location.host}${base}/ws`);
      this.ws.onopen = () => {
        this.reconnectDelay = 1000;
        this.notifyStatus(true);
        if (this.rejoinInfo) {
          this.send({ type: 'rejoin', joinCode: this.rejoinInfo.joinCode, sessionToken: this.rejoinInfo.sessionToken });
        }
        resolve();
      };
      this.ws.onerror = () => reject(new Error('WebSocket connection failed'));
      this.ws.onmessage = (evt) => {
        const msg: ServerMessage = JSON.parse(evt.data as string);
        // A throwing handler must not starve the handlers registered after
        // it — Set.forEach propagates exceptions and aborts iteration.
        this.handlers.get(msg.type)?.forEach(h => {
          try { h(msg); } catch (e) { console.error('[ws] handler failed for', msg.type, e); }
        });
        this.globalHandlers.forEach(h => {
          try { h(msg); } catch (e) { console.error('[ws] handler failed for', msg.type, e); }
        });
      };
      this.ws.onclose = () => {
        this.ws = null;
        this.notifyStatus(false);
        if (!this.intentionallyClosed) this.scheduleReconnect();
      };
    });
  }

  send(msg: ClientMessage): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.warn('[ws] send() called while disconnected, message dropped:', msg.type);
      return;
    }
    this.ws.send(JSON.stringify(msg));
  }

  on(type: string, handler: MessageHandler): void {
    if (!this.handlers.has(type)) this.handlers.set(type, new Set());
    this.handlers.get(type)!.add(handler);
  }

  onAny(handler: MessageHandler): void {
    this.globalHandlers.add(handler);
  }

  onStatus(handler: StatusHandler): void {
    this.statusHandlers.add(handler);
  }

  off(type: string, handler: MessageHandler): void {
    this.handlers.get(type)?.delete(handler);
  }

  close(): void {
    this.intentionallyClosed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
  }

  private notifyStatus(connected: boolean): void {
    this.statusHandlers.forEach(h => {
      try { h(connected); } catch (e) { console.error('[ws] status handler failed', e); }
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    console.log(`[ws] reconnecting in ${this.reconnectDelay}ms...`);
    this.reconnectTimer = setTimeout(() => {
      this.connect().catch(() => {
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
      });
    }, this.reconnectDelay);
  }
}
