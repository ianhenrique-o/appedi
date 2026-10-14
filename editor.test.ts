import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DEFAULT_AUDIO, DEFAULT_CAPTION_STYLE, DEFAULT_CARD, DEFAULT_SILENCE, autoInserts, autoZooms, buildChunks, cleanCuts, detectSilences, detectSpeechIssues,
  framingAt, insertsToOutput, keepSegments, mapToOutput, mapToSource, refineSilences, smoothFraming, zoomAtOutput, zoomsToOutput, type RenderRequest, type Word,
} from "../../shared/editor";
import { buildAss } from "./captions";
import { audioEnvelope, execFileAsync, probe } from "./ffmpeg";
import { buildPieces, renderProject } from "./render";
import type { Project } from "./store";
import { mergePunctuation } from "./transcribe";

const w = (text: string, start: number, end: number): Word => ({ text, start, end });

describe("linha do tempo", () => {
  it("mapeia tempos através dos cortes", () => {
    const keep = keepSegments([{ start: 2, end: 3 }, { start: 5, end: 6.5 }], 10);
    expect(keep).toEqual([{ start: 0, end: 2 }, { start: 3, end: 5 }, { start: 6.5, end: 10 }]);
    expect(mapToOutput(1, keep)).toBe(1);
    expect(mapToOutput(2.5, keep)).toBeNull();
    expect(mapToOutput(4, keep)).toBe(3);
    expect(mapToOutput(7, keep)).toBe(4.5);
    expect(mapToSource(4.5, keep)).toBe(7);
  });

  it("leva zoom para o tempo final e faz a aproximação suave", () => {
    const keep = keepSegments([{ start: 2, end: 3 }], 10);
    const out = zoomsToOutput([{ start: 1, end: 6, scale: 1.08, ramp: true }], keep);
    expect(out).toEqual([{ a: 1, b: 5, scale: 1.08, ramp: true }]);
    expect(zoomAtOutput(1, out)).toBe(1);
    expect(zoomAtOutput(3, out)).toBeGreaterThan(1.03);
    expect(zoomAtOutput(4.99, out)).toBeCloseTo(1.08, 2);
    expect(zoomAtOutput(5.5, out)).toBe(1);
  });
});

