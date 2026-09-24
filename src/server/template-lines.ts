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
 */
export class LineRotation {
  private lastUse = new Map<string, Map<number, number>>();
  private clock = 0;

  pick(family: string, variants: string[], recent = ''): string {
    if (variants.length === 0) return '';
    const uses = this.lastUse.get(family) ?? new Map<number, number>();
    this.lastUse.set(family, uses);
    const order = variants.map((_, i) => i).sort((a, b) => (uses.get(a) ?? -1) - (uses.get(b) ?? -1));
    const fresh = order.find(i => !recent || !recent.includes(variants[i]!)) ?? order[0]!;
    uses.set(fresh, this.clock++);
    return variants[fresh]!;
  }
}

/** The line when a character spends a fate point on their high concept. Names only, no pronouns. */
export function invokeLines(name: string, aspect: string): string[] {
  return [
    `${name} draws on "${aspect}" — and the tide turns.`,
    `Something shifts — "${aspect}" — and ${name} finds a way through.`,
    `${name} channels "${aspect}," turning a close call into a decisive moment.`,
    `"${aspect}" is not just a phrase for ${name} — it is exactly what this moment needed.`,
    `${name} leans on "${aspect}", and the moment gives way.`,
    `It takes every bit of "${aspect}", but ${name} makes it count.`,
    `That is "${aspect}" at work — ${name} comes through.`,
  ];
}

/**
 * The line when a character's trouble is compelled and earns them a fate
 * point. Read at family tables too (a ten-year-old heard "the words could be
 * Biz's epitaph"): trouble stays trouble, never a death.
 */
export function compelLines(name: string, trouble: string): string[] {
  return [
    `${name} feels the pull of old habits — "${trouble}" — and the universe grants a small mercy in return.`,
    `But "${trouble}" rears its head, complicating everything — though fate offers ${name} a consolation.`,
    `"${trouble}" — the words could be ${name}'s motto. But fate is generous to those it tests.`,
    `"${trouble}" crosses ${name}'s path once more, and with it comes a glimmer of fate's favor.`,
    `${name}'s "${trouble}" makes itself known at precisely the wrong moment — as it always does.`,
    `Of course — "${trouble}". ${name} cannot help it, and fate quietly takes note.`,
    `"${trouble}" tugs at ${name} again; the story bends around it, and ${name} earns a little luck for later.`,
    `There it is again: "${trouble}". It costs ${name} now, but fate keeps count.`,
  ];
}
