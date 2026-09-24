// Round 17 (live 5YHBZS): the drafted world could not be accepted.
//  - Accept failed twice with "NPC disposition must be at most 256
//    characters." Mistress Prune's disposition was ~330 characters, then 277
//    on a redraft — text the server itself had drafted.
//  - The host asked in the chat to shorten it. The DM said "Please try
//    accepting the world again", but nothing had changed: a chat message
//    never redrafts an existing world.
// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { WebSocket } from 'ws';
import { connectWs, sendMsg, MessageQueue } from './lib/ws-helpers.js';
import { startHarness, LLM_STUB_REPLIES, type Harness } from './lib/server-harness.js';
import { finishWorldSetup } from './lib/finish-world-setup.js';
import {
  FIELD_LIMITS, clampText, clampWorldSeed, validateWorldSeedShape, acceptableSeed, seedLimitsForPrompt,
} from '../src/server/field-limits.js';
import { asksForWorldEdit, claimsWorldEdit, withoutFalseEditClaim } from '../src/server/world-seed.js';

const LONG = LLM_STUB_REPLIES.longWorldSeed;

describe('clampText: at a sentence, else a word, never over the limit', () => {
  it('keeps text within the limit as it is', () => {
    expect(clampText('Wary but kind.', 256)).toBe('Wary but kind.');
  });
  it('cuts at the last sentence that fits', () => {
    const out = clampText(LONG.npcs[0]!.disposition!, 256);
    expect(out.length).toBeLessThanOrEqual(256);
    expect(out).toMatch(/[.!?]$/);
    expect(LONG.npcs[0]!.disposition!.startsWith(out)).toBe(true);
  });
  it('cuts at a word when no sentence ends in reach, with an ellipsis', () => {
    const text = 'a '.repeat(10) + 'verylongword '.repeat(40);
    const out = clampText(text, 100);
    expect(out.length).toBeLessThanOrEqual(100);
    expect(out.endsWith('…')).toBe(true);
    expect(out).not.toMatch(/verylongwor…$/);
  });
  it('a name is cut at a word, with no ellipsis', () => {
    const out = clampText('Mistress '.repeat(40).trim(), 256, { name: true });
    expect(out.length).toBeLessThanOrEqual(256);
    expect(out.endsWith('Mistress')).toBe(true);
  });
});

describe('clampWorldSeed: every validated field fits', () => {
  it('the live over-long seed passes validation once clamped, and short fields are untouched', () => {
    expect(validateWorldSeedShape(LONG)).toMatch(/at most/);
    const clamped = clampWorldSeed(LONG);
    expect(validateWorldSeedShape(clamped)).toBeNull();
    expect(clamped.npcs[1]).toEqual(LONG.npcs[1]);
    expect(clamped.locations.length).toBeLessThanOrEqual(FIELD_LIMITS.list);
  });
  it('the draft prompt states the limits', () => {
    const text = seedLimitsForPrompt();
    expect(text).toContain(String(FIELD_LIMITS.short));
    expect(text).toMatch(/disposition/);
    expect(text).toContain(String(FIELD_LIMITS.list));
  });
});

describe('acceptableSeed: the server never refuses its own text', () => {
  it('an over-long field the server drafted (a stored draft from before this fix) is clamped at accept', () => {
    const out = acceptableSeed(LONG, LONG);
    expect(validateWorldSeedShape(out)).toBeNull();
  });
  it('an over-long field the host wrote is left for the validator to refuse', () => {
    const edited = { ...LONG, npcs: LONG.npcs.map((n, i) => (i === 1 ? { ...n, disposition: 'x'.repeat(300) } : n)) };
    const out = acceptableSeed(edited, LONG);
    expect(out.npcs[1]!.disposition).toHaveLength(300);
    expect(validateWorldSeedShape(out)).toMatch(/disposition/);
  });
});

