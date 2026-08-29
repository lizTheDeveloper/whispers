import { describe, it, expect } from 'vitest';
import { parseOneCharacter, parseCharacters } from '../src/shared/markdown-parser.js';

describe('parseOneCharacter', () => {
  it('parses headings-based character sheet', () => {
    const md = `# Sigmund the Bold

## High Concept
Reformed Thief with a Heart of Gold

## Trouble
Can't Resist a Locked Door

## Aspects
- Quick Hands
- Loyal to a Fault

## Personality
Cautious but impulsive when gold is involved.

## Backstory
Born in the slums of Veridian, Sigmund learned to pick pockets before he learned to read.

## Skills
- Notice: +2
- Fight: +1
- Stealth: +1

## Stunts
- Lockpicker Supreme
- Shadow Step`;

    const char = parseOneCharacter(md);
    expect(char.name).toBe('Sigmund the Bold');
    expect(char.highConcept).toBe('Reformed Thief with a Heart of Gold');
    expect(char.trouble).toBe("Can't Resist a Locked Door");
    expect(char.aspects).toEqual(['Quick Hands', 'Loyal to a Fault']);
    expect(char.personality).toBe('Cautious but impulsive when gold is involved.');
    expect(char.backstory).toContain('Born in the slums');
    expect(char.skills).toEqual({ Notice: 2, Fight: 1, Stealth: 1 });
    expect(char.stunts).toEqual(['Lockpicker Supreme', 'Shadow Step']);
  });

  it('parses bold-label format', () => {
    const md = `**Name:** Elara Moonwhisper
**High Concept:** Elven Sage Who Speaks to Stars
**Trouble:** Cryptic to a Fault
**Personality:** Serene and distant
**Backstory:** She left the Silver Court ages ago.`;

    const char = parseOneCharacter(md);
    expect(char.name).toBe('Elara Moonwhisper');
    expect(char.highConcept).toBe('Elven Sage Who Speaks to Stars');
    expect(char.trouble).toBe('Cryptic to a Fault');
    expect(char.personality).toBe('Serene and distant');
  });

  it('falls back to first heading as name', () => {
    const md = `# Grunk the Destroyer

A massive half-orc barbarian.`;

    const char = parseOneCharacter(md);
    expect(char.name).toBe('Grunk the Destroyer');
  });

  it('handles missing fields gracefully', () => {
    const md = `# Mystery Character`;
    const char = parseOneCharacter(md);
    expect(char.name).toBe('Mystery Character');
    expect(char.highConcept).toBe('');
    expect(char.trouble).toBe('');
    expect(char.aspects).toEqual([]);
    expect(char.skills).toEqual({});
  });

  it('handles skills without + prefix', () => {
    const md = `## Skills
- Athletics: 3
- Stealth: 2
- Lore: 1`;

    const char = parseOneCharacter(md);
    expect(char.skills).toEqual({ Athletics: 3, Stealth: 2, Lore: 1 });
  });

  it('handles "Character Name" heading variant', () => {
    const md = `## Character Name
Theron Ashford

## Concept
Wandering Healer`;

    const char = parseOneCharacter(md);
    expect(char.name).toBe('Theron Ashford');
    expect(char.highConcept).toBe('Wandering Healer');
  });

  it('handles "Background" as alias for backstory', () => {
    const md = `# Test
## Background
A wanderer from the north.`;

    const char = parseOneCharacter(md);
    expect(char.backstory).toBe('A wanderer from the north.');
  });
});

describe('parseCharacters', () => {
  it('parses multiple characters separated by ---', () => {
    const md = `# Sigmund the Bold

## High Concept
Reformed Thief

## Trouble
Can't Resist a Locked Door

---

# Elara Moonwhisper

## High Concept
Elven Sage

## Trouble
Cryptic to a Fault

---

# Grunk

## High Concept
Barbarian Berserker

## Trouble
Sees Red`;

    const chars = parseCharacters(md);
    expect(chars).toHaveLength(3);
    expect(chars[0]!.name).toBe('Sigmund the Bold');
    expect(chars[0]!.highConcept).toBe('Reformed Thief');
    expect(chars[1]!.name).toBe('Elara Moonwhisper');
    expect(chars[1]!.highConcept).toBe('Elven Sage');
    expect(chars[2]!.name).toBe('Grunk');
    expect(chars[2]!.trouble).toBe('Sees Red');
  });

  it('parses multiple characters by top-level headings', () => {
    const md = `# Sigmund the Bold

## High Concept
Reformed Thief

## Backstory
A thief turned hero.

# Elara Moonwhisper

## High Concept
Elven Sage

## Backstory
She speaks with stars.`;

    const chars = parseCharacters(md);
    expect(chars).toHaveLength(2);
    expect(chars[0]!.name).toBe('Sigmund the Bold');
    expect(chars[0]!.backstory).toBe('A thief turned hero.');
    expect(chars[1]!.name).toBe('Elara Moonwhisper');
    expect(chars[1]!.backstory).toBe('She speaks with stars.');
  });

  it('returns single character when only one present', () => {
    const md = `# Solo Character

## High Concept
The Only One`;

    const chars = parseCharacters(md);
    expect(chars).toHaveLength(1);
    expect(chars[0]!.name).toBe('Solo Character');
  });

  it('filters out blocks with no name', () => {
    const md = `Some random text without structure

---

# Actual Character

## High Concept
Real Hero`;

    const chars = parseCharacters(md);
    expect(chars).toHaveLength(1);
    expect(chars[0]!.name).toBe('Actual Character');
  });

  it('handles ChatGPT-style party output', () => {
    const md = `# Party for "The Lost Temple"

Here are four characters for your adventure:

# Kael Stormbreaker

## High Concept
Dwarven War Priest

## Trouble
Haunted by Fallen Comrades

## Aspects
- Shield of the Mountain
- "By Moradin's Hammer!"

## Skills
- Fight: +4
- Will: +3
- Physique: +3

# Lyra Silvertongue

## High Concept
Half-Elf Diplomat and Spy

## Trouble
Too Many Secrets

## Aspects
- Silver Tongue, Silver Dagger
- Friends in Every Port

## Skills
- Deceive: +4
- Rapport: +3
- Stealth: +3`;

    const chars = parseCharacters(md);
    expect(chars.length).toBeGreaterThanOrEqual(2);
    const kael = chars.find(c => c.name === 'Kael Stormbreaker');
    const lyra = chars.find(c => c.name === 'Lyra Silvertongue');
    expect(kael).toBeDefined();
    expect(kael!.highConcept).toBe('Dwarven War Priest');
    expect(kael!.skills).toEqual({ Fight: 4, Will: 3, Physique: 3 });
    expect(lyra).toBeDefined();
    expect(lyra!.aspects).toContain('Silver Tongue, Silver Dagger');
  });
});
