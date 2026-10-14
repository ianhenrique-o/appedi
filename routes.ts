import type { Express, Request, Response } from "express";
import express from "express";
import { createWriteStream } from "node:fs";
import { rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { z } from "zod";
import type { ProjectInfo, RenderRequest } from "../../shared/editor";
import { DEFAULT_AUDIO, DEFAULT_CAPTION_STYLE, DEFAULT_CARD, type MediaInfo } from "../../shared/editor";
import { audioEnvelope, execFileAsync, probe, runFfmpeg } from "./ffmpeg";
import { renderProject } from "./render";
import { DATA_DIR, ID_PATTERN, createProjectDir, getProject, jobs, projects, startCleanup, type Job, type Project } from "./store";
import { transcribe, transcriptionProvider } from "./transcribe";

const MAX_UPLOAD_MB = Number(process.env.CORTEFLOW_MAX_UPLOAD_MB || 2048);
const ENVELOPE_RATE = 50; // 20 ms por amostra

const range = z.object({ start: z.number().finite(), end: z.number().finite() });
const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const renderSchema = z.object({
  cuts: z.array(range).max(5000),
  zooms: z.array(range.extend({ scale: z.number().min(1).max(1.6), auto: z.boolean().optional(), ramp: z.boolean().optional() })).max(5000),
  format: z.enum(["9:16", "9:16-blur", "4:5", "1:1", "original"]),
  words: z.array(z.object({ text: z.string().max(80), start: z.number().finite(), end: z.number().finite(), emph: z.boolean().optional() })).max(60000),
  captions: z.object({
    enabled: z.boolean(),
    font: z.enum(["montserrat", "anton", "poppins"]),
    size: z.number().min(30).max(160),
    position: z.enum(["baixo", "meio", "cima"]),
    uppercase: z.boolean(),
    maxWords: z.number().int().min(1).max(8),
    textColor: hex,
    highlightColor: hex,
    emphasis: z.enum(["chave", "falada", "nenhuma"]),
    box: z.boolean(),
    boxColor: hex,
  }).default(DEFAULT_CAPTION_STYLE),
  hook: z.object({ text: z.string().max(160), duration: z.number().min(0.5).max(15) }).nullable(),
  inserts: z.array(range.extend({ id: z.string().max(80), kind: z.enum(["card", "media"]), text: z.string().max(200), mediaId: z.string().max(80).nullable().optional(), auto: z.boolean().optional() })).max(40).default([]),
  framing: z.array(z.object({ t: z.number().finite(), x: z.number().min(0).max(1), y: z.number().min(0).max(1) })).max(4000).default([]),
  card: z.object({ background: z.enum(["desfoque", "cor"]), color: hex, textColor: hex }).default(DEFAULT_CARD),
  audio: z.object({ normalize: z.boolean(), cleanVoice: z.boolean(), musicId: z.string().max(80).nullable(), musicVolume: z.number().min(0).max(1) }).default(DEFAULT_AUDIO),
  quality: z.enum(["rapida", "alta"]),
  fileName: z.string().max(120).optional(),
});

// Uma renderização por vez: evita derrubar a máquina com vários ffmpeg em paralelo.
let queue: Promise<unknown> = Promise.resolve();

function safeName(name: string) {
  return (name.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^\w.-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "") || "reel").slice(0, 80);
}

async function makeFilmstrip(project: Project) {
  const frames = Math.max(8, Math.min(40, Math.round(project.probe.duration / 1.5)));
  const frameHeight = 96;
  const frameWidth = Math.max(2, Math.round((frameHeight * (project.probe.width || 9)) / (project.probe.height || 16) / 2) * 2);
  const out = join(project.dir, "filmstrip.jpg");
  const rate = frames / Math.max(0.5, project.probe.duration);
  await execFileAsync("ffmpeg", [
    "-y", "-hide_banner", "-loglevel", "error", "-i", project.sourcePath,
    "-vf", `fps=${rate.toFixed(5)},scale=${frameWidth}:${frameHeight},tile=${frames}x1`,
    "-frames:v", "1", "-q:v", "5", out,
  ], { maxBuffer: 1024 * 1024 * 4, timeout: 120000 });
  return { url: `/api/projects/${project.id}/filmstrip.jpg`, frames, frameWidth, frameHeight };
}

function startTranscription(project: Project) {
  const provider = transcriptionProvider();
  if (!provider) {
    project.transcript = { status: "indisponivel", provider: null, words: [], message: "Configure OPENAI_API_KEY ou GROQ_API_KEY para ativar legendas e detecção de repetições." };
    return;
  }
  if (!project.probe.hasAudio) {
    project.transcript = { status: "indisponivel", provider: provider.name, words: [], message: "O vídeo não tem áudio." };
    return;
  }
  project.transcript = { status: "pendente", provider: provider.name, words: [] };
  transcribe(project.sourcePath, project.dir)
    .then(({ provider: name, words }) => {
      project.transcript = { status: "ok", provider: name, words };
    })
    .catch((error) => {
      console.warn("[CorteFlow] transcrição falhou", error);
      project.transcript = { status: "erro", provider: provider.name, words: [], message: error instanceof Error ? error.message : "Falha na transcrição." };
    });
}

