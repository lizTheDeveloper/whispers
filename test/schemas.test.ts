import { describe, it, expect } from 'vitest';
import { DmSetupReplySchema } from '../src/server/agents/schemas.js';

describe('DmSetupReplySchema', () => {
  // The live LLM routinely omits `done` entirely rather than sending
  // `done: false` — reproduced live as
  // "[llm-client] JSON parsed but Zod rejected: done: Required" on roughly
  // half of "finalize the world" replies. Absence must parse to done: false
  // (not finished — the safe reading), not throw.
  it('defaults done to false when the field is absent entirely', () => {
    const parsed = DmSetupReplySchema.parse({
      reply: 'Tell me more about the tone you want.',
      // done omitted entirely — this is the shape the live model actually sent.
    });
    expect(parsed.done).toBe(false);
  });

  it('still honors an explicit done: true', () => {
    const parsed = DmSetupReplySchema.parse({
      reply: 'Got it — I have what I need.',
      done: true,
      dmInstructions: 'A haunted lighthouse.',
    });
    expect(parsed.done).toBe(true);
  });
});
