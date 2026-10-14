// Núcleo do CorteFlow compartilhado entre navegador e servidor.
// Tudo aqui é puro (sem I/O) para que a prévia no navegador e o render no
// servidor usem exatamente a mesma regra de corte, zoom e legenda.

export type Range = { start: number; end: number };
/** ramp = aproximação lenta e contínua; sem ramp = punch-in seco. */
export type ZoomRange = Range & { scale: number; auto?: boolean; ramp?: boolean };
/** emph: true/false força o destaque da palavra na legenda; undefined = automático. */
export type Word = { text: string; start: number; end: number; emph?: boolean };
/** Centro do rosto (0 a 1) num instante do vídeo original. */
export type FramingKey = { t: number; x: number; y: number };
/** Momento de apoio visual (card com frase ou imagem/vídeo do usuário), no tempo do original. */
export type Insert = Range & { id: string; kind: "card" | "media"; text: string; mediaId?: string | null; auto?: boolean };
export type MediaInfo = { id: string; name: string; type: "image" | "video" | "audio"; duration: number; url: string };

export type SuggestionKind = "silence" | "repeat" | "retake" | "filler" | "backstage";
export type Suggestion = Range & {
  id: string;
  kind: SuggestionKind;
  label: string;
  detail: string;
  confidence: number;
};

export type VideoFormat = "9:16" | "9:16-blur" | "4:5" | "1:1" | "original";

export type CaptionFont = "montserrat" | "anton" | "poppins";
export type CaptionPosition = "baixo" | "meio" | "cima";
export type CaptionStyle = {
  enabled: boolean;
  font: CaptionFont;
  size: number; // px numa largura de 1080
  position: CaptionPosition;
  uppercase: boolean;
  maxWords: number;
  textColor: string; // #RRGGBB
  highlightColor: string; // #RRGGBB
  emphasis: "chave" | "falada" | "nenhuma"; // palavras-chave, palavra falada (karaokê) ou nada
  box: boolean; // caixa atrás do texto
  boxColor: string;
};

export type HookText = { text: string; duration: number };

export type CardStyle = { background: "desfoque" | "cor"; color: string; textColor: string };
export type AudioOptions = { normalize: boolean; cleanVoice: boolean; musicId: string | null; musicVolume: number };

export type RenderRequest = {
  cuts: Range[];
  zooms: ZoomRange[];
  format: VideoFormat;
  words: Word[];
  captions: CaptionStyle;
  hook: HookText | null;
  inserts: Insert[];
  framing: FramingKey[];
  card: CardStyle;
  audio: AudioOptions;
  quality: "rapida" | "alta";
  fileName?: string;
};

export type ProjectInfo = {
  id: string;
  name: string;
  duration: number;
  width: number;
  height: number;
  fps: number;
  hasAudio: boolean;
  envelopeRate: number; // amostras por segundo do envelope
  envelope: number[]; // dBFS por janela
  filmstrip: { url: string; frames: number; frameWidth: number; frameHeight: number } | null;
  media: MediaInfo[];
};

export type TranscriptState = {
  status: "pendente" | "ok" | "indisponivel" | "erro";
  provider: string | null;
  words: Word[];
  message?: string;
};

export type JobState = {
  id: string;
  projectId: string;
  state: "fila" | "renderizando" | "pronto" | "erro";
  progress: number;
  stage: string;
  error?: string;
  outputDuration?: number;
  downloadUrl?: string;
  srtUrl?: string;
  fileName?: string;
};

export const FORMAT_SIZE: Record<Exclude<VideoFormat, "original">, { width: number; height: number }> = {
  "9:16": { width: 1080, height: 1920 },
  "9:16-blur": { width: 1080, height: 1920 },
  "4:5": { width: 1080, height: 1350 },
  "1:1": { width: 1080, height: 1080 },
};

// Padrão editorial: limpo, sem serifa forte, uma cor de destaque só nas palavras que importam.
export const DEFAULT_CAPTION_STYLE: CaptionStyle = {
  enabled: true,
  font: "montserrat",
  size: 78,
  position: "baixo",
  uppercase: false,
  maxWords: 5,
  textColor: "#FFFFFF",
  highlightColor: "#FFD43B",
  emphasis: "chave",
  box: false,
  boxColor: "#000000",
};

export const DEFAULT_CARD: CardStyle = { background: "desfoque", color: "#151515", textColor: "#FFFFFF" };
export const DEFAULT_AUDIO: AudioOptions = { normalize: true, cleanVoice: true, musicId: null, musicVolume: 0.18 };

// ---------------------------------------------------------------------------
// Intervalos
// ---------------------------------------------------------------------------

export function mergeRanges<T extends Range>(ranges: T[], gap = 0): Range[] {
  const sorted = ranges
    .filter((r) => Number.isFinite(r.start) && Number.isFinite(r.end) && r.end > r.start)
    .map((r) => ({ start: r.start, end: r.end }))
    .sort((a, b) => a.start - b.start);
  const out: Range[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.start <= last.end + gap) last.end = Math.max(last.end, r.end);
    else out.push({ ...r });
  }
  return out;
}