function publicJob(job: Job) {
  const { outputPath: _o, srtPath: _s, touchedAt: _t, ...rest } = job;
  return rest;
}

export function registerEditorRoutes(app: Express) {
  startCleanup();

  app.get("/api/config", (_req, res) => {
    res.json({ transcription: transcriptionProvider()?.name ?? null, maxUploadMb: MAX_UPLOAD_MB });
  });

  app.post("/api/projects", async (req: Request, res: Response) => {
    const id = crypto.randomUUID();
    const rawName = decodeURIComponent(String(req.header("x-file-name") || "video.mp4"));
    const extension = rawName.match(/\.[a-z0-9]{2,5}$/i)?.[0]?.toLowerCase() ?? ".mp4";
    const declared = Number(req.header("content-length") || 0);
    if (declared > MAX_UPLOAD_MB * 1024 * 1024) return res.status(413).json({ error: `O arquivo passa de ${MAX_UPLOAD_MB} MB.` });
    const dir = await createProjectDir(id);
    const sourcePath = join(dir, `original${extension}`);
    try {
      await pipeline(req, createWriteStream(sourcePath));
      const size = (await stat(sourcePath)).size;
      if (!size) throw Object.assign(new Error("Nenhum vídeo foi enviado."), { status: 400 });
      const probed = await probe(sourcePath);
      if (!probed.hasVideo || !probed.duration) throw Object.assign(new Error("Esse arquivo não parece ser um vídeo válido."), { status: 400 });
      const project: Project = {
        id,
        name: rawName.replace(/\.[^.]+$/, ""),
        dir,
        sourcePath,
        probe: probed,
        info: null as unknown as ProjectInfo,
        transcript: { status: "pendente", provider: null, words: [] },
        media: new Map(),
        touchedAt: Date.now(),
      };
      startTranscription(project);
      const [envelope, filmstrip] = await Promise.all([
        probed.hasAudio ? audioEnvelope(sourcePath, ENVELOPE_RATE) : Promise.resolve([] as number[]),
        makeFilmstrip(project).catch((error) => { console.warn("[CorteFlow] filmstrip falhou", error); return null; }),
      ]);
      project.info = {
        id, name: project.name, duration: probed.duration, width: probed.width, height: probed.height, fps: probed.fps,
        hasAudio: probed.hasAudio, envelopeRate: ENVELOPE_RATE, envelope, filmstrip, media: [],
      };
      projects.set(id, project);
      res.json({ project: project.info, transcript: project.transcript });
    } catch (error) {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      const status = (error as { status?: number }).status ?? 500;
      console.error("[CorteFlow] upload/análise falhou", error);
      res.status(status).json({ error: status === 500 ? "Não foi possível ler esse vídeo." : (error as Error).message });
    }
  });

  app.get("/api/projects/:id", (req, res) => {
    const project = getProject(req.params.id);
    if (!project) return res.status(404).json({ error: "Projeto expirou. Importe o vídeo de novo." });
    res.json({ project: { ...project.info, media: [...project.media.values()].map((m) => m.info) }, transcript: project.transcript });
  });

  // Imagens, vídeos de apoio e música do projeto
  app.post("/api/projects/:id/media", async (req, res) => {
    const project = getProject(req.params.id);
    if (!project) return res.status(404).json({ error: "Projeto expirou. Importe o vídeo de novo." });
    if (project.media.size >= 40) return res.status(400).json({ error: "Limite de 40 arquivos por projeto." });
    const name = decodeURIComponent(String(req.header("x-file-name") || "arquivo"));
    const ext = name.match(/\.[a-z0-9]{2,5}$/i)?.[0]?.toLowerCase() ?? "";
    const id = crypto.randomUUID();
    const path = join(project.dir, `apoio-${id}${ext}`);
    try {
      await pipeline(req, createWriteStream(path));
      const probed = await probe(path).catch(() => null);
      const isImage = /\.(png|jpe?g|webp|gif|bmp|heic)$/i.test(ext) || (probed?.hasVideo && probed.duration <= 0.1);
      const type: MediaInfo["type"] | null = isImage ? "image" : probed?.hasVideo ? "video" : probed?.hasAudio ? "audio" : null;
      if (!type || !probed) throw Object.assign(new Error("Formato não reconhecido. Use JPG, PNG, MP4, MOV, MP3 ou WAV."), { status: 400 });
      const info: MediaInfo = { id, name, type, duration: type === "image" ? 0 : probed.duration, url: `/api/projects/${project.id}/media/${id}` };
      project.media.set(id, { info, path });
      res.json(info);
    } catch (error) {
      await rm(path, { force: true }).catch(() => undefined);
      const status = (error as { status?: number }).status ?? 500;
      res.status(status).json({ error: status === 500 ? "Não consegui ler esse arquivo." : (error as Error).message });
    }
  });

  app.get("/api/projects/:id/media/:mediaId", (req, res) => {
    const project = getProject(req.params.id);
    const item = project?.media.get(req.params.mediaId);
    if (!item) return res.status(404).end();
    res.sendFile(item.path);
  });

  app.get("/api/projects/:id/transcript", (req, res) => {
    const project = getProject(req.params.id);
    if (!project) return res.status(404).json({ error: "Projeto não encontrado." });
    res.json(project.transcript);
  });

  app.post("/api/projects/:id/transcribe", (req, res) => {
    const project = getProject(req.params.id);
    if (!project) return res.status(404).json({ error: "Projeto não encontrado." });
    if (project.transcript.status !== "pendente") startTranscription(project);
    res.json(project.transcript);
  });

  app.get("/api/projects/:id/filmstrip.jpg", (req, res) => {
    const project = getProject(req.params.id);
    if (!project) return res.status(404).end();
    res.set("Cache-Control", "private, max-age=3600").sendFile(join(project.dir, "filmstrip.jpg"));
  });

  // Prévia leve em H.264 para arquivos que o navegador não toca (ex.: HEVC do iPhone no Windows)
  app.get("/api/projects/:id/preview.mp4", async (req, res) => {
    const project = getProject(req.params.id);
    if (!project) return res.status(404).end();
    try {
      if (!project.previewPath) {
        project.previewPromise ??= (async () => {
          const out = join(project.dir, "previa.mp4");
          await runFfmpeg(["-y", "-i", project.sourcePath, "-vf", "scale=-2:720", "-c:v", "libx264", "-preset", "ultrafast", "-crf", "28", "-c:a", "aac", "-b:a", "96k", "-movflags", "+faststart", out]);
          project.previewPath = out;
          return out;
        })();
        await project.previewPromise;
      }
      res.sendFile(project.previewPath!);
    } catch (error) {
      project.previewPromise = undefined;
      console.error("[CorteFlow] prévia falhou", error);
      res.status(500).end();
    }
  });

  app.post("/api/projects/:id/render", express.json({ limit: "20mb" }), (req, res) => {
    const project = getProject(req.params.id);
    if (!project) return res.status(404).json({ error: "Projeto expirou. Importe o vídeo de novo." });
    const parsed = renderSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Configuração de exportação inválida.", details: parsed.error.issues.slice(0, 3) });
    const request = parsed.data as RenderRequest;
    const jobId = crypto.randomUUID();
    const fileName = `${safeName(request.fileName || project.name)}-corteflow.mp4`;
    const job: Job = { id: jobId, projectId: project.id, state: "fila", progress: 0, stage: "Na fila", fileName, touchedAt: Date.now() };
    jobs.set(jobId, job);
    queue = queue.then(async () => {
      job.state = "renderizando";
      job.stage = "Começando";
      const outputPath = join(project.dir, `export-${jobId}.mp4`);
      try {
        const result = await renderProject(project, request, outputPath, (progress, stage) => {
          job.progress = progress;
          job.stage = stage;
          job.touchedAt = Date.now();
        });
        job.outputPath = outputPath;
        job.srtPath = result.srtPath;
        job.srtUrl = `/api/jobs/${jobId}/legendas.srt`;
        job.outputDuration = result.duration;
        job.progress = 1;
        job.stage = "Pronto";
        job.state = "pronto";
        job.downloadUrl = `/api/jobs/${jobId}/download`;
      } catch (error) {
        console.error("[CorteFlow] render falhou", error);
        job.state = "erro";
        job.stage = "Erro";
        job.error = error instanceof Error ? error.message : "Falha desconhecida";
      }
    });
    res.json(publicJob(job));
  });

  app.get("/api/jobs/:id", (req, res) => {
    const job = ID_PATTERN.test(req.params.id) ? jobs.get(req.params.id) : undefined;
    if (!job) return res.status(404).json({ error: "Exportação não encontrada." });
    job.touchedAt = Date.now();
    res.json(publicJob(job));
  });

  app.get("/api/jobs/:id/download", (req, res) => {
    const job = ID_PATTERN.test(req.params.id) ? jobs.get(req.params.id) : undefined;
    if (!job?.outputPath) return res.status(404).json({ error: "Arquivo não encontrado." });
    if (req.query.inline) return res.type("video/mp4").sendFile(job.outputPath);
    res.download(job.outputPath, job.fileName ?? "reel-corteflow.mp4");
  });

  app.get("/api/jobs/:id/legendas.srt", (req, res) => {
    const job = ID_PATTERN.test(req.params.id) ? jobs.get(req.params.id) : undefined;
    if (!job?.srtPath) return res.status(404).json({ error: "Legenda não encontrada." });
    res.download(job.srtPath, (job.fileName ?? "reel.mp4").replace(/\.mp4$/, ".srt"));
  });

  console.log(`[CorteFlow] dados em ${DATA_DIR}; transcrição: ${transcriptionProvider()?.name ?? "desligada"}`);
}