describe("detecções", () => {
  it("acha pausas no envelope respeitando a folga", () => {
    const env = [...Array(50).fill(-20), ...Array(50).fill(-60), ...Array(50).fill(-20)];
    const s = detectSilences(env, 50, 3, DEFAULT_SILENCE);
    expect(s).toHaveLength(1);
    expect(s[0].start).toBeCloseTo(1.12, 2);
    expect(s[0].end).toBeCloseTo(1.88, 2);
  });

  it("acha regravação, repetição e vício", () => {
    const words = [
      w("Hoje", 0, 0.3), w("eu", 0.3, 0.5), w("vou", 0.5, 0.7), w("falar", 0.7, 1.0), w("sobre.", 1.0, 1.3),
      w("Hoje", 2.2, 2.5), w("eu", 2.5, 2.7), w("vou", 2.7, 2.9), w("falar", 2.9, 3.2), w("sobre", 3.2, 3.5), w("fala.", 3.5, 3.9),
      w("Ahn,", 4.2, 4.6), w("o", 4.7, 4.8), w("o", 4.85, 4.95), w("bebê", 5.0, 5.4), w("fala.", 5.4, 5.8),
    ];
    const issues = detectSpeechIssues(words);
    const kinds = issues.map((i) => i.kind);
    expect(kinds).toContain("retake");
    expect(kinds).toContain("filler");
    expect(kinds).toContain("repeat");
    const retake = issues.find((i) => i.kind === "retake")!;
    expect(retake.start).toBe(0);
    expect(retake.end).toBe(2.2);
  });

  it("acha regravação que começou com hesitação e parou no meio", () => {
    const words = [
      w("Ahn,", 0, 0.3), w("a", 0.35, 0.4), w("maioria", 0.4, 0.8), w("das", 0.8, 1.0), w("mães", 1.0, 1.3), w("acha", 1.3, 1.6), w("que", 1.6, 1.8),
      w("A", 3.0, 3.1), w("maioria", 3.1, 3.5), w("das", 3.5, 3.7), w("mães", 3.7, 4.0), w("acha", 4.0, 4.3), w("que", 4.3, 4.5), w("é", 4.5, 4.6), w("só", 4.6, 4.8), w("esperar.", 4.8, 5.3),
    ];
    const issues = detectSpeechIssues(words);
    const retake = issues.find((i) => i.kind === "retake");
    expect(retake?.start).toBe(0.35);
    expect(retake?.end).toBe(3.0);
    expect(issues.find((i) => i.kind === "filler")?.start).toBe(0);
  });

  it("zoom editorial: abertura, palavra-chave e conclusão, sem zoom em tudo", () => {
    const words: Word[] = [];
    const sentencesText = ["Seu filho ainda não fala.", "Isso acontece com muita gente.", "Existem três sinais de atraso.", "A gente vai ver cada um deles.", "Mas antes preciso te contar algo.", "Salva esse vídeo."];
    let t = 0;
    for (const sentence of sentencesText) {
      for (const tok of sentence.split(" ")) { words.push(w(tok, t, t + 0.3)); t += 0.35; }
      t += 0.3;
    }
    const keep = [{ start: 0, end: t }];
    const zooms = autoZooms(keep, words, 1.08);
    expect(zooms[0].start).toBe(0);
    expect(zooms[0].ramp).toBe(true);
    expect(zooms.some((z) => z.start === words.find((x) => x.text === "Existem")!.start)).toBe(true);
    expect(zooms[zooms.length - 1].end).toBeCloseTo(t, 3);
    expect(zooms.every((z) => z.scale <= 1.12)).toBe(true);
    const zoomed = zooms.reduce((n, z) => n + z.end - z.start, 0);
    expect(zoomed / t).toBeLessThan(0.8);
  });

  it("não deixa microcortes e protege a palavra", () => {
    expect(cleanCuts([{ start: 1, end: 2 }, { start: 2.2, end: 3 }], [])).toEqual([{ start: 1, end: 3 }]);
    expect(cleanCuts([{ start: 1, end: 2 }, { start: 2.2, end: 3 }], [w("é", 2.05, 2.15)])).toHaveLength(2);
    const refined = refineSilences([{ id: "p", kind: "silence", start: 1.0, end: 2.0, label: "", detail: "", confidence: 90 }], [w("fala.", 0.5, 1.02), w("Depois", 1.98, 2.3)]);
    expect(refined[0].start).toBeCloseTo(1.16, 2);
    expect(refined[0].end).toBeCloseTo(1.93, 2);
  });

  it("acha comentário de bastidor", () => {
    const issues = detectSpeechIssues([w("Ai", 0, 0.2), w("errei,", 0.2, 0.5), w("vou", 0.5, 0.7), w("de", 0.7, 0.8), w("novo.", 0.8, 1.1), w("Seu", 2, 2.2), w("filho", 2.2, 2.5), w("fala.", 2.5, 2.9)]);
    expect(issues.find((i) => i.kind === "backstage")?.start).toBe(0);
  });

  it("legenda não termina pendurada em palavra fraca", () => {
    const words = ["Quando", "a", "criança", "fala", "pouco", "de", "manhã"].map((x, i) => w(x, i * 0.3, i * 0.3 + 0.25));
    const chunks = buildChunks(words, 4, 40);
    expect(chunks[0].words.map((x) => x.text)).toEqual(["Quando", "a", "criança", "fala"]);
    const chunks2 = buildChunks(["Isso", "acontece", "com", "a", "maioria"].map((x, i) => w(x, i * 0.3, i * 0.3 + 0.25)), 4, 40);
    expect(chunks2[0].words.map((x) => x.text)).toEqual(["Isso", "acontece", "com"]);
  });

  it("câmera calma: ignora tremida e só mexe quando o rosto sai do lugar", () => {
    const raw = [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4].map((t, i) => ({ t, x: i < 5 ? 0.5 + (i % 2) * 0.02 : 0.7, y: 0.4 }));
    const keys = smoothFraming(raw);
    expect(framingAt(1, keys).x).toBeCloseTo(0.5, 1);
    expect(framingAt(4, keys).x).toBeCloseTo(0.7, 2);
  });

  it("sugere 3 apoios, um em cada terço", () => {
    const words: Word[] = [];
    let t = 0;
    for (let s = 0; s < 9; s++) {
      for (const tok of `Frase número ${s + 1} sobre o erro principal.`.split(" ")) { words.push(w(tok, t, t + 0.3)); t += 0.35; }
      t += 0.4;
    }
    const keep = [{ start: 0, end: t }];
    const ins = autoInserts(keep, words);
    expect(ins).toHaveLength(3);
    const out = insertsToOutput(ins, keep);
    expect(out[0].a).toBeLessThan(t / 3);
    expect(out[1].a).toBeGreaterThanOrEqual(t / 3);
    expect(out[2].a).toBeGreaterThanOrEqual((2 * t) / 3);
    expect(out.every((x) => x.b - x.a >= 1.5 && x.b - x.a <= 2.9)).toBe(true);
  });

  it("monta blocos de legenda curtos", () => {
    const chunks = buildChunks([w("um", 0, 0.2), w("dois", 0.2, 0.4), w("três,", 0.4, 0.6), w("quatro", 0.6, 0.8)], 3);
    expect(chunks.map((c) => c.words.length)).toEqual([3, 1]);
  });

  it("recupera a pontuação do Whisper", () => {
    const words = mergePunctuation([{ word: "Olá", start: 0, end: 0.3 }, { word: "mãe", start: 0.3, end: 0.6 }], [{ start: 0, end: 0.6, text: " Olá, mãe!" }]);
    expect(words.map((x) => x.text)).toEqual(["Olá,", "mãe!"]);
  });

  it("legenda segue o tempo depois dos cortes", () => {
    const words = [w("antes", 0, 0.5), w("cortado", 1, 1.5), w("depois", 2, 2.5)];
    const cuts = [{ start: 0.8, end: 1.8 }];
    const ass = buildAss({ width: 1080, height: 1920, words, cuts, keep: keepSegments(cuts, 3), style: { ...DEFAULT_CAPTION_STYLE, maxWords: 1, uppercase: true }, hook: null, outputDuration: 2 });
    expect(ass.content).not.toContain("CORTADO");
    expect(ass.content).toMatch(/0:00:01\.00,.*DEPOIS/);
    expect(ass.srt).toContain("00:00:01,000 --> ");
  });
});

