import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);
const tempDirs: string[] = [];

/**
 * A clip whose audio outlasts its video by a full second -- the shape a
 * phone produces whenever the mic keeps recording past the last video
 * frame, which is most handheld clips.
 *
 * Built here rather than committed as a fixture because the property under
 * test is the *relationship* between two stream durations, and a binary
 * blob states that nowhere. Omitting `-shortest` is what makes the muxer
 * run on to the longer input: the container ends up 2s (its longest
 * stream, the audio) while the video stream is 1s.
 */
export async function makeAudioTailVideo(): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sync1-audiotail-"));
  tempDirs.push(dir);
  const filePath = path.join(dir, "audio-tail.mp4");
  await execFileP("ffmpeg", [
    "-y",
    "-f",
    "lavfi",
    "-i",
    "testsrc=duration=1:size=64x36:rate=10",
    "-f",
    "lavfi",
    "-i",
    "sine=duration=2",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    filePath,
  ]);
  return filePath;
}

/** Call from an `afterEach` in any suite that used `makeAudioTailVideo`. */
export function cleanupGeneratedMedia(): void {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
}
