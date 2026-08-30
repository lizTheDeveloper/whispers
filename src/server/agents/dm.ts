import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { callLlm } from './llm-client.js';
import { DmNarrationSchema, DmResolutionSchema, CharacterValidationSchema, SceneSummarySchema, DmSetupReplySchema, CharInterviewReplySchema } from './schemas.js';
import type { DmNarration, DmResolution, CharacterValidation, DmSetupReply, CharInterviewReply } from './schemas.js';
import { searchRules, type RuleChunk } from '../rag/search.js';
import type Database from 'better-sqlite3';
import type { CharacterDefinition, TranscriptMessage, DiceResult } from '../../shared/types.js';

const presetCache = new Map<string, string>();
function loadPresetText(presetName: string): string | null {
  if (!/^[a-z0-9-]{1,64}$/.test(presetName)) return null;
  if (presetCache.has(presetName)) return presetCache.get(presetName)!;
  const base = dirname(fileURLToPath(import.meta.url));
  const presetsDir = resolve(base, '../../data/dm-presets');
  const p = resolve(presetsDir, `${presetName}.txt`);
  if (!p.startsWith(presetsDir + '/')) return null;
  if (!existsSync(p)) return null;
  const text = readFileSync(p, 'utf-8').trim();
  presetCache.set(presetName, text);
  return text;
}

export interface ScenePacing {
  sceneNumber: number;
  sceneTurnCount: number;
  characterSummaries: string;
  partySize: number;
  sessionTurnCount?: number;
  locationTurnCount?: number;
  currentLocationName?: string;
}

interface DmContext {
  preset: string;
  houseRules: string | null;
  dmInstructions: string | null;
  dmCustomPrompt: string | null;
  campaignId: string;
  worldSummary: string;
  transcript: TranscriptMessage[];
  systemId: string;
}

export class DmAgent {
  constructor(private db: Database.Database) {}

