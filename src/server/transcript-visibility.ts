import type { TranscriptMessage } from '../shared/types.js';

const WHISPER_VERDICT = /\b(heeded|resisted|partially heeded) the whisper\b/;

/**
 * The shared transcript as one character experiences it. A whisper is a
 * voice inside ONE character's head: the whisper text and the verdict line
 * recording how that character took it (and their trust score) belong to
 * that character alone. Everything else in the transcript — narration,
 * resolutions, every character's spoken actions, dice — happened in the
 * open and stays.
 *
 * Whisper lines with no characterId (none are written that way, but old
 * checkpoints are restored as-is) have no owner to show them to, so they are
 * dropped for everyone.
 */
export function transcriptVisibleTo(transcript: TranscriptMessage[], characterId: string): TranscriptMessage[] {
  return transcript.filter(m => {
    if (m.role === 'whisper') return m.characterId === characterId;
    if (m.role === 'system' && WHISPER_VERDICT.test(m.content)) return m.characterId === characterId;
    return true;
  });
}

/** Transcript lines that are the story itself — everything but whispers. */
export function storyLines(transcript: TranscriptMessage[]): TranscriptMessage[] {
  return transcript.filter(m => m.role !== 'whisper');
}