export function clampRanges(ranges: Range[], duration: number): Range[] {
  return mergeRanges(
    ranges.map((r) => ({ start: Math.max(0, r.start), end: Math.min(duration, r.end) })),
  ).filter((r) => r.end - r.start >= 0.02);
}

/** Trechos que ficam no vídeo depois dos cortes (linha do tempo original). */
export function keepSegments(cuts: Range[], duration: number, minLength = 0.05): Range[] {
  const merged = clampRanges(cuts, duration);
  const keep: Range[] = [];
  let cursor = 0;
  for (const cut of merged) {
    if (cut.start - cursor >= minLength) keep.push({ start: cursor, end: cut.start });
    cursor = Math.max(cursor, cut.end);
  }
  if (duration - cursor >= minLength) keep.push({ start: cursor, end: duration });
  return keep;
}

export function totalLength(ranges: Range[]) {
  return ranges.reduce((sum, r) => sum + (r.end - r.start), 0);
}

/** Converte um tempo do vídeo original para o tempo do vídeo exportado. null = caiu num corte. */
export function mapToOutput(t: number, keep: Range[]): number | null {
  let offset = 0;
  for (const seg of keep) {
    if (t < seg.start) return null;
    if (t <= seg.end) return offset + (t - seg.start);
    offset += seg.end - seg.start;
  }
  return null;
}

/** Converte tempo do vídeo exportado para tempo do original. */
export function mapToSource(t: number, keep: Range[]): number {
  let offset = 0;
  for (const seg of keep) {
    const len = seg.end - seg.start;
    if (t <= offset + len) return seg.start + (t - offset);
    offset += len;
  }
  const last = keep[keep.length - 1];
  return last ? last.end : 0;
}

/** Tempo de saída da agulha; se ela está parada dentro de um corte, conta a partir do fim do corte. */
export function outputTimeAt(t: number, cuts: Range[], keep: Range[]): number {
  const cut = inRanges(t, cuts);
  const mapped = mapToOutput(cut ? cut.end : t, keep);
  if (mapped !== null) return mapped;
  const last = keep[keep.length - 1];
  if (last && t >= last.end) return totalLength(keep);
  const next = keep.find((s) => s.start >= t);
  return next ? mapToOutput(next.start, keep) ?? 0 : 0;
}

export function inRanges(t: number, ranges: Range[]): Range | null {
  for (const r of ranges) if (t >= r.start && t < r.end) return r;
  return null;
}

// ---------------------------------------------------------------------------
// Pausas a partir do envelope de áudio
// ---------------------------------------------------------------------------

export type SilenceOptions = { thresholdDb: number; minPause: number; padding: number };
export const DEFAULT_SILENCE: SilenceOptions = { thresholdDb: -38, minPause: 0.45, padding: 0.12 };

export function detectSilences(envelope: number[], rate: number, duration: number, opts: SilenceOptions): Suggestion[] {
  const raw: Range[] = [];
  let startIdx = -1;
  for (let i = 0; i <= envelope.length; i++) {
    const quiet = i < envelope.length && envelope[i] < opts.thresholdDb;
    if (quiet && startIdx < 0) startIdx = i;
    if (!quiet && startIdx >= 0) {
      raw.push({ start: startIdx / rate, end: Math.min(duration, i / rate) });
      startIdx = -1;
    }
  }
  const out: Suggestion[] = [];
  for (const r of raw) {
    if (r.end - r.start < opts.minPause) continue;
    const atStart = r.start <= 0.01;
    const atEnd = r.end >= duration - 0.01;
    const start = atStart ? 0 : r.start + opts.padding;
    const end = atEnd ? duration : r.end - opts.padding;
    if (end - start < 0.15) continue;
    const len = r.end - r.start;
    out.push({
      id: `pausa-${start.toFixed(2)}`,
      kind: "silence",
      start,
      end,
      label: atStart ? "Silêncio no início" : atEnd ? "Silêncio no final" : "Pausa",
      detail: `${len.toFixed(1)}s sem fala`,
      confidence: Math.min(99, Math.round(70 + len * 18)),
    });
  }
  return out;
}

/**
 * Com a transcrição em mãos, deixa os cortes de pausa mais precisos:
 * nunca encosta na palavra (protege começo e fim) e dá um respiro um pouco maior
 * depois de frase concluída, para a fala não ficar robótica.
 */
export function refineSilences(silences: Suggestion[], words: Word[]): Suggestion[] {
  if (!words.length) return silences;
  const out: Suggestion[] = [];
  for (const s of silences) {
    let start = s.start;
    let end = s.end;
    let prev: Word | undefined;
    let next: Word | undefined;
    for (const w of words) {
      if (w.end <= s.start + 0.25) prev = w;
      else if (w.start >= s.end - 0.25) { next = w; break; }
    }
    if (prev && start > 0) {
      start = Math.max(start, prev.end + 0.06);
      if (endsSentence(prev.text)) start += 0.08;
    }
    if (next && end < (s.end + 1)) end = Math.min(end, next.start - 0.05);
    // palavra dentro do "silêncio" (fala baixa): não corta por cima dela
    const inside = words.find((w) => (w.start + w.end) / 2 > start && (w.start + w.end) / 2 < end);
    if (inside) {
      if (inside.start - start >= 0.25) end = inside.start - 0.05;
      else continue;
    }
    if (end - start >= 0.15) out.push({ ...s, start, end });
  }
  return out;
}

