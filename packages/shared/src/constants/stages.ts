export const PHASE2_STAGES = [
  "plan_outline",
  "outline_approval",
  "plan_characters",
  "characters_approval",
  "plan_shots",
  "critique_shots",
  "shots_approval",
  "render_characters",
  "critique_character_images",
  "character_images_approval",
  "render_shot_images",
  "render_shots",
  "critique_shot_images",
  "shot_images_approval",
  "compose_videos",
  "compose_approval",
  "review",
] as const;

export type Phase2Stage = (typeof PHASE2_STAGES)[number];

export const STAGE_ORDER: Record<Phase2Stage, number> = {
  plan_outline: 0,
  outline_approval: 1,
  plan_characters: 2,
  characters_approval: 3,
  plan_shots: 4,
  critique_shots: 5,
  shots_approval: 6,
  render_characters: 7,
  critique_character_images: 8,
  character_images_approval: 9,
  render_shot_images: 10,
  render_shots: 11,
  critique_shot_images: 12,
  shot_images_approval: 13,
  compose_videos: 14,
  compose_approval: 15,
  review: 16,
};

export function nextStage(current: Phase2Stage): Phase2Stage | null {
  const currentOrder = STAGE_ORDER[current];
  const entries = Object.entries(STAGE_ORDER) as [Phase2Stage, number][];
  const next = entries.find(([, order]) => order === currentOrder + 1);
  return next ? next[0] : null;
}
