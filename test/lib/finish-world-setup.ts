import { expect } from 'vitest';
import type { WebSocket } from 'ws';
import { sendMsg, type MessageQueue } from './ws-helpers.js';
import type { TableRole } from '../../src/shared/types.js';

/**
 * Drives world setup all the way to an open table.
 *
 * Accepting a drafted world seed is what opens the table now, not the model
 * saying "done" in dm-chat — dm-chat only drafts a seed once the conversation
 * has enough (influences, a premise, dmInstructions). So this sends a single
 * dm-chat, waits for the drafted seed, claims the DM chair (accepting a seed
 * requires a table role), then accepts that seed and waits for the resulting
 * phase-change.
 *
 * Different createGame() helpers across test files don't agree on whether
 * they've already drained the DM's opening greeting (done: false) off the
 * queue before calling this, so the dm-chat-reply wait below tolerates an
 * extra one still sitting in the buffer by draining until it sees a reply
 * that isn't the greeting — done: true, per the LLM stub, once the host has
 * spoken at all.
 *
 * The server broadcasts the resulting phase-change to everyone in the room,
 * including the host's own socket. Some callers (e.g. a rejoin right before
 * this runs) leave an earlier, unrelated phase-change sitting in the buffer
 * too — a 'rejoin' reply always sends one for whatever phase the campaign is
 * *currently* in, which can still be 'lobby'. So this drains phase-change
 * messages the same way it drains dm-chat-reply: until it sees the one that
 * actually says 'character-creation'.
 *
 * This was previously duplicated in test/onboarding-phases.test.ts and
 * test/session-persistence.test.ts, and the two copies had already diverged
 * — the session-persistence copy lacked the phase-change drain, which is a
 * silent-vacuous-test risk if a later test in that file ever adds its own
 * phase-change wait. One implementation, shared.
 *
 * `role` defaults to 'dm' so every existing caller is unchanged; pass
 * 'player' to drive setup all the way to an open table with the host seated
 * as a player instead (no human approver for characters on that path).
 */
export async function finishWorldSetup(ws: WebSocket, q: MessageQueue, role: TableRole = 'dm'): Promise<void> {
  sendMsg(ws, { type: 'dm-chat', text: 'A haunted lighthouse, spooky but hopeful.' });

  let reply: any;
  let attempts = 0;
  do {
    reply = await q.waitFor('dm-chat-reply', 15_000);
    attempts++;
  } while (!reply.done && attempts < 5);
  expect(reply.done).toBe(true);

  const draft = await q.waitFor('world-seed-draft', 20_000) as any;
  expect(draft.accepted).toBe(false);

  sendMsg(ws, { type: 'choose-table-role', role } as any);
  await q.waitFor('room-joined', 10_000);

  sendMsg(ws, { type: 'accept-world-seed', seed: draft.seed } as any);

  let phase: any;
  let phaseAttempts = 0;
  do {
    phase = await q.waitFor('phase-change', 15_000);
    phaseAttempts++;
  } while (phase.phase !== 'character-creation' && phaseAttempts < 5);
  expect(phase.phase).toBe('character-creation');
}
