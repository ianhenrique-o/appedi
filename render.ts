import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Range, RenderRequest } from "../../shared/editor";
import {
  FORMAT_SIZE, clampRanges, faceInFrame, framingExpression, framingToOutput, insertsToOutput, keepSegments, totalLength, zoomExpression, zoomsToOutput,
} from "../../shared/editor";
import { buildAss, type OutputCard } from "./captions";
import { runFfmpeg } from "./ffmpeg";
import { fontsDir, type Project } from "./store";

type Piece = Range & { fadeIn: boolean; fadeOut: boolean };

const even = (n: number) => Math.max(2, Math.floor(n / 2) * 2);
const f = (n: number) => n.toFixed(3);

/** Mantido por compatibilidade: um trecho por segmento mantido. */
export function buildPieces(keep: Range[]): Piece[] {
  return keep.map((k) => ({ ...k, fadeIn: true, fadeOut: true }));
}

function escapeFilterPath(path: string) {
  return path.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "\\'");
}

export function outputSize(format: RenderRequest["format"], srcW: number, srcH: number) {
  if (format === "original") {
    const longSide = Math.max(srcW, srcH);
    const k = longSide > 1920 ? 1920 / longSide : 1;
    return { width: even(srcW * k), height: even(srcH * k) };
  }
  return FORMAT_SIZE[format];
}

const clamp01 = (n: number) => Math.min(0.95, Math.max(0.05, n));

