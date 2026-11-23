export const NOTE_CODES = ["canon_image_count", "fuji_image_count"] as const;
export type NoteCode = (typeof NOTE_CODES)[number];

export function isNoteCode(value: unknown): value is NoteCode {
  return value === "canon_image_count" || value === "fuji_image_count";
}
