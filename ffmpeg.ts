import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

export const execFileAsync = promisify(execFile);

export type ProbeResult = {
  duration: number;
  width: number;
  height: number;
  fps: number;
  hasAudio: boolean;
  hasVideo: boolean;
};

function parseRate(rate: string | undefined) {
  if (!rate) return 30;
  const [a, b] = rate.split("/").map(Number);
  const value = b ? a / b : a;
  return Number.isFinite(value) && value > 1 && value < 240 ? value : 30;
}

export async function probe(input: string): Promise<ProbeResult> {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration:stream=codec_type,width,height,avg_frame_rate,r_frame_rate:stream_side_data=rotation:stream_tags=rotate",
    "-of", "json",
    input,
  ], { maxBuffer: 1024 * 1024 * 4 });
  const data = JSON.parse(stdout) as {
    format?: { duration?: string };
    streams?: Array<{
      codec_type?: string; width?: number; height?: number; avg_frame_rate?: string; r_frame_rate?: string;
      side_data_list?: Array<{ rotation?: number }>; tags?: { rotate?: string };
    }>;
  };
  const video = data.streams?.find((s) => s.codec_type === "video");
  const audio = data.streams?.find((s) => s.codec_type === "audio");
  const rotation = Math.abs(Number(video?.side_data_list?.find((d) => d.rotation !== undefined)?.rotation ?? video?.tags?.rotate ?? 0)) % 180;
  let width = video?.width ?? 0;
  let height = video?.height ?? 0;
  if (rotation === 90) [width, height] = [height, width];
  const duration = Number(data.format?.duration);
  return {
    duration: Number.isFinite(duration) && duration > 0 ? duration : 0,
    width,
    height,
    fps: parseRate(video?.avg_frame_rate !== "0/0" ? video?.avg_frame_rate : video?.r_frame_rate),
    hasAudio: Boolean(audio),
    hasVideo: Boolean(video),
  };
}

/** Roda o ffmpeg reportando o progresso (segundos de saída já processados). */
export function runFfmpeg(args: string[], onProgress?: (seconds: number) => void, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn("ffmpeg", ["-hide_banner", "-nostats", "-progress", "pipe:1", ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    let buffer = "";
    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const match = line.match(/^out_time_us=(\d+)/) ?? line.match(/^out_time_ms=(\d+)/);
        if (match && onProgress) onProgress(Number(match[1]) / 1_000_000);
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-6000);
    });
    const abort = () => child.kill("SIGKILL");
    signal?.addEventListener("abort", abort);
    child.on("error", reject);
    child.on("close", (code) => {
      signal?.removeEventListener("abort", abort);
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg saiu com código ${code}: ${stderr.split("\n").filter(Boolean).slice(-4).join(" | ")}`));
    });
  });
}

/** Lê o áudio como PCM mono e devolve o envelope de volume em dBFS. */
export function audioEnvelope(input: string, rate: number, sampleRate = 8000) {
  return new Promise<number[]>((resolve, reject) => {
    const child = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", input, "-vn", "-ac", "1", "-ar", String(sampleRate), "-f", "s16le", "pipe:1"], { stdio: ["ignore", "pipe", "pipe"] });
    const window = Math.max(1, Math.round(sampleRate / rate));
    const out: number[] = [];
    let sum = 0;
    let count = 0;
    let leftover: Buffer | null = null;
    child.stdout.on("data", (chunk: Buffer) => {
      let data = leftover ? Buffer.concat([leftover, chunk]) : chunk;
      const usable = data.length - (data.length % 2);
      leftover = usable < data.length ? data.subarray(usable) : null;
      for (let i = 0; i < usable; i += 2) {
        const v = data.readInt16LE(i) / 32768;
        sum += v * v;
        count++;
        if (count === window) {
          const rms = Math.sqrt(sum / count);
          out.push(Math.round(Math.max(-90, 20 * Math.log10(rms + 1e-9)) * 10) / 10);
          sum = 0;
          count = 0;
        }
      }
    });
    let stderr = "";
    child.stderr.on("data", (c: Buffer) => { stderr += c.toString(); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(out);
      else reject(new Error(`envelope falhou: ${stderr.slice(-400)}`));
    });
  });
}
