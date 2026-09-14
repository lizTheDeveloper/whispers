import { expect } from 'vitest';
import type { WebSocket } from 'ws';
import { sendMsg, type MessageQueue } from './ws-helpers.js';

/**
 * Drives world setup to completion — the LLM stub returns done:true once the
 * host speaks. Different createGame() helpers across test files don't agree
 * on whether they've already drained the DM's opening greeting (done: false)
 * off the queue before calling this, so it retries until it sees the reply
 * that actually answers the dm-chat we just sent.
 *
 * The server broadcasts the resulting phase-change to everyone in the room,
 * including the host's own socket, and it arrives *before* the dm-chat-reply
 * (the broadcast is sent first in the handler). Draining it here too keeps
 * it from sitting unread in `q`'s buffer, where it would otherwise be handed
 * back — stale — to a later, unrelated `q.waitFor('phase-change')`/
 * `waitForAny([..., 'phase-change'])` call.
 *
 * Some callers (e.g. a rejoin right before this runs) leave an earlier,
 * unrelated phase-change sitting in the buffer too — a 'rejoin' reply always
 * sends one for whatever phase the campaign is *currently* in, which can
 * still be 'lobby'. So this drains phase-change messages the same way it
 * drains dm-chat-reply: until it sees the one that actually says
 * 'character-creation'.
 *
 * This was previously duplicated in test/onboarding-phases.test.ts and
 * test/session-persistence.test.ts, and the two copies had already diverged
 * — the session-persistence copy lacked the phase-change drain, which is a
 * silent-vacuous-test risk if a later test in that file ever adds its own
 * phase-change wait. One implementation, shared.
 */
export async function finishWorldSetup(ws: WebSocket, q: MessageQueue): Promise<void> {
  sendMsg(ws, { type: 'dm-chat', text: 'A haunted lighthouse, spooky but hopeful.' });

  let reply: any;
  let attempts = 0;
  do {
    reply = await q.waitFor('dm-chat-reply', 15_000);
    attempts++;
  } while (!reply.done && attempts < 5);
  expect(reply.done).toBe(true);

  let phase: any;
  attempts = 0;
  do {
    phase = await q.waitFor('phase-change', 15_000);
    attempts++;
  } while (phase.phase !== 'character-creation' && attempts < 5);
  expect(phase.phase).toBe('character-creation');
}
