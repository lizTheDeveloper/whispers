/**
 * Has the host asked, anywhere in the setup chat, not to be spoiled ("No
 * spoilers for me please, I'm playing in it too")? Shared: the server keeps
 * secrets out of the setup chat by it, and the DM lobby hides NPC motives and
 * plot hooks from the host's world card by it.
 */
export function wantsNoSpoilers(history: Array<{ role: string; content: string }>): boolean {
  return history.some(m => m.role === 'user' && /\bno spoilers?\b|\bdon['’]?t spoil|\bdo not spoil|\bwithout spoilers|\bspoiler[- ]free|\bnot spoil|\bi['’]?m (?:also )?playing\b|\bi am (?:also )?playing\b|\bplaying in it\b|\bdon['’]?t tell me\b|\bdo not tell me\b|\bsurprise me\b/i.test(m.content));
}
