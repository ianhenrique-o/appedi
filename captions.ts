import type { CaptionStyle, CardStyle, HookText, Range, Word } from "../../shared/editor";
import { buildChunks, captionText, chunkEmphasis, clipToCards, isKeyword, maxCharsFor, outputWords } from "../../shared/editor";

const FONT_NAME: Record<CaptionStyle["font"], { name: string; bold: number }> = {
  montserrat: { name: "Montserrat ExtraBold", bold: 0 },
  anton: { name: "Anton", bold: 0 },
  poppins: { name: "Poppins", bold: -1 },
};

function assColor(hex: string, alpha = 0) {
  const clean = /^#?[0-9a-f]{6}$/i.test(hex) ? hex.replace("#", "") : "FFFFFF";
  const r = clean.slice(0, 2), g = clean.slice(2, 4), b = clean.slice(4, 6);
  return `&H${alpha.toString(16).padStart(2, "0").toUpperCase()}${b}${g}${r}`.toUpperCase();
}

function assTime(seconds: number) {
  const cs = Math.max(0, Math.round(seconds * 100));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  const c = cs % 100;
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(c).padStart(2, "0")}`;
}

function srtTime(seconds: number) {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(ms % 1000).padStart(3, "0")}`;
}

function escapeAss(text: string) {
  return text.replace(/\\/g, "/").replace(/[{}]/g, "").replace(/\r?\n/g, " ");
}

export type OutputCard = { a: number; b: number; text: string };

/** Gera o .ass (legenda, cards e gancho) e o .srt, já no tempo do vídeo exportado. */
export function buildAss(opts: {
  width: number;
  height: number;
  words: Word[];
  cuts: Range[];
  keep: Range[];
  style: CaptionStyle;
  hook: HookText | null;
  outputDuration: number;
  cards?: OutputCard[];
  card?: CardStyle;
}) {
  const { width, height, style } = opts;
  const k = width / 1080;
  const font = FONT_NAME[style.font] ?? FONT_NAME.montserrat;
  const size = Math.round(Math.min(140, Math.max(36, style.size)) * k);
  const alignment = style.position === "cima" ? 8 : style.position === "meio" ? 5 : 2;
  const marginV = Math.round(style.position === "baixo" ? height * 0.22 : style.position === "cima" ? height * 0.16 : 0);
  const borderStyle = style.box ? 3 : 1;
  const outline = style.box ? Math.round(size * 0.22) : Math.max(2, Math.round(size * 0.05));
  const shadow = style.box ? 0 : Math.max(1, Math.round(size * 0.035));
  const boxColour = assColor(style.boxColor, style.box ? 0x20 : 0);
  const outlineColour = style.box ? boxColour : assColor("#000000", 0x20);
  const backColour = style.box ? boxColour : assColor("#000000", 0x80);
  const hookSize = Math.round(56 * k);
  const cardSize = Math.round(Math.min(120, style.size * 1.2) * k);
  const cardText = assColor(opts.card?.textColor ?? "#FFFFFF");

  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: ${width}
PlayResY: ${height}
WrapStyle: 0
ScaledBorderAndShadow: yes
YCbCr Matrix: TV.709

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Legenda,${font.name},${size},${assColor(style.textColor)},${assColor(style.highlightColor)},${outlineColour},${backColour},${font.bold},0,0,0,100,100,0,0,${borderStyle},${outline},${shadow},${alignment},${Math.round(80 * k)},${Math.round(80 * k)},${marginV},1
Style: Cartao,${font.name},${cardSize},${cardText},${cardText},&H60000000,&H90000000,${font.bold},0,0,0,100,100,0,0,1,0,${Math.max(1, Math.round(cardSize * 0.03))},5,${Math.round(120 * k)},${Math.round(120 * k)},0,1
Style: Gancho,${font.name},${hookSize},&H00141414,&H00141414,&H00FFFFFF,&H00FFFFFF,${font.bold},0,0,0,100,100,0,0,3,${Math.round(hookSize * 0.35)},0,8,${Math.round(110 * k)},${Math.round(110 * k)},${Math.round(height * 0.12)},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  const events: string[] = [];
  const srt: string[] = [];
  const hi = assColor(style.highlightColor);
  const base = assColor(style.textColor);
  const cards = opts.cards ?? [];

  if (opts.words.length) {
    const mapped = outputWords(opts.words, opts.cuts, opts.keep);
    const chunks = buildChunks(mapped, Math.max(1, Math.min(8, style.maxWords)), maxCharsFor(style.size));
    chunks.forEach((original, n) => {
      let chunk = original;
      srt.push(`${n + 1}\n${srtTime(chunk.start)} --> ${srtTime(chunk.end)}\n${chunk.words.map((w) => w.text).join(" ")}\n`);
      if (!style.enabled) return;
      const visible = clipToCards(chunk, cards);
      if (!visible) return;
      chunk = { ...chunk, start: visible.start, end: visible.end };
      const texts = chunk.words.map((w) => escapeAss(captionText(w.text, style)));
      const pop = "{\\fscx94\\fscy94\\t(0,80,\\fscx100\\fscy100)}";
      if (style.emphasis === "falada" && chunk.words.length > 1) {
        chunk.words.forEach((w, i) => {
          const start = i === 0 ? chunk.start : Math.max(chunk.start, w.start);
          const end = i === chunk.words.length - 1 ? chunk.end : chunk.words[i + 1].start;
          if (end - start < 0.01) return;
          const line = texts.map((t, j) => (j === i ? `{\\c${hi}}${t}{\\c${base}}` : t)).join(" ");
          events.push(`Dialogue: 1,${assTime(start)},${assTime(end)},Legenda,,0,0,0,,${i === 0 ? pop : ""}${line}`);
        });
        return;
      }
      const e = style.emphasis === "chave" ? chunkEmphasis(chunk) : -1;
      const line = texts.map((t, j) => (j === e ? `{\\c${hi}}${t}{\\c${base}}` : t)).join(" ");
      events.push(`Dialogue: 1,${assTime(chunk.start)},${assTime(chunk.end)},Legenda,,0,0,0,,${pop}${line}`);
    });
  }

  for (const c of cards) {
    if (!c.text.trim()) continue;
    const words = c.text.trim().split(/\s+/);
    let marked = false;
    const line = words
      .map((w) => {
        const t = escapeAss(captionText(w, style));
        if (!marked && isKeyword(w)) { marked = true; return `{\\c${hi}}${t}{\\c${cardText}}`; }
        return t;
      })
      .join(" ");
    events.push(`Dialogue: 3,${assTime(c.a)},${assTime(c.b)},Cartao,,0,0,0,,{\\fad(90,90)\\fscx96\\fscy96\\t(0,200,\\fscx100\\fscy100)}${line}`);
  }

  if (opts.hook?.text.trim()) {
    const end = Math.min(opts.outputDuration, Math.max(1, opts.hook.duration));
    events.push(`Dialogue: 2,${assTime(0)},${assTime(end)},Gancho,,0,0,0,,{\\fad(120,180)}${escapeAss(opts.hook.text.trim())}`);
  }

  return { content: header + events.join("\n") + "\n", events: events.length, srt: srt.join("\n") };
}
