/**
 * The server's own stock lines — the fate-point invoke and compel beats and
 * the outcome corrections — picked so the table does not read the same one
 * twice in a row. Live (7MJXE5): "Something shifts — "Unflappable Accountant
 * Mom" — and Liz finds a way through." and "But "I worry about Biz too much"
 * rears its head, complicating everything — though fate offers Liz a
 * consolation." each came back word for word, and "crosses X's path once
 * more", "the words could be X's motto" and "the pull of old habits" came
 * round again for the other character. The old pick was the turn number
 * modulo the list, which lands on the same line whenever the turns line up.
 *
 * One rotation per game: each family remembers the order its variants were
 * used in, for every speaker, and hands out the one used longest ago (never
 * used first). A variant whose text is already in `recent` is passed over too
 * (a resumed game has an empty rotation but still has its transcript).
 *
 * Round 13 (WXKC2C): "Liz feels the pull of old habits — "I worry about Biz
 * too much" — and the universe grants a small mercy in return." was read
 * twice, word for word. Nineteen compels in one game went round the eight
 * compel lines, shared by two speakers, and the least-recently-used variant
 * came back to Liz. The rotation now also remembers every exact line it has
 * handed out this game and never repeats one while an unsaid variant is
 * left, and each family has twelve variants — enough for a long game with
 * two characters before any exact line could come round again.
 */
/**
 * Round 14 (7RAAQ7): "But fate is generous to those it tests.", "…feels the
 * pull of old habits — … the universe grants a small mercy in return." and
 * "…rears its head, complicating everything — though fate offers … a
 * consolation." were each read for Liz AND for Biz. Not a lost memory — one
 * process, no restart: the exact-line memory compared whole lines, and a
 * variant said with Liz's name and trouble is a different string with
 * Biz's, so after fifteen compels went round the twelve variants, Biz was
 * handed the ones Liz had already heard. The memory is now of the VARIANT
 * (family and index), shared by every speaker; each family has twenty-four
 * variants that share no four-word phrase; once a family is spent a compel
 * or invoke says nothing rather than repeat one (`whenSpent: 'skip'`); and
 * the memory is checkpointed (snapshot/restore), so a resumed game keeps it.
 */
export type LineMemory = Record<string, number[]>;

export class LineRotation {
  private lastUse = new Map<string, Map<number, number>>();
  /** The variants said this game, per family, in the order they were said. */
  private said = new Map<string, number[]>();
  private clock = 0;

  /**
   * A variant of `family` that has not been said this game (by anyone),
   * least recently used first, and not already in `recent` (a resumed game
   * with no snapshot still has its transcript). When every variant has been
   * said: '' with `whenSpent: 'skip'`, else the one said longest ago.
   */
  pick(family: string, variants: string[], recent = '', opts: { whenSpent?: 'skip' | 'reuse' } = {}): string {
    if (variants.length === 0) return '';
    const uses = this.lastUse.get(family) ?? new Map<number, number>();
    this.lastUse.set(family, uses);
    const said = this.said.get(family) ?? [];
    this.said.set(family, said);
    const order = variants.map((_, i) => i).sort((a, b) => (uses.get(a) ?? -1) - (uses.get(b) ?? -1));
    const unread = (i: number) => !recent || !recent.includes(variants[i]!);
    const fresh = order.find(i => !said.includes(i) && unread(i));
    if (fresh === undefined && opts.whenSpent === 'skip') {
      console.log(`[lines] every "${family}" line has been said this game — this one goes unsaid rather than repeat`);
      return '';
    }
    const chosen = fresh ?? order.find(unread) ?? order[0]!;
    uses.set(chosen, this.clock++);
    if (!said.includes(chosen)) said.push(chosen);
    return variants[chosen]!;
  }

  /** What has been said, for the checkpoint. */
  snapshot(): LineMemory {
    return Object.fromEntries([...this.said].map(([family, list]) => [family, [...list]]));
  }

  /** Picks up a checkpoint's memory; anything malformed is ignored. */
  restore(memory: LineMemory | null | undefined): void {
    if (!memory || typeof memory !== 'object') return;
    for (const [family, list] of Object.entries(memory)) {
      if (!Array.isArray(list)) continue;
      const indexes = list.filter((i): i is number => Number.isInteger(i) && i >= 0);
      const said = this.said.get(family) ?? [];
      const uses = this.lastUse.get(family) ?? new Map<number, number>();
      for (const i of indexes) {
        if (!said.includes(i)) said.push(i);
        uses.set(i, this.clock++);
      }
      this.said.set(family, said);
      this.lastUse.set(family, uses);
    }
  }
}

/**
 * A stock beat appended to the DM's prose. Live (7RAAQ7): `…in the filing
 * cabinet.". But the victory isn't clean — …` — the old join put a full
 * stop after the closing quote of a sentence that had already ended.
 * Ended prose (terminal punctuation, then any closing quotes or brackets)
 * gets a space; unended prose gets a full stop first.
 */
