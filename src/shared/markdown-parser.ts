import type { CharacterDefinition } from './types.js';

function applyField(def: CharacterDefinition, section: string, text: string): void {
  const key = section.toLowerCase().replace(/[^a-z ]/g, '').trim();
  if (key === 'name' || key === 'character name') {
    def.name = text;
  } else if (key === 'high concept' || key === 'concept') {
    def.highConcept = text;
  } else if (key === 'trouble') {
    def.trouble = text;
  } else if (key === 'aspects' || key === 'other aspects' || key === 'additional aspects') {
    def.aspects = text.split('\n').map(l => l.replace(/^[-*]\s*/, '').trim()).filter(Boolean);
  } else if (key === 'personality' || key === 'personality traits') {
    def.personality = text;
  } else if (key === 'backstory' || key === 'background' || key === 'history') {
    def.backstory = text;
  } else if (key === 'skills') {
    for (const line of text.split('\n')) {
      const m = line.match(/[-*]?\s*(.+?)[\s:]+\+?(\d+)/);
      if (m && m[1] && m[2]) def.skills[m[1].trim()] = parseInt(m[2], 10);
    }
  } else if (key === 'stunts' || key === 'special abilities') {
    def.stunts = text.split('\n').map(l => l.replace(/^[-*]\s*/, '').trim()).filter(Boolean);
  }
}

export function parseOneCharacter(md: string): CharacterDefinition {
  const lines = md.split('\n');
  const def: CharacterDefinition = {
    name: '', highConcept: '', trouble: '',
    aspects: [], personality: '', backstory: '',
    skills: {}, stunts: [],
  };

  let currentSection = '';
  let sectionBuffer: string[] = [];

  function flushSection() {
    const text = sectionBuffer.join('\n').trim();
    if (currentSection && text) applyField(def, currentSection, text);
    sectionBuffer = [];
  }

  for (const line of lines) {
    const heading = line.match(/^#{1,3}\s+(.+)/);
    const boldLabel = line.match(/^\*\*(.+?)\*\*[:\s]*(.*)/);
    if (heading && heading[1]) {
      flushSection();
      currentSection = heading[1];
      continue;
    }
    if (boldLabel && boldLabel[1]) {
      flushSection();
      currentSection = boldLabel[1];
      if (boldLabel[2]?.trim()) sectionBuffer.push(boldLabel[2].trim());
      continue;
    }
    sectionBuffer.push(line);
  }
  flushSection();

  if (!def.name) {
    const firstHeading = lines.find(l => /^#\s+/.test(l));
    if (firstHeading) def.name = firstHeading.replace(/^#+\s*/, '').trim();
  }

  return def;
}

export function parseCharacters(md: string): CharacterDefinition[] {
  const hrBlocks = md.split(/\n---+\n/);

  if (hrBlocks.length > 1) {
    return hrBlocks
      .map(block => parseOneCharacter(block.trim()))
      .filter(d => d.name);
  }

  const lines = md.split('\n');
  const blocks: string[] = [];
  let current: string[] = [];

  for (const line of lines) {
    if (/^#\s+/.test(line) && current.length > 0) {
      const parsed = parseOneCharacter(current.join('\n'));
      if (parsed.name || parsed.highConcept) {
        blocks.push(current.join('\n'));
      }
      current = [line];
    } else {
      current.push(line);
    }
  }
  if (current.length > 0) {
    blocks.push(current.join('\n'));
  }

  const results = blocks
    .map(block => parseOneCharacter(block.trim()))
    .filter(d => d.name);

  return results.length > 0 ? results : [parseOneCharacter(md)];
}
