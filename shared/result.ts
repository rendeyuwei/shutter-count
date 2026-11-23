import type { NoteCode } from "./notes.js";

export type CameraBrand =
  "nikon" | "canon" | "sony" | "fujifilm" | "pentax" | "olympus" | "panasonic";

export interface CameraMetadata {
  make: string | null;
  model: string | null;
  capturedAt: string | null;
}

export type MappedResult = CameraMetadata &
  (
    | {
        status: "ok";
        shutterCount: number;
        shutterSource: string;
        approximate: boolean;
        note: string | null;
        noteCode: NoteCode | null;
      }
    | {
        status: "no_shutter_field";
        shutterCount: null;
        shutterSource: null;
        approximate: false;
        note: null;
        noteCode: null;
      }
  );

export interface MappingSummary {
  brand: CameraBrand | "unknown";
  hasExif: boolean;
  candidateCount: number;
  presentCandidateCount: number;
  invalidCandidateCount: number;
}
