import type { ClientMessage, ServerMessage } from '../shared/protocol.js';

type MessageHandler = (msg: ServerMessage) => void;

export class WsClient {
  private ws: WebSocket | null = null;
  private handlers = new Map<string, Set<MessageHandler>>();
  private globalHandlers = new Set<MessageHandler>();

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      this.ws = new WebSocket(`${proto}//${location.host}/ws`);
      this.ws.onopen = () => resolve();
      this.ws.onerror = () => reject(new Error('WebSocket connection failed'));
      this.ws.onmessage = (evt) => {
        const msg: ServerMessage = JSON.parse(evt.data as string);
        this.handlers.get(msg.type)?.forEach(h => h(msg));
        this.globalHandlers.forEach(h => h(msg));
      };
      this.ws.onclose = () => { this.ws = null; };
    });
  }

  send(msg: ClientMessage): void {
    this.ws?.send(JSON.stringify(msg));
  }

  on(type: string, handler: MessageHandler): void {
    if (!this.handlers.has(type)) this.handlers.set(type, new Set());
    this.handlers.get(type)!.add(handler);
  }

  onAny(handler: MessageHandler): void {
    this.globalHandlers.add(handler);
  }

  off(type: string, handler: MessageHandler): void {
    this.handlers.get(type)?.delete(handler);
  }
}