/**
 * Evita a sequência nervosa de microcortes: se sobrar um pedacinho sem fala
 * entre dois cortes, os dois viram um só. Cortes minúsculos são descartados.
 */
export function cleanCuts(cuts: Range[], words: Word[], minKeep = 0.3): Range[] {
  const merged = mergeRanges(cuts);
  const out: Range[] = [];
  for (const c of merged) {
    const last = out[out.length - 1];
    if (last && c.start - last.end < minKeep) {
      const speech = words.some((w) => { const m = (w.start + w.end) / 2; return m > last.end && m < c.start; });
      if (!speech) { last.end = Math.max(last.end, c.end); continue; }
    }
    out.push({ ...c });
  }
  return out.filter((c) => c.end - c.start >= 0.06);
}

// ---------------------------------------------------------------------------
// Repetições, regravações e vícios a partir da transcrição
// ---------------------------------------------------------------------------

export function normalizeWord(text: string) {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]/g, "");
}

const BACKSTAGE = ["corta", "corta isso", "de novo", "vou de novo", "vou repetir", "deixa eu repetir", "deixa eu comecar", "comecar de novo", "pera", "perai", "peraí", "errei", "esquece", "ta gravando", "ja ta gravando", "nao nao nao"];

const FILLERS = new Set(["ahn", "an", "ah", "eh", "ee", "eee", "hum", "hmm", "hm", "uh", "uhm", "um", "mm", "aham"]);