describe('the setup chat after a draft', () => {
  const seed = LLM_STUB_REPLIES.worldSeed;
  it('a request to change the world is recognised', () => {
    expect(asksForWorldEdit("Accepting the world gives an error: NPC disposition must be at most 256 characters. Please shorten Mistress Prune's disposition to one short sentence and keep everything else.", seed)).toBe(true);
    expect(asksForWorldEdit('Can you rename Maren to Old Maren?', seed)).toBe(true);
    expect(asksForWorldEdit('Make the lamp room spookier.', seed)).toBe(true);
    expect(asksForWorldEdit('Thanks, this looks great!', seed)).toBe(false);
    expect(asksForWorldEdit('What should I tell my players?', seed)).toBe(false);
  });
  it('a reply claiming a change is recognised', () => {
    expect(claimsWorldEdit('Good catch!\n\nEverything else remains exactly as it was. Please try accepting the world again—let me know if that smooths out the error!')).toBe(true);
    expect(claimsWorldEdit("I've shortened Prune's disposition.")).toBe(true);
    expect(claimsWorldEdit('What tone do you want?')).toBe(false);
  });
  it('the claim comes out and the truth goes in', () => {
    const live = 'Good catch!\n\nEverything else remains exactly as it was. Please try accepting the world again—let me know if that smooths out the error!';
    const redrafting = withoutFalseEditClaim(live, { redrafting: true });
    expect(redrafting).not.toMatch(/try accepting|remains exactly/i);
    expect(redrafting).toMatch(/Good catch!/);
    expect(redrafting).toMatch(/redraft/i);
    const not = withoutFalseEditClaim(live, { redrafting: false });
    expect(not).not.toMatch(/try accepting|remains exactly/i);
    expect(not).toMatch(/not changed|haven't changed|has not changed/i);
  });
});

// ─── In the server ─────────────────────────────────────────────────────────

let harness: Harness;
beforeAll(async () => { harness = await startHarness(); }, 30_000);
afterAll(async () => { await harness.stop(); });

function close(ws: WebSocket): Promise<void> {
  return new Promise(r => { ws.once('close', () => r()); ws.close(); });
}

async function host(firstLine: string) {
  const ws = await connectWs(harness.port);
  const q = new MessageQueue(ws);
  const errors: string[] = [];
  ws.on('message', (data: Buffer) => { const m = JSON.parse(data.toString()); if (m.type === 'error') errors.push(m.message); });
  sendMsg(ws, { type: 'create', name: 'Long Seed', dmPreset: 'chronicler', scenarioId: null, systemId: 'fate-core', houseRules: null });
  await q.waitFor('room-joined', 10_000);
  await q.waitFor('dm-chat-reply', 10_000);
  sendMsg(ws, { type: 'choose-table-role', role: 'dm' } as any);
  await q.waitFor('room-joined', 10_000);
  sendMsg(ws, { type: 'dm-chat', text: firstLine });
  await q.waitFor('dm-chat-reply', 10_000);
  const draft = await q.waitFor('world-seed-draft', 20_000) as any;
  return { ws, q, draft, errors };
}

describe('a drafted over-long world, in the server', () => {
  it('arrives within every limit and is accepted', async () => {
    const { ws, q, draft, errors } = await host('LONG_SEED_TRIGGER A bureaucratic city, gentle peril.');
    expect(validateWorldSeedShape(draft.seed)).toBeNull();
    expect(draft.seed.npcs[0].disposition.length).toBeLessThanOrEqual(FIELD_LIMITS.short);
    sendMsg(ws, { type: 'accept-world-seed', seed: draft.seed } as any);
    let phase: any;
    do { phase = await q.waitFor('phase-change', 15_000); } while (phase.phase !== 'character-creation');
    expect(errors).toEqual([]);
    await close(ws);
  }, 60_000);

  it('the draft prompt tells the drafter the limits', () => {
    const body = harness.receivedBodies.find(b => b.includes('You are a world builder for a TTRPG'))!;
    expect(body).toContain(`${FIELD_LIMITS.short}`);
  });

  it('asked in the chat to shorten a field, the DM redrafts, and never says it changed what it did not', async () => {
    const { ws, q } = await host('LONG_SEED_TRIGGER A bureaucratic city, gentle peril.');
    const drafts = harness.receivedBodies.filter(b => b.includes('You are a world builder for a TTRPG')).length;
    sendMsg(ws, { type: 'dm-chat', text: "EDIT_CLAIM_TRIGGER Please shorten Mistress Prune's disposition to one short sentence and keep everything else." });
    const reply = await q.waitFor('dm-chat-reply', 15_000) as any;
    expect(reply.text).not.toMatch(/try accepting|remains exactly as it was/i);
    expect(reply.text).toMatch(/redraft/i);
    const redraft = await q.waitFor('world-seed-draft', 20_000) as any;
    expect(redraft.accepted).toBe(false);
    const bodies = harness.receivedBodies.filter(b => b.includes('You are a world builder for a TTRPG'));
    expect(bodies.length).toBe(drafts + 1);
    expect(bodies[bodies.length - 1]).toContain("shorten Mistress Prune's disposition");
    await close(ws);
  }, 60_000);
});

describe('the character interview, in the server', () => {
  it('pronouns stated in the first message are never asked for again, and go on the sheet', async () => {
    const hostWs = await connectWs(harness.port);
    const hq = new MessageQueue(hostWs);
    sendMsg(hostWs, { type: 'create', name: 'Pronouns', dmPreset: 'chronicler', scenarioId: null, systemId: 'fate-core', houseRules: null });
    const joined = await hq.waitFor('room-joined', 10_000) as any;
    await finishWorldSetup(hostWs, hq);
    const playerWs = await connectWs(harness.port);
    const pq = new MessageQueue(playerWs);
    sendMsg(playerWs, { type: 'join', joinCode: joined.joinCode, playerName: 'Biz' });
    await pq.waitFor('room-joined', 10_000);
    const before = harness.receivedBodies.length;
    sendMsg(playerWs, { type: 'char-chat', text: "PRONOUNS_ASKED_TRIGGER I'm Biz, I'm 10 and I use they/them. Liz is my mom, I call her Mom." });
    const reply = await pq.waitFor('char-chat-reply', 15_000) as any;
    expect(reply.text).not.toMatch(/refer to you|she\/her, he\/him/);
    expect(reply.text).toMatch(/^Got it, Biz\./);
    const readiness = await pq.waitFor('character-readiness', 10_000) as any;
    expect(readiness.readiness.unmet).not.toContain('pronouns');
    const body = harness.receivedBodies.slice(before).find(b => b.includes('character creation API'))!;
    expect(body).toContain('PRONOUNS ALREADY GIVEN');
    await close(playerWs);
    await close(hostWs);
  }, 60_000);
});
