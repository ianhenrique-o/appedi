import { readFile, stat } from "node:fs/promises";
import type { Word } from "../../shared/editor";
import { normalizeWord } from "../../shared/editor";
import { execFileAsync } from "./ffmpeg";

type Provider = { name: string; url: string; key: string; model: string; wordTimestamps: boolean };

const PROMPT =
  "Transcrição em português brasileiro de um vídeo curto para Instagram. Use pontuação. Mantenha hesitações como ahn, hum, éé quando aparecerem.";

export function transcriptionProvider(): Provider | null {
  const env = process.env;
  if (env.TRANSCRIPTION_API_KEY) {
    return {
      name: "personalizado",
      url: (env.TRANSCRIPTION_API_URL || "https://api.openai.com/v1").replace(/\/+$/, ""),
      key: env.TRANSCRIPTION_API_KEY,
      model: env.TRANSCRIPTION_MODEL || "whisper-1",
      wordTimestamps: true,
    };
  }
  if (env.GROQ_API_KEY) {
    return { name: "Groq", url: "https://api.groq.com/openai/v1", key: env.GROQ_API_KEY, model: env.TRANSCRIPTION_MODEL || "whisper-large-v3-turbo", wordTimestamps: true };
  }
  if (env.OPENAI_API_KEY) {
    return { name: "OpenAI", url: "https://api.openai.com/v1", key: env.OPENAI_API_KEY, model: env.TRANSCRIPTION_MODEL || "whisper-1", wordTimestamps: true };
  }
  if (env.MANUS_API_URL && env.MANUS_API_KEY) {
    return { name: "Manus", url: env.MANUS_API_URL, key: env.MANUS_API_KEY, model: "whisper", wordTimestamps: false };
  }
  return null;
}

type VerboseSegment = { start: number; end: number; text: string };
type VerboseWord = { word: string; start: number; end: number };

/** Whisper devolve as palavras sem pontuação; recupera a pontuação a partir dos segmentos. */
export function mergePunctuation(words: VerboseWord[], segments: VerboseSegment[]): Word[] {
  const tokens: string[] = segments.flatMap((s) => s.text.split(/\s+/).filter(Boolean));
  const out: Word[] = [];
  let t = 0;
  for (const w of words) {
    const target = normalizeWord(w.word);
    let text = w.word.trim();
    for (let look = 0; look < 4 && t + look < tokens.length; look++) {
      if (normalizeWord(tokens[t + look]) === target) {
        text = tokens[t + look];
        t += look + 1;
        break;
      }
    }
    if (text) out.push({ text, start: w.start, end: Math.max(w.end, w.start + 0.05) });
  }
  return out;
}

/** Sem tempo por palavra: distribui as palavras do segmento proporcionalmente ao tamanho. */
export function wordsFromSegments(segments: VerboseSegment[]): Word[] {
  const out: Word[] = [];
  for (const seg of segments) {
    const parts = seg.text.split(/\s+/).filter(Boolean);
    const total = parts.reduce((n, p) => n + p.length + 1, 0);
    let cursor = seg.start;
    const span = Math.max(0.1, seg.end - seg.start);
    for (const p of parts) {
      const len = ((p.length + 1) / total) * span;
      out.push({ text: p, start: cursor, end: cursor + len });
      cursor += len;
    }
  }
  return out;
}

async function extractSpeechAudio(input: string, output: string) {
  await execFileAsync("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-i", input, "-vn", "-ac", "1", "-ar", "16000", "-b:a", "48k", output], { maxBuffer: 1024 * 1024 * 4 });
}

async function openAiCompatible(provider: Provider, audioPath: string): Promise<Word[]> {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(await readFile(audioPath))], { type: "audio/mpeg" }), "audio.mp3");
  form.append("model", provider.model);
  form.append("language", "pt");
  form.append("prompt", PROMPT);
  form.append("response_format", "verbose_json");
  form.append("timestamp_granularities[]", "word");
  form.append("timestamp_granularities[]", "segment");
  const response = await fetch(`${provider.url}/audio/transcriptions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${provider.key}` },
    body: form,
    signal: AbortSignal.timeout(10 * 60 * 1000),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`${provider.name} respondeu ${response.status}: ${body.slice(0, 300)}`);
  }
  const data = (await response.json()) as { words?: VerboseWord[]; segments?: VerboseSegment[] };
  const segments = data.segments ?? [];
  if (data.words?.length) return mergePunctuation(data.words, segments);
  return wordsFromSegments(segments);
}

async function manus(audioPath: string): Promise<Word[]> {
  const { storagePut, storageGetSignedUrl } = await import("../storage");
  const { transcribeAudio } = await import("../_core/voiceTranscription");
  const uploaded = await storagePut(`corteflow/audio/${crypto.randomUUID()}.mp3`, await readFile(audioPath), "audio/mpeg");
  const url = await storageGetSignedUrl(uploaded.key);
  const result = await transcribeAudio({ audioUrl: url, language: "pt", prompt: PROMPT });
  if ("error" in result) throw new Error(result.details || result.error);
  return wordsFromSegments(result.segments ?? []);
}

export async function transcribe(input: string, workDir: string): Promise<{ provider: string; words: Word[] }> {
  const provider = transcriptionProvider();
  if (!provider) throw Object.assign(new Error("Nenhuma chave de transcrição configurada."), { code: "NO_PROVIDER" });
  const audioPath = `${workDir}/fala.mp3`;
  await extractSpeechAudio(input, audioPath);
  const size = (await stat(audioPath)).size;
  if (size > 24.5 * 1024 * 1024) throw new Error("O áudio passou de 25 MB. Corte o vídeo em partes de até 60 minutos.");
  const words = provider.name === "Manus" ? await manus(audioPath) : await openAiCompatible(provider, audioPath);
  return { provider: provider.name, words };
}
