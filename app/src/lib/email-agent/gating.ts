/** Client-safe pure rules for the agent page: why Approve is off (null = it may be clicked). */
export type ApproveBlock = "approved" | "dirty" | "examples" | "sender" | null;

export function approveBlock(i: { approved: boolean; dirty: boolean; hasPreview: boolean; examples: number; hasSender: boolean }): ApproveBlock {
  if (i.approved) return "approved";
  if (i.dirty) return "dirty";
  if (!i.hasPreview || i.examples === 0) return "examples";
  if (!i.hasSender) return "sender";
  return null;
}