function endsSentence(text: string) {
  return /[.!?…]["”')\]]*$/.test(text.trim());
}

export function sentences(words: Word[], gap = 0.8): number[][] {
  const out: number[][] = [];
  let current: number[] = [];
  words.forEach((w, i) => {
    const prev = words[i - 1];
    if (current.length && prev && w.start - prev.end > gap) {
      out.push(current);
      current = [];
    }
    current.push(i);
    if (endsSentence(w.text)) {
      out.push(current);
      current = [];
    }
  });
  if (current.length) out.push(current);
  return out;
}

function quote(words: Word[], from: number, to: number) {
  const text = words.slice(from, to).map((w) => w.text).join(" ");
  return text.length > 48 ? `${text.slice(0, 46)}…` : text;
}

export function detectSpeechIssues(words: Word[]): Suggestion[] {
  if (!words.length) return [];
  const norm = words.map((w) => normalizeWord(w.text));
  const out: Suggestion[] = [];
  const taken: Range[] = [];
  const overlaps = (r: Range) => taken.some((t) => r.start < t.end && r.end > t.start);
  const push = (s: Suggestion) => {
    if (s.end - s.start < 0.08 || overlaps(s)) return;
    taken.push(s);
    out.push(s);
  };

  const sents = sentences(words);

  // 0) Bastidor: frase curta com "corta", "de novo", "errei", "pera"...
  for (const sent of sents) {
    if (sent.length > 8) continue;
    const text = ` ${sent.map((i) => norm[i]).join(" ")} `;
    if (BACKSTAGE.some((m) => text.includes(` ${m} `))) {
      const first = words[sent[0]];
      const last = words[sent[sent.length - 1]];
      const next = words[sent[sent.length - 1] + 1];
      push({
        id: `bastidor-${first.start.toFixed(2)}`,
        kind: "backstage",
        start: first.start,
        end: next ? Math.min(next.start, last.end + 0.3) : last.end + 0.1,
        label: "Comentário de bastidor",
        detail: `“${quote(words, sent[0], sent[sent.length - 1] + 1)}”`,
        confidence: 78,
      });
    }
  }

  // 1) Regravação: a frase recomeça igual logo depois (o clássico "deixa eu falar de novo").
  //    A tentativa abandonada pode ter lixo antes ("Ahn, a maioria...") e terminar no meio.
  for (let k = 0; k < sents.length; k++) {
    const a = sents[k];
    let matched = false;
    for (let m = k + 1; m < Math.min(sents.length, k + 4) && !matched; m++) {
      const b = sents[m];
      if (words[b[0]].start - words[a[a.length - 1]].end > 20) break;
      const n = Math.min(4, b.length);
      if (n < 3) continue;
      for (let p = 0; p + n <= a.length && p <= 3; p++) {
        let same = true;
        for (let i = 0; i < n; i++) if (!norm[a[p + i]] || norm[a[p + i]] !== norm[b[i]]) { same = false; break; }
        if (!same) continue;
        // tudo entre o começo da primeira tentativa e a última vai embora
        const firstIdx = a[p];
        push({
          id: `regravacao-${words[firstIdx].start.toFixed(2)}`,
          kind: "retake",
          start: words[firstIdx].start,
          end: words[b[0]].start,
          label: "Regravação",
          detail: `Você recomeçou “${quote(words, b[0], b[0] + n)}”. Fica a última versão.`,
          confidence: 84,
        });
        matched = true;
        break;
      }
    }
  }

  // 2) Repetição de palavras ou trechos curtos ("eu eu", "e aí e aí").
  for (let i = 0; i < words.length; i++) {
    for (let n = 5; n >= 1; n--) {
      if (i + n * 2 > words.length) continue;
      let found = -1;
      for (let skip = 0; skip <= (n === 1 ? 0 : 2); skip++) {
        const j = i + n + skip;
        if (j + n > words.length) break;
        let same = true;
        for (let x = 0; x < n; x++) if (!norm[i + x] || norm[i + x] !== norm[j + x]) same = false;
        if (same) { found = j; break; }
      }
      if (found < 0) continue;
      // palavra única repetida só conta se estiver colada ("o o", "que que")
      const gap = words[found].start - words[i].end;
      if (n === 1 && (gap > 0.6 || (norm[i].length < 2 && gap > 0.3))) continue;
      push({
        id: `repeticao-${words[i].start.toFixed(2)}`,
        kind: "repeat",
        start: words[i].start,
        end: words[found].start,
        label: n === 1 ? "Palavra repetida" : "Trecho repetido",
        detail: `“${quote(words, i, i + n)}” aparece duas vezes seguidas.`,
        confidence: n >= 2 ? 88 : 76,
      });
      i += n - 1;
      break;
    }
  }

  // 3) Vícios de fala ("ahn", "hum", "éé").
  words.forEach((w, i) => {
    const t = norm[i];
    // "é"/"e" são palavras de verdade; só vira vício quando é arrastado ("éééé")
    const dragged = t === "e" && (/^[ée]{2,}/i.test(w.text.trim()) || w.end - w.start > 0.6);
    if (FILLERS.has(t) || dragged) {
      push({
        id: `vicio-${w.start.toFixed(2)}`,
        kind: "filler",
        start: w.start,
        end: Math.min(w.end + 0.05, words[i + 1]?.start ?? w.end + 0.05),
        label: "Vício de fala",
        detail: `“${w.text}” solto no meio da fala.`,
        confidence: 80,
      });
    }
  });

  return out.sort((a, b) => a.start - b.start);
}

// ---------------------------------------------------------------------------
// Palavras-chave (ênfase na legenda, zoom e cards)
// ---------------------------------------------------------------------------

const NUMBER_WORDS = new Set(["dois", "duas", "tres", "quatro", "cinco", "seis", "sete", "oito", "nove", "dez", "onze", "doze", "quinze", "vinte", "trinta", "quarenta", "cinquenta", "cem", "cento", "mil", "milhao", "milhoes", "primeiro", "primeira", "metade", "dobro", "triplo", "zero"]);
const KEY_WORDS = new Set([
  "nunca", "sempre", "nada", "tudo", "ninguem", "todos", "todas", "jamais", "unico", "unica",
  "erro", "erros", "errado", "errada", "segredo", "importante", "atencao", "cuidado", "perigo", "perigoso", "risco", "alerta",
  "sinal", "sinais", "problema", "problemas", "resultado", "resultados", "rapido", "facil", "gratis", "melhor", "pior", "principal",
  "verdade", "medo", "amor", "culpa", "urgente", "grave", "normal", "atraso", "ajuda", "simples", "diferenca", "essencial",
  "fundamental", "chave", "dica", "dicas", "metodo", "passo", "passos", "regra", "mito", "mentira", "certo", "errou",
  "proibido", "obrigatorio", "maior", "menor", "rapidamente", "salva", "salve", "compartilha", "comenta",
  "transforma", "muda", "mudar", "funciona", "evitar", "evite", "pare", "dinheiro",
]);
// "não" só vale como ênfase quando é a última palavra ("isso não!"), senão aparece em toda frase
const WEAK = new Set(["a", "o", "as", "os", "um", "uma", "uns", "umas", "de", "da", "do", "das", "dos", "e", "que", "em", "no", "na", "nos", "nas", "pra", "pro", "para", "por", "com", "se", "ao", "aos", "mas", "ou", "meu", "minha", "seu", "sua", "te", "me", "lhe", "eu", "ele", "ela", "isso", "esse", "essa", "este", "esta", "num", "numa", "pelo", "pela"]);

export function isKeyword(text: string, isLastOfSentence = false) {
  const n = normalizeWord(text);
  if (!n) return false;
  if (/\d/.test(n)) return true;
  if (NUMBER_WORDS.has(n)) return true;
  if (n === "nao") return isLastOfSentence;
  return KEY_WORDS.has(n);
}

/** Palavras destacadas: no máximo uma por bloco de legenda, respeitando o que o usuário marcou à mão. */
export function emphasisFlags(words: Word[]): boolean[] {
  return words.map((w, i) => (w.emph !== undefined ? w.emph : isKeyword(w.text, endsSentence(w.text) || !words[i + 1])));
}

// ---------------------------------------------------------------------------
// Zoom editorial: sutil, motivado pelo conteúdo, nunca em todos os cortes.
//  - abertura: aproximação lenta para criar a primeira mudança visual
//  - frase com número ou palavra-chave: punch-in discreto
//  - corte no meio da frase (vício, repetição): punch-in leve para esconder o pulo
//  - muito tempo sem nada mudar: aproximação lenta para recuperar energia
//  - conclusão: enquadramento um pouco mais fechado até o fim
// ---------------------------------------------------------------------------

type SentenceSpan = Range & { idx: number[]; key: boolean; outStart: number; outEnd: number };

function keptSentences(words: Word[], keep: Range[]): SentenceSpan[] {
  const out: SentenceSpan[] = [];
  for (const sent of sentences(words)) {
    const kept = sent.filter((i) => mapToOutput((words[i].start + words[i].end) / 2, keep) !== null);
    if (!kept.length) continue;
    const first = words[kept[0]];
    const last = words[kept[kept.length - 1]];
    const outStart = outputTimeAt(first.start, keepGaps(keep), keep);
    const outEnd = outputTimeAt(last.end, keepGaps(keep), keep);
    out.push({ start: first.start, end: last.end, idx: kept, key: kept.some((i) => isKeyword(words[i].text, i === kept[kept.length - 1])), outStart, outEnd });
  }
  return out;
}

/** Os cortes implícitos entre trechos mantidos. */
export function keepGaps(keep: Range[]): Range[] {
  const gaps: Range[] = [];
  for (let i = 0; i < keep.length - 1; i++) gaps.push({ start: keep[i].end, end: keep[i + 1].start });
  if (keep[0] && keep[0].start > 0) gaps.unshift({ start: 0, end: keep[0].start });
  return gaps;
}

function segmentOf(t: number, keep: Range[]) {
  return keep.find((s) => t >= s.start && t <= s.end) ?? null;
}

export function autoZooms(keep: Range[], words: Word[], intensity = 1.08): ZoomRange[] {
  const scale = Math.min(1.15, Math.max(1.02, intensity));
  const subtle = 1 + (scale - 1) * 0.55;
  const total = totalLength(keep);
  if (!keep.length || total < 3) return [];
  const out: ZoomRange[] = [];
  const add = (z: ZoomRange) => {
    if (z.end - z.start < 0.6) return;
    if (out.some((o) => z.start < o.end && z.end > o.start)) return;
    out.push(z);
  };

  // Sem transcrição: só abertura e uma aproximação a cada ~8s, sempre terminando num corte
  if (!words.length) {
    let lastOut = -99;
    let offset = 0;
    keep.forEach((seg, i) => {
      const len = seg.end - seg.start;
      if (i === 0 || offset - lastOut > 8) {
        add({ start: seg.start, end: Math.min(seg.end, seg.start + 7), scale, ramp: true, auto: true });
        lastOut = offset;
      }
      offset += len;
    });
    return out;
  }

  const spans = keptSentences(words, keep);
  if (!spans.length) return [];
  const capZoomed = total * 0.45;
  let zoomed = 0;
  let lastEventOut = -99;
  let prevZoomedSentence = -2;

  const rangeUntilCutOrSentence = (span: SentenceSpan, maxLen: number) => {
    const seg = segmentOf(span.start, keep);
    const segEnd = seg ? seg.end : span.end;
    return { start: span.start, end: Math.min(segEnd, Math.max(span.end, span.start + 1.2), span.start + maxLen) };
  };

  spans.forEach((span, k) => {
    const isFirst = k === 0;
    const isLast = k === spans.length - 1;
    const sinceLast = span.outStart - lastEventOut;
    let z: ZoomRange | null = null;
    if (isFirst) {
      const r = rangeUntilCutOrSentence(span, 7);
      z = { ...r, scale, ramp: true, auto: true };
    } else if (isLast && spans.length > 2) {
      const seg = segmentOf(span.start, keep);
      z = { start: span.start, end: keep[keep.length - 1].end, scale, ramp: Boolean(seg && seg.end - span.start > 2.5), auto: true };
    } else if (span.key && sinceLast > 3 && prevZoomedSentence !== k - 1) {
      z = { start: span.start, end: span.end, scale, auto: true };
    } else if (sinceLast > 7 && prevZoomedSentence !== k - 1) {
      const r = rangeUntilCutOrSentence(span, 6);
      z = { ...r, scale, ramp: true, auto: true };
    }
    if (z && zoomed + (z.end - z.start) <= capZoomed + (isLast ? 99 : 0)) {
      const before = out.length;
      add(z);
      if (out.length > before) {
        zoomed += z.end - z.start;
        lastEventOut = span.outStart;
        prevZoomedSentence = k;
        return;
      }
    }
    // corte no meio da frase: punch-in leve no trecho depois do corte
    for (let i = 0; i < keep.length - 1; i++) {
      const cutAt = keep[i].end;
      const resume = keep[i + 1].start;
      if (cutAt > span.start && resume < span.end) {
        const r = { start: resume, end: Math.min(span.end, keep[i + 1].end) };
        const before = out.length;
        add({ ...r, scale: subtle, auto: true });
        if (out.length > before) { zoomed += r.end - r.start; lastEventOut = span.outStart; }
      }
    }
  });
  return out.sort((a, b) => a.start - b.start);
}

export type OutputZoom = { a: number; b: number; scale: number; ramp: boolean };

/** Leva os zooms para o tempo do vídeo final (é nele que o zoom é desenhado). */
export function zoomsToOutput(zooms: ZoomRange[], keep: Range[]): OutputZoom[] {
  const gaps = keepGaps(keep);
  const out: OutputZoom[] = [];
  for (const z of zooms) {
    const a = outputTimeAt(z.start, gaps, keep);
    const endIn = inRanges(z.end - 0.001, gaps);
    const b = endIn ? outputTimeAt(endIn.start - 0.001, gaps, keep) : outputTimeAt(z.end, gaps, keep);
    if (b - a > 0.2) out.push({ a, b, scale: z.scale, ramp: Boolean(z.ramp) });
  }
  return out.sort((x, y) => x.a - y.a);
}

const RAMP_SECONDS = 4;
export function zoomAtOutput(t: number, zooms: OutputZoom[]) {
  for (const z of zooms) {
    if (t >= z.a && t < z.b) {
      if (!z.ramp) return z.scale;
      const p = Math.min(1, (t - z.a) / Math.min(RAMP_SECONDS, z.b - z.a));
      const ease = p * p * (3 - 2 * p);
      return 1 + (z.scale - 1) * ease;
    }
  }
  return 1;
}

/** Mesmo cálculo como expressão do FFmpeg (variável de tempo `v`). */
export function zoomExpression(zooms: OutputZoom[], v: string) {
  let expr = "1";
  for (const z of [...zooms].reverse()) {
    const d = Math.min(RAMP_SECONDS, z.b - z.a);
    const p = `min(1,(${v}-${z.a.toFixed(3)})/${d.toFixed(3)})`;
    const value = z.ramp ? `(1+${(z.scale - 1).toFixed(4)}*${p}*${p}*(3-2*${p}))` : z.scale.toFixed(4);
    expr = `if(between(${v},${z.a.toFixed(3)},${(z.b - 0.001).toFixed(3)}),${value},${expr})`;
  }
  return expr;
}

// ---------------------------------------------------------------------------
// Enquadramento que acompanha o rosto
// ---------------------------------------------------------------------------

/** Transforma detecções cruas (com falhas) numa câmera calma: só se move quando o rosto sai do lugar. */
export function smoothFraming(raw: Array<{ t: number; x: number; y: number } | { t: number; x: null; y: null }>, opts = { threshold: 0.07, transition: 0.6 }): FramingKey[] {
  const found = raw.filter((r): r is FramingKey => r.x !== null && r.y !== null);
  if (!found.length) return [];
  // mediana móvel para tirar tremidas
  const med = (arr: number[]) => [...arr].sort((a, b) => a - b)[Math.floor(arr.length / 2)];
  const smooth = found.map((p, i) => {
    const win = found.slice(Math.max(0, i - 2), i + 3);
    return { t: p.t, x: med(win.map((w) => w.x)), y: med(win.map((w) => w.y)) };
  });
  const keys: FramingKey[] = [{ ...smooth[0], t: 0 }];
  let hold = smooth[0];
  for (const p of smooth.slice(1)) {
    if (Math.abs(p.x - hold.x) > opts.threshold || Math.abs(p.y - hold.y) > opts.threshold * 1.5) {
      keys.push({ t: Math.max(keys[keys.length - 1].t, p.t - opts.transition), x: hold.x, y: hold.y });
      keys.push({ t: p.t, x: p.x, y: p.y });
      hold = p;
    }
  }
  return keys.map((k) => ({ t: Math.round(k.t * 100) / 100, x: Math.round(k.x * 1000) / 1000, y: Math.round(k.y * 1000) / 1000 }));
}

/** Onde o rosto cai dentro do quadro final, para o zoom crescer em volta dele. */
export function faceInFrame(format: VideoFormat, key: FramingKey, srcW: number, srcH: number, W: number, H: number): FramingKey {
  if (format === "9:16" || format === "4:5" || format === "1:1") {
    const s = Math.max(W / srcW, H / srcH);
    const sw = srcW * s, sh = srcH * s;
    const cropX = Math.min(Math.max(key.x * sw - W / 2, 0), sw - W);
    const cropY = Math.min(Math.max(key.y * sh - H * 0.4, 0), sh - H);
    return { t: key.t, x: (key.x * sw - cropX) / W, y: (key.y * sh - cropY) / H };
  }
  if (format === "9:16-blur") {
    const s = Math.min(W / srcW, H / srcH);
    const fw = srcW * s, fh = srcH * s;
    return { t: key.t, x: ((W - fw) / 2 + key.x * fw) / W, y: ((H - fh) / 2 + key.y * fh) / H };
  }
  return key;
}

export function framingAt(t: number, keys: FramingKey[]): { x: number; y: number } {
  if (!keys.length) return { x: 0.5, y: 0.4 };
  if (t <= keys[0].t) return keys[0];
  for (let i = 0; i < keys.length - 1; i++) {
    const a = keys[i], b = keys[i + 1];
    if (t >= a.t && t <= b.t) {
      const p = b.t > a.t ? (t - a.t) / (b.t - a.t) : 1;
      return { x: a.x + (b.x - a.x) * p, y: a.y + (b.y - a.y) * p };
    }
  }
  return keys[keys.length - 1];
}

/** Leva as chaves para o tempo de saída (o que cai em corte some). */
export function framingToOutput(keys: FramingKey[], keep: Range[]): FramingKey[] {
  const out: FramingKey[] = [];
  for (const seg of keep) {
    const startOut = mapToOutput(seg.start, keep);
    if (startOut === null) continue;
    const at = framingAt(seg.start, keys);
    out.push({ t: startOut, x: at.x, y: at.y });
    for (const k of keys) if (k.t > seg.start && k.t < seg.end) out.push({ t: mapToOutput(k.t, keep)!, x: k.x, y: k.y });
    const endAt = framingAt(seg.end, keys);
    out.push({ t: mapToOutput(seg.end, keep)! - 0.001, x: endAt.x, y: endAt.y });
  }
  // remove chaves redundantes (mesmo valor em sequência)
  return out.filter((k, i) => i === 0 || i === out.length - 1 || !(Math.abs(k.x - out[i - 1].x) < 1e-3 && Math.abs(k.y - out[i - 1].y) < 1e-3 && Math.abs(k.x - out[i + 1].x) < 1e-3 && Math.abs(k.y - out[i + 1].y) < 1e-3));
}

export function framingExpression(keys: FramingKey[], axis: "x" | "y", v: string, fallback: number) {
  if (!keys.length) return String(fallback);
  let expr = keys[keys.length - 1][axis].toFixed(4);
  for (let i = keys.length - 2; i >= 0; i--) {
    const a = keys[i], b = keys[i + 1];
    const span = Math.max(0.001, b.t - a.t);
    const lerp = Math.abs(b[axis] - a[axis]) < 1e-4 ? a[axis].toFixed(4) : `(${a[axis].toFixed(4)}+${(b[axis] - a[axis]).toFixed(4)}*(${v}-${a.t.toFixed(3)})/${span.toFixed(3)})`;
    expr = `if(lt(${v},${b.t.toFixed(3)}),${lerp},${expr})`;
  }
  return expr;
}

// ---------------------------------------------------------------------------
// Apoios visuais: 3 momentos, um em cada terço, sobre frases com peso
// ---------------------------------------------------------------------------

export function insertsToOutput(inserts: Insert[], keep: Range[]) {
  const gaps = keepGaps(keep);
  return inserts
    .map((ins) => {
      const a = outputTimeAt(ins.start, gaps, keep);
      const endIn = inRanges(ins.end - 0.001, gaps);
      const b = endIn ? outputTimeAt(endIn.start - 0.001, gaps, keep) : outputTimeAt(ins.end, gaps, keep);
      return { ...ins, a, b };
    })
    .filter((x) => x.b - x.a >= 0.4)
    .sort((x, y) => x.a - y.a);
}

export function autoInserts(keep: Range[], words: Word[]): Insert[] {
  const total = totalLength(keep);
  if (!words.length || total < 9) return [];
  const spans = keptSentences(words, keep);
  const chosen: Insert[] = [];
  for (let third = 0; third < 3; third++) {
    const from = (total * third) / 3;
    const to = (total * (third + 1)) / 3;
    const candidates = spans.filter((s) => s.outStart >= Math.max(from, 1.5) && s.outStart < Math.min(to, total - 2.5) && s.outEnd - s.outStart >= 1.0);
    if (!candidates.length) continue;
    // frase curta e com peso vira card; frase longa demais não cabe na leitura rápida
    const score = (s: SentenceSpan) =>
      (s.key ? 3 : 0) + (s.idx.length >= 3 && s.idx.length <= 9 ? 3 : s.idx.length <= 12 ? 1 : -2) +
      (keep.some((k) => k.end > s.start && k.end < s.end) ? 1.5 : 0) - Math.abs((s.outStart - from) / (to - from) - 0.5);
    const best = candidates.reduce((a, b) => (score(b) > score(a) ? b : a));
    const dur = Math.min(2.6, Math.max(1.4, best.outEnd - best.outStart));
    const end = mapToSource(best.outStart + dur, keep);
    // texto = palavras realmente ditas; frase longa vira um recorte que termina em palavra forte
    let pick = best.idx;
    if (pick.length > 9) {
      const keyPos = Math.max(0, pick.findIndex((i) => isKeyword(words[i].text)));
      const from = Math.max(0, Math.min(keyPos - 2, pick.length - 8));
      pick = pick.slice(from, from + 8);
      while (pick.length > 3 && WEAK.has(normalizeWord(words[pick[pick.length - 1]].text))) pick = pick.slice(0, -1);
    }
    const text = pick.map((i) => words[i].text).join(" ").replace(/[,;:]$/, "") + (pick.length < best.idx.length && !/[.!?…]$/.test(words[pick[pick.length - 1]].text) ? "…" : "");
    chosen.push({ id: `apoio-${third + 1}-${best.start.toFixed(2)}`, kind: "card", start: best.start, end, text, mediaId: null, auto: true });
  }
  return chosen;
}

// ---------------------------------------------------------------------------
// Legendas: blocos curtos divididos por sentido
// ---------------------------------------------------------------------------

export type CaptionChunk = { start: number; end: number; words: Word[] };

export function wordsAfterCuts(words: Word[], cuts: Range[]) {
  const merged = mergeRanges(cuts);
  return words.filter((w) => !inRanges((w.start + w.end) / 2, merged));
}

/** Palavras que sobram depois dos cortes, já no tempo do vídeo exportado (a ênfase vai junto). */
export function outputWords(words: Word[], cuts: Range[], keep: Range[]): Word[] {
  const flags = emphasisFlags(words);
  const merged = mergeRanges(cuts);
  const out: Word[] = [];
  words.forEach((w, i) => {
    const mid = (w.start + w.end) / 2;
    if (inRanges(mid, merged)) return;
    const seg = keep.find((s) => mid >= s.start && mid <= s.end);
    if (!seg) return;
    const start = mapToOutput(Math.max(w.start, seg.start), keep);
    const end = mapToOutput(Math.min(w.end, seg.end), keep);
    if (start === null || end === null) return;
    out.push({ text: w.text, start, end: Math.max(end, start + 0.05), emph: flags[i] });
  });
  return out;
}

export function maxCharsFor(size: number) {
  // largura útil ~920px em 1080; letra média ~0,6 do tamanho; até 2 linhas
  return Math.max(14, Math.floor((920 / (size * 0.6)) * 2) - 2);
}

export function buildChunks(words: Word[], maxWords: number, maxChars = 30, maxGap = 0.6): CaptionChunk[] {
  const out: CaptionChunk[] = [];
  let current: Word[] = [];
  const flush = () => {
    if (!current.length) return;
    out.push({ start: current[0].start, end: current[current.length - 1].end, words: current });
    current = [];
  };
  const chars = (ws: Word[]) => ws.reduce((n, x) => n + x.text.length + 1, 0) - 1;
  words.forEach((w, i) => {
    if (!w.text.trim()) return;
    const prev = words[i - 1];
    if (current.length && prev && w.start - prev.end > maxGap) flush();
    if (current.length && chars([...current, w]) > maxChars) {
      // não termina o bloco pendurado em "de", "que", "o"...: a palavra fraca desce para o próximo
      const tail = current[current.length - 1];
      if (current.length > 1 && WEAK.has(normalizeWord(tail.text)) && !/[.!?…,;:]$/.test(tail.text)) {
        current.pop();
        flush();
        current.push(tail);
      } else flush();
    }
    current.push(w);
    const full = current.length >= maxWords;
    const punct = /[.!?…,;:]["”')\]]*$/.test(w.text);
    const next = words[i + 1];
    if (punct) flush();
    else if (full) {
      if (WEAK.has(normalizeWord(w.text)) && next && current.length > 1) {
        current.pop();
        flush();
        current.push(w);
      } else flush();
    }
  });
  flush();
  // Estende cada bloco até o próximo (sem buraco piscando), com limite
  for (let i = 0; i < out.length; i++) {
    const next = out[i + 1];
    const limit = next ? next.start : out[i].end + 0.4;
    out[i].end = Math.min(limit, out[i].end + 0.4);
  }
  return out;
}

/** A legenda some enquanto o card está na tela (o card já mostra a frase). */
export function clipToCards(chunk: Range, cards: Array<{ a: number; b: number }>): Range | null {
  let { start, end } = chunk;
  for (const c of cards) {
    if (end <= c.a || start >= c.b) continue;
    if (start >= c.a && end <= c.b) return null;
    if (start >= c.a) start = c.b;
    else end = Math.min(end, c.a);
  }
  return end - start >= 0.12 ? { start, end } : null;
}

/** Uma palavra destacada por bloco no modo "palavras-chave". */
export function chunkEmphasis(chunk: CaptionChunk): number {
  return chunk.words.findIndex((w) => w.emph);
}

export function captionText(text: string, style: Pick<CaptionStyle, "uppercase">) {
  const clean = text.replace(/\s+/g, " ").trim();
  return style.uppercase ? clean.toLocaleUpperCase("pt-BR") : clean;
}

export function formatTime(seconds: number, withMs = false) {
  const s = Math.max(0, seconds);
  const m = Math.floor(s / 60);
  const rest = s - m * 60;
  return withMs
    ? `${String(m).padStart(2, "0")}:${rest.toFixed(1).padStart(4, "0")}`
    : `${String(m).padStart(2, "0")}:${String(Math.floor(rest)).padStart(2, "0")}`;
}
