export type DirectorAttentionKind = 'input' | 'permission';
export interface DirectorAttention { id: string; since: string; kind: DirectorAttentionKind }

// Applied at the session boundary, including workspace role overrides and resume.
export const DIRECTOR_INPUT_GUIDANCE = 'When work cannot continue without a human answer, run `sf agent await-input` immediately before your final question and then wait. This signals the desktop notification. Run it only for a required human decision, never for worker replies, rate limits, or an empty backlog. Do not run other tools after signaling; continue independently when no human answer is needed.';
