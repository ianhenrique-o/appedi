import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { JobState, MediaInfo, ProjectInfo, TranscriptState } from "../../shared/editor";
import type { ProbeResult } from "./ffmpeg";

export const DATA_DIR = process.env.CORTEFLOW_DATA_DIR || join(tmpdir(), "corteflow");
const TTL_MS = Number(process.env.CORTEFLOW_TTL_HOURS || 12) * 60 * 60 * 1000;

export function fontsDir() {
  const candidates = [
    process.env.CORTEFLOW_FONTS_DIR,
    resolve(process.cwd(), "server/assets/fonts"),
    resolve(import.meta.dirname ?? ".", "../server/assets/fonts"),
    resolve(import.meta.dirname ?? ".", "../assets/fonts"),
  ].filter(Boolean) as string[];
  return candidates.find((dir) => existsSync(dir)) ?? candidates[1];
}

export type Project = {
  id: string;
  name: string;
  dir: string;
  sourcePath: string;
  probe: ProbeResult;
  info: ProjectInfo;
  transcript: TranscriptState;
  previewPath?: string;
  previewPromise?: Promise<string>;
  media: Map<string, { info: MediaInfo; path: string }>;
  touchedAt: number;
};

export type Job = JobState & { outputPath?: string; srtPath?: string; touchedAt: number };

export const projects = new Map<string, Project>();
export const jobs = new Map<string, Job>();

export const ID_PATTERN = /^[a-f0-9-]{36}$/;

export async function createProjectDir(id: string) {
  const dir = join(DATA_DIR, id);
  await mkdir(dir, { recursive: true });
  return dir;
}

export function getProject(id: string) {
  if (!ID_PATTERN.test(id)) return null;
  const project = projects.get(id) ?? null;
  if (project) project.touchedAt = Date.now();
  return project;
}

let cleanupTimer: NodeJS.Timeout | null = null;
export function startCleanup() {
  if (cleanupTimer) return;
  cleanupTimer = setInterval(async () => {
    const now = Date.now();
    for (const [id, project] of projects) {
      if (now - project.touchedAt > TTL_MS) {
        projects.delete(id);
        await rm(project.dir, { recursive: true, force: true }).catch(() => undefined);
      }
    }
    for (const [id, job] of jobs) {
      if (now - job.touchedAt > TTL_MS) jobs.delete(id);
    }
  }, 20 * 60 * 1000);
  cleanupTimer.unref();
}