  async narrate(ctx: DmContext, pacing?: ScenePacing): Promise<DmNarration> {
    const recentTranscript = ctx.transcript.slice(-20).map(m => `[${m.role}${m.characterId ? ':' + m.characterId : ''}] ${m.content}`).join('\n');

    const turnCount = pacing?.sceneTurnCount ?? 0;
    const partySize = pacing?.partySize ?? 1;
    const roundCount = Math.floor(turnCount / partySize);
    const sceneNum = pacing?.sceneNumber ?? 1;

    const sessionTurn = pacing?.sessionTurnCount ?? 0;

    // Session-level three-act structure (Act III at scene 4+ so a ~25-turn session reaches resolution)
    let sessionArc: string;
    if (sceneNum <= 1) {
      sessionArc = 'ACT I (Setup): Establish the world, introduce the central mystery or threat. Plant clues and introduce key NPCs. The dramatic question should be clear by scene end.';
    } else if (sceneNum <= 3) {
      sessionArc = 'ACT II (Confrontation): Escalate complications. Alliances are tested, secrets are revealed, the threat becomes personal. Make the characters pay a cost for progress.';
    } else if (sceneNum <= 4) {
      sessionArc = 'ACT III (Resolution): Drive toward the climax. The dramatic question MUST be answered this act. Converge all threads toward a final confrontation or revelation. Stop introducing new complications — use what exists.';
    } else {
      sessionArc = `SESSION FINALE (scene ${sceneNum}): This is the LAST scene. Let it play out over multiple turns — do NOT try to narrate several rounds in one response. Each narration is ONE moment: describe what happens, let the character act, then you narrate again. No new locations or mysteries. Use established NPCs, items, and threads. Build toward a decisive confrontation, then end with a denouement. Do NOT set isSceneEnd on the opening narration.`;
    }

    if (sessionTurn >= 20 && sceneNum >= 4) {
      if (sceneNum >= 5 && roundCount >= 5) {
        sessionArc += ` WRAP UP NOW (turn ${sessionTurn}, round ${roundCount}): narrate the final outcome — victory, defeat, or bittersweet resolution — and set isSceneEnd to true. The story must end.`;
      } else if (sceneNum >= 5 && roundCount >= 3) {
        sessionArc += ` (Turn ${sessionTurn}, round ${roundCount} — the climax should land THIS round. After one more decisive action, narrate the resolution and end the scene.)`;
      } else {
        sessionArc += ` (Turn ${sessionTurn} of session — converge toward resolution, but give the ending room to breathe.)`;
      }
    }

    const developThreshold = partySize <= 1 ? 2 : 2;
    const escalateThreshold = partySize <= 1 ? 5 : Math.max(2, 4 - partySize);

    const hasPreviousScene = sceneNum > 1;
    const pacingHint = roundCount === 0
      ? hasPreviousScene
        ? 'This is the opening of a NEW scene. Bridge from the previous scene — acknowledge what changed, what was won or lost, and why the party is in a different situation now. Then set the new stage: describe the new location, atmosphere, and sensory details. If UNRESOLVED THREADS exist in the world state, weave at least one into this scene opening as a hook or complication. The scene transition should feel like a chapter break, not a jump cut.'
        : 'This is the opening of the FIRST scene. Set the stage vividly — describe the location, atmosphere, and any sensory details. Introduce the dramatic question. Hint at trouble or opportunity.'
      : roundCount < developThreshold
      ? 'The scene is developing. Introduce complications, NPCs with agendas, or environmental obstacles. Not everything should go smoothly. Do NOT set isSceneEnd — the scene has barely started.'
      : roundCount < escalateThreshold
      ? 'The scene is in full swing. Escalate stakes — consequences from earlier actions catch up, allies may be threatened, hard choices emerge. Move toward a dramatic turning point. Do NOT set isSceneEnd yet — let the tension build.'
      : roundCount < escalateThreshold + 3
      ? `The scene has run for ${roundCount} rounds. Actively look for a climactic moment to end the scene. If a dramatic beat just landed, tension peaked, the party reached a new location, combat concluded, or a key revelation dropped — set isSceneEnd to true. Transition to keep the narrative moving.`
      : `SCENE OVERRUN: ${roundCount} rounds. You MUST end this scene NOW. Narrate a dramatic climax or cliffhanger and set isSceneEnd to true. Do not continue — the story needs to move forward.`;

    const locTurns = pacing?.locationTurnCount ?? 0;
    const locationHint = locTurns >= 4
      ? `\nLOCATION WARNING: The party has been at "${pacing?.currentLocationName ?? 'this location'}" for ${locTurns} turns. You MUST move them to a DIFFERENT location from the "Known locations" list. Create a reason to leave — a sound from another room, a discovered passage, an NPC leading them away, or danger forcing retreat.`
      : locTurns >= 3
      ? `\n(The party has been at "${pacing?.currentLocationName ?? 'this location'}" for ${locTurns} turns. Consider moving them to keep the story dynamic.)`
      : '';

    const charBlock = pacing?.characterSummaries ? `\n\nParty status:\n${pacing.characterSummaries}` : '';
    const partyHint = (pacing?.partySize ?? 1) > 1
      ? ' With multiple characters, react to how their actions affect each other — a warrior\'s charge creates openings, a healer\'s work changes who can act, a scholar\'s discovery reshapes the situation for everyone.'
      : '';
    const sceneLabel = pacing ? `Scene ${pacing.sceneNumber}, round ${roundCount + 1} (turn ${turnCount + 1})` : 'Scene';

    const { systemPrompt, criticalReminder, narrationHint } = this.buildSystemPrompt(ctx);
    const personalityReminder = criticalReminder ? `\n\nPERSONALITY REQUIREMENT: ${criticalReminder}` : '';

    return callLlm({
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `${sceneLabel}${charBlock}\n\nWorld state:\n${ctx.worldSummary}\n\nRecent transcript:\n${recentTranscript}\n\nSession arc: ${sessionArc}\n\nPacing: ${pacingHint}${locationHint}\n\nNarrate what happens next in 2-4 vivid sentences. Describe ONE moment, not multiple rounds. If UNRESOLVED THREADS appear in the world state, let them echo in the background — an overheard rumor, a shadow of the unfinished business, a ticking clock. Don't resolve them in narration, but keep them alive.${partyHint}\n\ncurrentLocationName MUST be an EXACT name from the "Known locations" or "UNVISITED locations" list in the world state (copy-paste the name exactly). NEVER invent a new location name when UNVISITED locations exist — use one of those instead. If the world state shows UNVISITED locations, actively move the party toward one of them.${personalityReminder}\n\nRespond as JSON: { "narration": "2-4 vivid sentences.${narrationHint}", "currentLocationName": "...", "activeNpcs": ["name1", ...], "isSceneEnd": true|false }` },
      ],
      schema: DmNarrationSchema,
      maxTokens: 2048,
    });
  }

  async resolve(ctx: DmContext, action: string, diceResult: DiceResult | null, sceneNumber?: number, characterInfo?: { id: string; name: string; skills: Record<string, number>; stress: number; consequences: string[]; fatePoints: number; aspects?: string[]; highConcept?: string; trouble?: string; inventory?: string[]; partyMembers?: Array<{ id: string; name: string }> }): Promise<DmResolution> {
    const ruleContext = this.lookupRules(ctx.systemId, action);

    const skillList = characterInfo ? Object.entries(characterInfo.skills).map(([k, v]) => `${k}:+${v}`).join(', ') : '';
    const diceBlock = diceResult
      ? `\nDice result: ${diceResult.description} (total: ${diceResult.total}). FATE resolution steps:
1. Pick the MOST relevant skill from the character's list${skillList ? ` (${skillList})` : ''}
2. Set difficulty using the FATE ladder: 0=Mediocre (trivial), 1=Average (basic), 2=Fair (competent), 3=Good (hard), 4=Great (very hard), 5=Superb (near-impossible). Set difficulty BEFORE calculating — pick what makes narrative sense, not what guarantees a result. A master's challenges should match their skill: a +4 Burglary thief faces Great (+4) vault locks, not Average (+1) padlocks. Set difficulty >= 3 whenever the action uses the character's peak skill — easy victories aren't interesting.
3. Calculate effort = dice total (${diceResult.total}) + skill rank
4. Calculate shifts = effort - difficulty
5. Map shifts to outcome:
   - shifts >= 1: "success" (clear victory)
   - shifts == 0: "tie" (succeed but at a minor cost — you get what you want BUT something goes wrong too)
   - shifts == -1 or -2: "success-with-cost" (you can succeed BUT pay a heavy price — stress, a consequence, or a dangerous complication)
   - shifts <= -3: "failure" (you don't get what you want, and something bad happens)
IMPORTANT: "tie" and "success-with-cost" create the most interesting stories. A clean "success" should only happen when effort clearly exceeds difficulty. When in doubt between success and tie, choose tie.`
      : '';

    const consequenceGuide = (sceneNumber ?? 1) >= 4
      ? ' In Act III, failures should feel final and successes should resolve plot threads decisively.'
      : '';

    let charBlock = '';
    if (characterInfo) {
      const aspectList = [
        characterInfo.highConcept ? `High Concept: "${characterInfo.highConcept}"` : '',
        characterInfo.trouble ? `Trouble: "${characterInfo.trouble}"` : '',
        ...(characterInfo.aspects ?? []).map(a => `"${a}"`),
      ].filter(Boolean).join(', ');
      const inventoryLine = characterInfo.inventory && characterInfo.inventory.length > 0
        ? `\nInventory: ${characterInfo.inventory.join(', ')}`
        : '';
      charBlock = `\nACTING CHARACTER (narrate THEIR action, not another party member's): ${characterInfo.name} (id: ${characterInfo.id})\nAspects: ${aspectList}\nSkills: ${Object.entries(characterInfo.skills).map(([k, v]) => `${k}:+${v}`).join(', ')}\nStress: ${characterInfo.stress}/3 | Consequences: ${characterInfo.consequences.join(', ') || 'none'} | Fate Points: ${characterInfo.fatePoints}${inventoryLine}`;
      if (characterInfo.partyMembers && characterInfo.partyMembers.length > 0) {
        charBlock += `\nParty members: ${characterInfo.partyMembers.map(p => `${p.name} (id: ${p.id})`).join(', ')}`;
      }
      charBlock += '\n';
    }

    const { systemPrompt, criticalReminder, narrationHint } = this.buildSystemPrompt(ctx);
    const personalityReminder = criticalReminder ? `\n\nPERSONALITY REQUIREMENT: ${criticalReminder}` : '';

    return callLlm({
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `${charBlock}${characterInfo ? characterInfo.name : 'Character'}'s action: "${action}"${diceBlock}\n\nRelevant rules:\n${ruleContext}\n\nResolve ${characterInfo ? characterInfo.name + "'s" : 'this'} action using the FATE steps above. A wounded character (high stress, existing consequences) should face HIGHER difficulty (+1 per consequence). Apply meaningful state changes:
- "tie": minor cost (1 stress, or reveal information to an enemy, or lose time)
- "success-with-cost": serious cost (2 stress, or a new consequence like "Twisted Ankle" or "Shaken Confidence", or an NPC turns hostile)
- "failure": bad outcome (stress to max, a severe consequence, enemy gains advantage, or the situation gets worse)
Do NOT leave stateChanges empty on ties, costs, or failures — the mechanical cost IS the story.
NARRATION RULES: Write the result in THIRD PERSON using the ACTING CHARACTER's name (NOT another party member's name). NEVER echo the action text — not even paraphrased with "manages to" or "tries to" prepended. Instead, describe the CONSEQUENCES and WORLD REACTION: what changes in the environment, how NPCs respond, what the character sees/hears/feels. BAD: "Kael manages to swing his sword at the ghost." GOOD: "Kael's blade arcs through the spectral figure — it shrieks, recoiling into the shadows, but a chill crawls up Kael's sword arm where the ghost's essence grazed him." Start with the character's name, then show what HAPPENS, not what they ATTEMPTED. 2-3 vivid sentences.
NPC DIALOGUE: If the action involves talking to, questioning, persuading, or confronting an NPC, the narration MUST include the NPC's spoken response in quotation marks. NPCs who respond with actual words create real drama — "I'll tell you nothing, sellsword" hits harder than "the merchant refuses."
COOPERATIVE ACTIONS: If the action references a party member by name (coordinating, protecting, assisting), lower the difficulty by 1 and narrate how the teamwork helps. If the action HARMS or abandons a party member, add stress to BOTH characters — betrayal costs everyone.
INVENTORY: If the character's inventory contains an item relevant to their action, acknowledge it in the narration and lower difficulty by 1. If they USE an item destructively (a potion consumed, a key that breaks), add {"field":"inventory","action":"remove","value":"<item name>"} to stateChanges. If they GAIN an item through this action, add {"field":"inventory","action":"add","value":"<item name>"}.
FATE POINT ECONOMY: If this action touches the character's trouble aspect or a consequence, COMPEL it — add {"field":"fatePoints","action":"set","value":${(characterInfo?.fatePoints ?? 3) + 1}} and narrate the complication. If the character spent effort invoking an aspect (referenced it in their action), spend a fate point: {"field":"fatePoints","action":"set","value":${Math.max(0, (characterInfo?.fatePoints ?? 3) - 1)}}.${consequenceGuide}${personalityReminder}\n\nRespond as JSON: { "diceExpression": "${diceResult?.expression ?? 'null'}", "difficulty": <number>, "skill": "<skill>", "outcome": "success|failure|tie|success-with-cost", "narration": "2-3 sentences describing what happens.${narrationHint}", "stateChanges": [{"characterId": "${characterInfo?.id ?? '<id>'}", "field": "stress|consequences|fatePoints|inventory", "action": "set|add|remove", "value": <value>}] }\nstateChanges must be objects, not strings. Use [] if no mechanical changes apply.` },
      ],
      schema: DmResolutionSchema,
      maxTokens: 1024,
    });
  }

  async setupChat(presetName: string, history: Array<{ role: string; content: string }>): Promise<DmSetupReply> {
    const systemPrompt = `You are a TTRPG Dungeon Master helping set up a new game. Your base personality is "${presetName}".

Have a natural conversation with the game host to figure out:
1. What TTRPG system to use (suggest free ones: FATE Core, Dungeon World, Cairn, MORK BORG, Knave, Basic Fantasy RPG — or they can upload their own rulebook)
2. What kind of adventure/setting/tone they want
3. Any house rules or special requests
4. How many players to expect

Be conversational and enthusiastic. Ask one or two questions at a time, not a checklist.
If they upload materials, acknowledge them.
When you have enough info, set "done": true and fill in dmInstructions (summary of their preferences) and dmCustomPrompt (your tailored system prompt for running this game).
Until you have enough info, set "done": false and dmInstructions/dmCustomPrompt to null.

Respond as JSON: { "reply": "your message", "done": false, "dmInstructions": null, "dmCustomPrompt": null }`;

    return callLlm({
      messages: [
        { role: 'system', content: systemPrompt },
        ...history,
      ],
      schema: DmSetupReplySchema,
    });
  }

  async interviewForCharacter(systemId: string, history: Array<{ role: string; content: string }>): Promise<CharInterviewReply> {
    const ruleContext = this.lookupRules(systemId, 'character creation aspects skills stunts');

    const systemPrompt = `You are a character creation API for a TTRPG game. You help players build characters through conversation.

Rules reference:
${ruleContext}

Ask about their concept, backstory, skills. Be encouraging. Help if they're stuck.
Guide them toward characters with INTERNAL TENSION — a scholar tempted by forbidden knowledge, a healer who once let someone die, a warrior who fears what they become in battle. The best characters have a clear strength AND a clear vulnerability. The "trouble" aspect should create genuine dilemmas, not minor inconveniences.

CRITICAL: You MUST respond with ONLY a JSON object. No asterisks, no roleplay actions, no narration outside the JSON. Every response must be valid JSON.

When you don't have enough info yet: {"reply": "your question here", "definition": null}
When you have enough info: {"reply": "summary", "definition": {"name": "...", "highConcept": "...", "trouble": "...", "aspects": ["..."], "personality": "...", "backstory": "...", "skills": {"Skill": 3}, "stunts": ["..."]}}`;

    const lastMsg = history[history.length - 1];
    const augmentedHistory = lastMsg?.role === 'user'
      ? [...history.slice(0, -1), { role: 'user', content: `${lastMsg.content}\n\n(Remember: respond with ONLY a JSON object, no other text)` }]
      : history;

    return callLlm({
      messages: [
        { role: 'system', content: systemPrompt },
        ...augmentedHistory,
      ],
      schema: CharInterviewReplySchema,
      temperature: 0.5,
    });
  }

  async validateCharacter(definition: CharacterDefinition, systemId: string): Promise<CharacterValidation> {
    const ruleContext = this.lookupRules(systemId, 'character creation skills aspects');

    return callLlm({
      messages: [
        { role: 'system', content: `You are a character sheet validation API. You output ONLY JSON. No roleplay, no asterisks, no prose.\n\nRules reference:\n${ruleContext}\n\nApproval criteria — approve if ALL are present:\n- name (non-empty string)\n- highConcept (non-empty string)\n- trouble (non-empty string)\n- aspects (array with at least 2 entries)\n- skills (object with at least 1 entry)\n- stunts (array with at least 1 entry)\n\nIf all criteria are met, set approved=true. Only reject if required fields are missing or empty.` },
        { role: 'user', content: `Validate:\n${JSON.stringify(definition, null, 2)}\n\nReturn ONLY: {"approved": true, "feedback": "one sentence", "modifications": null}` },
      ],
      schema: CharacterValidationSchema,
      temperature: 0.2,
    });
  }

  async summarizeScene(transcript: TranscriptMessage[], characterNames?: string[], worldState?: string): Promise<string> {
    const text = transcript.map(m => `[${m.role}] ${m.content}`).join('\n');
    const charHint = characterNames && characterNames.length > 0
      ? ` For each character (${characterNames.join(', ')}), note their last action and current situation.`
      : '';
    const worldHint = worldState
      ? `\n\nThe world bible already tracks these facts (do NOT repeat them — focus on narrative, character emotions, and unresolved tension instead):\n${worldState}`
      : '';
    const hasRecap = transcript.some(m => m.content.startsWith('[Session recap]'));
    const compactionHint = hasRecap
      ? '\nIMPORTANT: The transcript begins with a prior recap. Preserve ALL named characters, NPCs, locations, and plot threads from that recap. Add new developments from recent events. Do not lose earlier details.'
      : '';
    try {
      const result = await callLlm({
        messages: [
          { role: 'system', content: 'You are a JSON API. Summarize TTRPG scenes. Output ONLY a JSON object.' },
          { role: 'user', content: `${text}\n\nSummarize in 3-5 sentences. Cover: what happened, who was involved, what changed, and what's unresolved.${charHint}${compactionHint}${worldHint} Include any NPC reactions, items found, or locations visited. End with a TRANSITION HOOK — one sentence that creates urgency for the next scene (a sound in the distance, a ticking clock, a choice that can't wait, an NPC who just left with a secret).\n\nRespond as JSON: {"summary": "your summary here"}` },
        ],
        schema: SceneSummarySchema,
      });
      return result.summary;
    } catch {
      const plainText = await callLlm({
        messages: [
          { role: 'system', content: 'Summarize this TTRPG scene in 3-5 sentences. Plain text only, no JSON.' },
          { role: 'user', content: `${text}\n\nCover: what happened, who was involved, what changed.${charHint}` },
        ],
        maxTokens: 512,
      });
      return plainText.trim() || 'The scene draws to a close.';
    }
  }

  private buildSystemPrompt(ctx: DmContext): { systemPrompt: string; criticalReminder: string; narrationHint: string } {
    let prompt: string;
    let criticalSection = '';
    let narrationHint = '';
    if (ctx.dmCustomPrompt) {
      prompt = ctx.dmCustomPrompt + '\n';
    } else {
      let presetText = loadPresetText(ctx.preset) ?? '';
      const criticalIdx = presetText.indexOf('CRITICAL:');
      if (criticalIdx >= 0) {
        criticalSection = '\n' + presetText.slice(criticalIdx);
        presetText = presetText.slice(0, criticalIdx).trimEnd();
        if (ctx.preset === 'professor') {
          narrationHint = ' IMPORTANT: End the narration with a parenthetical teaching aside like (Empathy +4 vs Good difficulty = three shifts of success!)';
        } else if (ctx.preset === 'chronicler') {
          narrationHint = ' IMPORTANT: Include at least one non-visual sense (sound, smell, touch, or taste) in the narration';
        } else if (ctx.preset === 'trickster') {
          narrationHint = ' IMPORTANT: Include dramatic irony, dark humor, or a hidden cost in the narration';
        }
      }
      prompt = presetText ? presetText + '\n' : `You are a TTRPG Dungeon Master with the "${ctx.preset}" personality.\n`;
    }

    prompt += `
Storytelling principles:
- Actions have real consequences. Not every plan works. Failure creates drama.
- NPCs have their own goals and react to the party's actions, even between scenes.
- VOICE YOUR NPCs: When an NPC is present and the scene involves them, give them ACTUAL DIALOGUE in quotation marks. A tavern keeper says "You'll find no friends past the Irongate — just ghosts and the things that eat them." A guard captain barks "State your business or turn back." NPCs who speak feel alive; NPCs who are only described feel like furniture. At least one NPC should speak per narration when NPCs are present.
- The world moves forward whether characters act or not — time pressure matters.
- Introduce complications that force hard choices, not just combat encounters.
- Use the environment as an active element — weather, terrain, crowds, lighting.
- When characters succeed, success should change the situation, not just confirm it.
- WEAVE BACK earlier threads: if the world state lists UNRESOLVED THREADS, advance at least one per narration. Reintroduce NPCs, revisit locations, or reveal consequences of past actions.
- INVOKE TROUBLE ASPECTS: Each character has a "trouble" aspect — a personal flaw or complication. Create situations that TARGET these troubles. If a character's trouble is "Haunted by the War," put them face-to-face with a war memorial or a former comrade. If it's "Visions I Cannot Unsee," show them something that triggers a vision at the worst moment. Trouble compels create the most memorable scenes.
- VARY your imagery: do not repeat the same visual motifs (e.g. "skeletal hands," "black water") more than twice in a scene. Introduce new sensory details — sounds, smells, temperature, texture — to keep the world alive.
- Build toward a dramatic question — each scene should move the story closer to answering: will the party succeed, and at what cost?
- ADVANCE THROUGH LOCATIONS: Check the "Known locations" list in the world state — the party should visit these NAMED locations as the story progresses. Use their EXACT names in your narration (e.g. "The Clockwork Antechamber" not "a chamber"). Don't let them linger in one location for more than 2-3 rounds. Each scene transition should move deeper into the adventure. If the party has been in the same location for 3+ rounds, create a reason to move them forward — a collapsing passage, a discovered exit, an NPC leading them onward.
- PARTY DYNAMICS: When multiple characters are present, create situations that force them to INTERACT — a locked door one can pick while another stands guard, a moral dilemma where their values conflict, an NPC who trusts one character but fears another. Reference each character's last action in your narration. If one character just failed, show how it affects the others. The most interesting party moments come from characters disagreeing about what to do next.
- WHISPER AWARENESS: Characters hear a mysterious voice (the player's whispers). When the transcript shows a character heeded or resisted a whisper, weave that into the narrative. A character following dangerous whispers might attract dark attention; one resisting wise counsel might face harder consequences. The whisper influence is the game's central tension — make it matter in the story.
- CREATE WHISPER MOMENTS: At least once per scene, present a situation where the "right" choice is ambiguous — a locked door that could be forced or bypassed, a suspicious ally, a tempting shortcut through danger. These fork-in-the-road moments give the player interesting whisper decisions. The player is the character's conscience, and the best stories emerge when conscience is tested.
- USE ITEMS BY EXACT NAME: If the world state lists "Unclaimed items" or "Items you could pick up," use their EXACT names in your narration (e.g. "the Crystal Shard" not "a crystal," "Sparks' Blueprint" not "a map"). Describe a character spotting the item, an NPC offering it, or a situation where it would be useful. When resolving actions, if a character's inventory contains a relevant item, acknowledge it BY NAME and grant a narrative advantage. Items are plot hooks — "Sparks' Blueprint" hints at a secret passage, "the Gala Invitation" proves identity, "the Clockwork Lockpick" opens doors. Named items connect to the game's tracking system — paraphrased items get lost.
`;

    if (ctx.houseRules) prompt += `\nHouse rules: ${ctx.houseRules}\n`;
    if (ctx.dmInstructions) prompt += `\nDM direction: ${ctx.dmInstructions}\n`;

    const campaignMaterials = this.lookupRules(`campaign:${ctx.campaignId}`, ctx.transcript.slice(-5).map(m => m.content).join(' '));
    if (campaignMaterials !== '(No rules found for this query)') {
      prompt += `\nCampaign reference materials:\n${campaignMaterials}\n`;
    }

    if (criticalSection) prompt += criticalSection;
    prompt += `\nAlways respond with valid JSON matching the requested format. Never fabricate dice rolls — use only rolls provided to you.`;
    return { systemPrompt: prompt, criticalReminder: criticalSection.trim(), narrationHint };
  }

  private lookupRules(systemId: string, query: string): string {
    const chunks = searchRules(this.db, systemId, query, 3);
    if (chunks.length === 0) return '(No rules found for this query)';
    return chunks.map((c: RuleChunk) => `[${c.section}] ${c.content}`).join('\n\n');
  }
}