export async function renderProject(
  project: Project,
  req: RenderRequest,
  outputPath: string,
  onProgress: (fraction: number, stage: string) => void,
  signal?: AbortSignal,
) {
  const { duration, hasAudio } = project.probe;
  const srcW = even(project.probe.width || 1080);
  const srcH = even(project.probe.height || 1920);
  const fps = Math.min(60, Math.max(24, Math.round(project.probe.fps || 30)));
  const cuts = clampRanges(req.cuts, duration);
  const keep = keepSegments(cuts, duration);
  if (!keep.length) throw new Error("Os cortes removeram o vídeo inteiro.");
  const outDuration = totalLength(keep);
  const pieces = buildPieces(keep);
  const { width: W, height: H } = outputSize(req.format, srcW, srcH);

  const framing = framingToOutput(req.framing ?? [], keep);
  const zooms = zoomsToOutput(req.zooms, keep);
  const media = project.media ?? new Map();
  const inserts = insertsToOutput(req.inserts ?? [], keep).filter((ins, i, all) => !all.slice(0, i).some((o) => ins.a < o.b && ins.b > o.a));
  const mediaInserts = inserts.filter((i) => i.kind === "media" && i.mediaId && media.get(i.mediaId) && media.get(i.mediaId)!.info.type !== "audio");
  const cards: OutputCard[] = inserts.filter((i) => !mediaInserts.includes(i)).map((i) => ({ a: i.a, b: i.b, text: i.text }));

  onProgress(0.01, "Preparando legendas");
  const ass = buildAss({ width: W, height: H, words: req.words, cuts, keep, style: req.captions, hook: req.hook, outputDuration: outDuration, cards, card: req.card });
  const stamp = Date.now();
  const assPath = join(project.dir, `legendas-${stamp}.ass`);
  await writeFile(assPath, ass.content, "utf8");
  const srtPath = outputPath.replace(/\.mp4$/, ".srt");
  await writeFile(srtPath, ass.srt, "utf8");

  const inputs: string[] = ["-i", project.sourcePath];
  const graph: string[] = [];
  const fade = 0.012;

  // 1) trechos mantidos
  pieces.forEach((p, i) => {
    const len = p.end - p.start;
    graph.push(`[0:v]trim=start=${f(p.start)}:end=${f(p.end)},setpts=PTS-STARTPTS,scale=${srcW}:${srcH},setsar=1,fps=${fps},format=yuv420p[v${i}]`);
    const fades = [p.fadeIn ? `afade=t=in:st=0:d=${fade}` : "", p.fadeOut && len > fade * 2 ? `afade=t=out:st=${f(len - fade)}:d=${fade}` : ""].filter(Boolean).join(",");
    if (hasAudio) graph.push(`[0:a]atrim=start=${f(p.start)}:end=${f(p.end)},asetpts=PTS-STARTPTS,aformat=sample_rates=48000:channel_layouts=stereo${fades ? `,${fades}` : ""}[a${i}]`);
    else graph.push(`aevalsrc=0|0:s=48000:d=${f(len)},aformat=sample_rates=48000:channel_layouts=stereo[a${i}]`);
  });
  graph.push(`${pieces.map((_, i) => `[v${i}][a${i}]`).join("")}concat=n=${pieces.length}:v=1:a=1[vc][ac]`);

  // 2) formato + enquadramento no rosto
  const fx = framingExpression(framing, "x", "t", 0.5);
  const fy = framingExpression(framing, "y", "t", 0.4);
  if (req.format === "9:16-blur") {
    graph.push(`[vc]split[bgsrc][fgsrc]`);
    graph.push(`[bgsrc]scale=${W / 4}:${H / 4}:force_original_aspect_ratio=increase,crop=${W / 4}:${H / 4},boxblur=14:3,eq=brightness=-0.06,scale=${W}:${H}[bg]`);
    graph.push(`[fgsrc]scale=${W}:${H}:force_original_aspect_ratio=decrease:flags=lanczos,setsar=1[fg]`);
    graph.push(`[bg][fg]overlay=(W-w)/2:(H-h)/2,setsar=1[vf]`);
  } else if (req.format === "original") {
    graph.push(`[vc]scale=${W}:${H}:flags=lanczos,setsar=1[vf]`);
  } else {
    graph.push(`[vc]scale=${W}:${H}:force_original_aspect_ratio=increase:flags=lanczos,crop=${W}:${H}:x='clip((${fx})*iw-ow/2,0,iw-ow)':y='clip((${fy})*ih-oh*0.4,0,ih-oh)',setsar=1[vf]`);
  }
  let last = "[vf]";

  // 3) zoom suave/punch-in, crescendo em volta do rosto
  if (zooms.length) {
    const faceKeys = (framing.length ? framing : [{ t: 0, x: 0.5, y: 0.4 }]).map((k) => {
      const p = faceInFrame(req.format, k, srcW, srcH, W, H);
      return { t: k.t, x: clamp01(p.x), y: clamp01(p.y) };
    });
    const px = framingExpression(faceKeys, "x", "it", 0.5);
    const py = framingExpression(faceKeys, "y", "it", 0.4);
    graph.push(`${last}zoompan=z='${zoomExpression(zooms, "it")}':x='(iw-iw/zoom)*(${px})':y='(ih-ih/zoom)*(${py})':d=1:s=${W}x${H}:fps=${fps},setsar=1[vz]`);
    last = "[vz]";
  }

  // 4) apoios: cards com fundo desfocado (ou cor) e imagens/vídeos do usuário
  if (cards.length) {
    const enable = cards.map((c) => `between(t,${f(c.a)},${f(c.b)})`).join("+");
    if (req.card?.background === "cor") {
      const color = (req.card.color || "#151515").replace("#", "0x");
      graph.push(`${last}drawbox=x=0:y=0:w=iw:h=ih:color=${color}@1:t=fill:enable='${enable}'[vcard]`);
    } else {
      graph.push(`${last}split[cmain][cbgsrc]`);
      graph.push(`[cbgsrc]scale=${W / 6}:${H / 6},boxblur=8:2,eq=brightness=-0.22:saturation=0.75,scale=${W}:${H}[cbg]`);
      graph.push(`[cmain][cbg]overlay=0:0:enable='${enable}'[vcard]`);
    }
    last = "[vcard]";
  }
  mediaInserts.forEach((ins, n) => {
    const m = media.get(ins.mediaId!)!;
    const dur = ins.b - ins.a;
    const idx = inputs.filter((x) => x === "-i").length;
    if (m.info.type === "image") {
      inputs.push("-loop", "1", "-framerate", String(fps), "-t", f(dur + 0.2), "-i", m.path);
      graph.push(`[${idx}:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},zoompan=z='1+0.06*on/${Math.max(1, Math.round(dur * fps))}':x='(iw-iw/zoom)/2':y='(ih-ih/zoom)/2':d=1:s=${W}x${H}:fps=${fps},setsar=1,format=yuv420p,setpts=PTS-STARTPTS+${f(ins.a)}/TB[m${n}]`);
    } else {
      inputs.push("-stream_loop", "-1", "-i", m.path);
      graph.push(`[${idx}:v]trim=duration=${f(dur + 0.2)},setpts=PTS-STARTPTS,fps=${fps},scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1,format=yuv420p,setpts=PTS+${f(ins.a)}/TB[m${n}]`);
    }
    graph.push(`${last}[m${n}]overlay=0:0:enable='between(t,${f(ins.a)},${f(ins.b)})':eof_action=pass[vm${n}]`);
    last = `[vm${n}]`;
  });

  // 5) legendas, cards e gancho
  const subs = ass.events > 0 ? `ass='${escapeFilterPath(assPath)}':fontsdir='${escapeFilterPath(fontsDir())}'` : "null";
  graph.push(`${last}setsar=1,${subs},format=yuv420p[vout]`);

  // 6) áudio: voz limpa, música com ducking, volume padrão do Instagram
  const audio = req.audio;
  const voiceChain = audio.cleanVoice
    ? "highpass=f=80,afftdn=nf=-25:nr=10,equalizer=f=3200:t=q:w=1:g=2,acompressor=threshold=0.1:ratio=3:attack=10:release=120:makeup=1.6"
    : "anull";
  graph.push(`[ac]${voiceChain}[voice]`);
  let mixOut = "[voice]";
  const music = audio.musicId ? media.get(audio.musicId) : undefined;
  if (music && (music.info.type === "audio" || music.info.type === "video")) {
    const idx = inputs.filter((x) => x === "-i").length;
    inputs.push("-stream_loop", "-1", "-i", music.path);
    const vol = Math.min(0.6, Math.max(0.02, audio.musicVolume));
    graph.push(`[${idx}:a]atrim=0:${f(outDuration)},asetpts=PTS-STARTPTS,aformat=sample_rates=48000:channel_layouts=stereo,volume=${vol.toFixed(3)},afade=t=in:d=0.8,afade=t=out:st=${f(Math.max(0, outDuration - 1.5))}:d=1.5[mus]`);
    graph.push(`[voice]asplit=2[vmain][vsc]`);
    graph.push(`[mus][vsc]sidechaincompress=threshold=0.02:ratio=10:attack=15:release=350[duck]`);
    graph.push(`[vmain][duck]amix=inputs=2:duration=first:normalize=0[mix]`);
    mixOut = "[mix]";
  }
  graph.push(audio.normalize ? `${mixOut}loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000[aout]` : `${mixOut}anull[aout]`);

  const graphPath = join(project.dir, `grafo-${stamp}.txt`);
  await writeFile(graphPath, graph.join(";\n"), "utf8");

  const quality = req.quality === "alta" ? ["-preset", "medium", "-crf", "18"] : ["-preset", "veryfast", "-crf", "21"];
  onProgress(0.02, "Renderizando");
  await runFfmpeg(
    [
      "-y", ...inputs,
      "-filter_complex_script", graphPath,
      "-map", "[vout]", "-map", "[aout]",
      "-c:v", "libx264", ...quality, "-profile:v", "high", "-pix_fmt", "yuv420p", "-r", String(fps),
      "-c:a", "aac", "-b:a", "192k", "-ar", "48000",
      "-movflags", "+faststart",
      "-t", f(outDuration),
      outputPath,
    ],
    (seconds) => onProgress(Math.min(0.99, 0.02 + (seconds / outDuration) * 0.97), "Renderizando"),
    signal,
  );
  return { duration: outDuration, pieces: pieces.length, captionEvents: ass.events, width: W, height: H, srtPath, cards: cards.length, media: mediaInserts.length, zooms: zooms.length };
}