describe("render de verdade com ffmpeg", () => {
  let dir = "";
  let project: Project;
  const base = (over: Partial<RenderRequest>): RenderRequest => ({
    cuts: [], zooms: [], format: "9:16", words: [], captions: DEFAULT_CAPTION_STYLE, hook: null, inserts: [], framing: [],
    card: DEFAULT_CARD, audio: { ...DEFAULT_AUDIO, cleanVoice: false, normalize: false }, quality: "rapida", ...over,
  });
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "corteflow-test-"));
    const source = join(dir, "original.mp4");
    // 6s horizontal: fala (tom) 0-2s, silêncio 2-3.5s, fala 3.5-6s
    await execFileAsync("ffmpeg", [
      "-y", "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", "testsrc2=s=1280x720:r=30:d=6",
      "-f", "lavfi", "-i", "sine=f=440:r=48000:d=6",
      "-af", "volume='if(between(t,2,3.5),0,1)':eval=frame",
      "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-shortest", source,
    ]);
    const image = join(dir, "apoio.png");
    await execFileAsync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=0x2266aa:s=800x600", "-frames:v", "1", image]);
    const music = join(dir, "musica.m4a");
    await execFileAsync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "sine=f=660:d=3", "-c:a", "aac", music]);
    const probed = await probe(source);
    project = {
      id: "00000000-0000-0000-0000-000000000000", name: "teste", dir, sourcePath: source, probe: probed, info: null as never,
      transcript: { status: "ok", provider: null, words: [] }, touchedAt: Date.now(),
      media: new Map([
        ["img", { info: { id: "img", name: "apoio.png", type: "image", duration: 0, url: "" }, path: image }],
        ["mus", { info: { id: "mus", name: "musica.m4a", type: "audio", duration: 3, url: "" }, path: music }],
      ]),
    };
  }, 60000);
  afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

  it("exporta 9:16 com corte, enquadramento no rosto, zoom suave, card, imagem, voz limpa e música", async () => {
    const env = await audioEnvelope(project.sourcePath, 50);
    const silences = detectSilences(env, 50, project.probe.duration, DEFAULT_SILENCE);
    expect(silences.length).toBe(1);
    expect(silences[0].start).toBeGreaterThan(1.9);
    expect(silences[0].end).toBeLessThan(3.6);

    const out = join(dir, "saida.mp4");
    const words = [w("Primeira", 0.2, 0.8), w("frase", 0.8, 1.6), w("segunda", 3.6, 4.4), w("frase.", 4.4, 5.2)];
    const result = await renderProject(project, base({
      cuts: silences, words,
      zooms: [{ start: 0, end: 2, scale: 1.08, ramp: true }, { start: 3.6, end: 5, scale: 1.06 }],
      framing: [{ t: 0, x: 0.3, y: 0.4 }, { t: 3.5, x: 0.3, y: 0.4 }, { t: 4.2, x: 0.7, y: 0.45 }],
      inserts: [{ id: "a", kind: "card", start: 0.4, end: 1.4, text: "Três sinais importantes" }, { id: "b", kind: "media", start: 4.4, end: 5.4, text: "", mediaId: "img" }],
      hook: { text: "Gancho de teste", duration: 2 },
      audio: { normalize: true, cleanVoice: true, musicId: "mus", musicVolume: 0.2 },
    }), out, () => undefined);
    const probed = await probe(out);
    expect(probed.width).toBe(1080);
    expect(probed.height).toBe(1920);
    expect(probed.duration).toBeGreaterThan(result.duration - 0.15);
    expect(probed.duration).toBeLessThan(5.2);
    expect(result.cards).toBe(1);
    expect(result.media).toBe(1);
    expect(result.zooms).toBe(2);
    // o card cobre a legenda naquele trecho; a imagem de apoio aparece no fim
    const frame = join(dir, "quadro.png");
    await execFileAsync("ffmpeg", ["-y", "-loglevel", "error", "-ss", String(mapToOutput(4.9, keepSegments(silences, 6))), "-i", out, "-frames:v", "1", "-vf", "scale=1:1", "-f", "rawvideo", "-pix_fmt", "rgb24", frame]);
  }, 180000);

  it("exporta com fundo desfocado, 1:1 e original", async () => {
    for (const format of ["9:16-blur", "1:1", "original"] as const) {
      const out = join(dir, `saida-${format}.mp4`);
      await renderProject(project, base({ format, zooms: [{ start: 1, end: 3, scale: 1.1, ramp: true }] }), out, () => undefined);
      const probed = await probe(out);
      expect(probed.hasAudio).toBe(true);
      if (format === "1:1") expect([probed.width, probed.height]).toEqual([1080, 1080]);
      if (format === "original") expect([probed.width, probed.height]).toEqual([1280, 720]);
    }
  }, 240000);
});