export function appendBeat(text: string, beat: string): string {
  const t = (text ?? '').trimEnd();
  const b = beat.trim();
  if (!t) return b;
  if (!b) return t;
  return /[.!?…]["'”’»)\]*_]*$/.test(t) ? `${t} ${b}` : `${t}. ${b}`;
}

/** The line when a character spends a fate point on their high concept. Names only, no pronouns. No two share a four-word phrase. */
export function invokeLines(name: string, aspect: string): string[] {
  return [
    `${name} draws on "${aspect}" — and the tide turns.`,
    `Something shifts — "${aspect}" — and ${name} finds a way through.`,
    `${name} channels "${aspect}," turning a close call into a decisive moment.`,
    `"${aspect}" is not just a phrase for ${name} — it is exactly what this moment needed.`,
    `${name} leans on "${aspect}". The moment gives way.`,
    `It takes every bit of "${aspect}", but ${name} makes it count.`,
    `That is "${aspect}" at work — ${name} comes through.`,
    `When it counts, ${name} is every inch "${aspect}" — and it shows.`,
    `"${aspect}" — ${name} plays to it, and the odds give a little.`,
    `Click: ${name} digs into "${aspect}" and everything falls into place.`,
    `Pure "${aspect}": ${name} finds the angle nobody else saw.`,
    `Does "${aspect}" pay off? For ${name}, this time, it does.`,
    `Being "${aspect}" is what carries ${name} over the line this time.`,
    `${name} remembers what "${aspect}" means; the problem shrinks to size.`,
    `A little "${aspect}" goes a long way: ${name} turns it around.`,
    `"${aspect}", through and through — that is how ${name} wins the moment.`,
    `A fate point on "${aspect}"? Money well spent, ${name}.`,
    `Nobody does "${aspect}" quite like ${name} does. Proof, right here.`,
    `${name} calls on "${aspect}" and luck answers.`,
    `With "${aspect}" behind the effort, ${name} pulls it off.`,
    `"${aspect}" was made for moments like this, and ${name} knows it.`,
    `${name} lets "${aspect}" lead. A way opens up.`,
    `One glance says this is a job for "${aspect}". ${name} delivers.`,
    `"${aspect}" tips the balance. ${name} comes out ahead!`,
  ];
}

/**
 * The line when a character's trouble is compelled and earns them a fate
 * point. Read at family tables too (a ten-year-old heard "the words could be
 * Biz's epitaph"): trouble stays trouble, never a death. No two share a
 * four-word phrase — a shared tail ("…a fate point for the trouble") reads
 * as the same line again.
 */
export function compelLines(name: string, trouble: string): string[] {
  return [
    `${name} feels the pull of old habits — "${trouble}" — and the universe grants a small mercy in return.`,
    `But "${trouble}" rears its head, complicating everything — though fate offers ${name} a consolation.`,
    `"${trouble}" — the words could be ${name}'s motto, and today they earn a point.`,
    `Guess who is back? "${trouble}". ${name} pays for it now and collects later.`,
    `${name}'s "${trouble}" makes itself known at precisely the wrong moment — as it always does.`,
    `Of course — "${trouble}". ${name} cannot help it, and the story quietly takes note.`,
    `"${trouble}" tugs at ${name} again; the story bends around it, and ${name} earns a little luck for later.`,
    `There it is again: "${trouble}". It costs ${name} now, but fate keeps count.`,
    `One point to ${name}, courtesy of "${trouble}".`,
    `${name} and "${trouble}", together again; the story takes the detour, and ${name} is owed one.`,
    `Right on cue, "${trouble}" gets in ${name}'s way. Worth a point, at least.`,
    `"${trouble}" is part of who ${name} is, and today it shows; the dice will remember.`,
    `${name} knows the feeling: "${trouble}". This time it wins, and luck changes hands.`,
    `Trouble has a name today, and it is "${trouble}" — ${name} shrugs and banks the favor.`,
    `A familiar tug — "${trouble}" — sends ${name} sideways, and the story owes ${name} for it.`,
    `"${trouble}" gets the upper hand for a moment; ${name} will have the last laugh.`,
    `No surprise there: "${trouble}" again, and ${name}'s luck quietly grows.`,
    `${name} sighs. "${trouble}" — every single time. Still, a point is a point.`,
    `"${trouble}" makes things harder for ${name}, and the tale rewards the honesty.`,
    `How many times now? "${trouble}", again. ${name} takes the setback and a token for the trouble.`,
    `${name} can't resist: "${trouble}". Small setback; small reward.`,
    `Here comes "${trouble}", right when ${name} least needs it. The dice will make it up to ${name}.`,
    `"${trouble}" leads ${name} astray for a beat; the luck from it will come in handy.`,
    `${name}'s old friend "${trouble}" drops by uninvited and leaves a small gift behind.`,
  ];
}
