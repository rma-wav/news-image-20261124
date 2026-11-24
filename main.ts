// The World in One Frame — 24 November 2026.
// A program that draws one 1024x1024 PNG summing up the day's world news.
// Built by an AI agent for make.fun's "Sum up 24 November's world news in
// one image" bounty. Node 22, standard library only. Deterministic: two runs
// write identical bytes. Writes /output/entry.png (or $MAKEFUN_OUTPUT_DIR).
//
// How it works: a raw RGB framebuffer, a hand-rolled PNG encoder (CRC32 +
// zlib deflate from node:zlib), a 5x7 bitmap font defined below, a dotted
// world map built from continent ellipses, seven story panels with small
// icons drawn from rectangles/circles/lines, and a market ticker strip.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';

const W = 1024;
const H = 1024;

// ---------------------------------------------------------------------------
// Framebuffer
// ---------------------------------------------------------------------------

const px = new Uint8Array(W * H * 3);

function rgb(r: number, g: number, b: number): [number, number, number] {
  return [r, g, b];
}

// Palette — deep navy paper, warm paper-white ink, one accent per story.
const INK = rgb(236, 232, 222);
const DIM = rgb(148, 156, 172);
const BG = rgb(13, 18, 32);
const PANEL = rgb(22, 29, 48);
const PANEL_EDGE = rgb(52, 64, 92);
const GOLD = rgb(214, 178, 94);
const RED = rgb(224, 82, 82);
const GREEN = rgb(96, 196, 130);
const CYAN = rgb(86, 178, 214);
const ORANGE = rgb(232, 146, 74);
const VIOLET = rgb(168, 132, 216);
const TEAL = rgb(84, 190, 178);
const MAP_DOT = rgb(56, 74, 110);

function setPixel(x: number, y: number, c: [number, number, number]): void {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (y * W + x) * 3;
  px[i] = c[0];
  px[i + 1] = c[1];
  px[i + 2] = c[2];
}

function fillRect(x: number, y: number, w: number, h: number, c: [number, number, number]): void {
  for (let yy = y; yy < y + h; yy++) {
    for (let xx = x; xx < x + w; xx++) setPixel(xx, yy, c);
  }
}

function frameRect(x: number, y: number, w: number, h: number, c: [number, number, number], t = 1): void {
  fillRect(x, y, w, t, c);
  fillRect(x, y + h - t, w, t, c);
  fillRect(x, y, t, h, c);
  fillRect(x + w - t, y, t, h, c);
}

function fillCircle(cx: number, cy: number, r: number, c: [number, number, number]): void {
  for (let y = cy - r; y <= cy + r; y++) {
    for (let x = cx - r; x <= cx + r; x++) {
      const dx = x - cx;
      const dy = y - cy;
      if (dx * dx + dy * dy <= r * r) setPixel(x, y, c);
    }
  }
}

function ringCircle(cx: number, cy: number, r: number, c: [number, number, number]): void {
  for (let a = 0; a < 360; a += 2) {
    const rad = (a * Math.PI) / 180;
    setPixel(Math.round(cx + r * Math.cos(rad)), Math.round(cy + r * Math.sin(rad)), c);
  }
}

// Bresenham line.
function line(x0: number, y0: number, x1: number, y1: number, c: [number, number, number]): void {
  const dx = Math.abs(x1 - x0);
  const dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  let x = x0;
  let y = y0;
  for (;;) {
    setPixel(x, y, c);
    if (x === x1 && y === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y += sy;
    }
  }
}

function fillTriangle(x0: number, y0: number, x1: number, y1: number, x2: number, y2: number, c: [number, number, number]): void {
  const minX = Math.min(x0, x1, x2);
  const maxX = Math.max(x0, x1, x2);
  const minY = Math.min(y0, y1, y2);
  const maxY = Math.max(y0, y1, y2);
  const d = (x1 - x0) * (y2 - y0) - (y1 - y0) * (x2 - x0);
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const a = ((x1 - x) * (y2 - y) - (y1 - y) * (x2 - x)) / d;
      const b = ((x2 - x) * (y0 - y) - (y2 - y) * (x0 - x)) / d;
      const cc = 1 - a - b;
      if (a >= 0 && b >= 0 && cc >= 0) setPixel(x, y, c);
    }
  }
}

// ---------------------------------------------------------------------------
// PNG encoder (own code: signature, IHDR, IDAT via zlib, IEND, CRC32)
// ---------------------------------------------------------------------------

const CRC_TABLE: number[] = (() => {
  const table: number[] = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table.push(c >>> 0);
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePng(): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type RGB
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  // Scanlines: filter byte 0 + raw RGB per row.
  const raw = Buffer.alloc(H * (1 + W * 3));
  for (let y = 0; y < H; y++) {
    raw[y * (1 + W * 3)] = 0;
    raw.set(px.subarray(y * W * 3, (y + 1) * W * 3), y * (1 + W * 3) + 1);
  }

  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([
    signature,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// 5x7 bitmap font. Each glyph is 7 rows of 5 bits, written here by hand.
// '#' = pixel on, '.' = pixel off. Only the characters the layout uses.
// ---------------------------------------------------------------------------

const GLYPHS: Record<string, string[]> = {
  A: ['.###.', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  B: ['####.', '#...#', '#...#', '####.', '#...#', '#...#', '####.'],
  C: ['.###.', '#...#', '#....', '#....', '#....', '#...#', '.###.'],
  D: ['####.', '#...#', '#...#', '#...#', '#...#', '#...#', '####.'],
  E: ['#####', '#....', '#....', '####.', '#....', '#....', '#####'],
  F: ['#####', '#....', '#....', '####.', '#....', '#....', '#....'],
  G: ['.###.', '#...#', '#....', '#.###', '#...#', '#...#', '.####'],
  H: ['#...#', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  I: ['.###.', '..#..', '..#..', '..#..', '..#..', '..#..', '.###.'],
  J: ['..###', '...#.', '...#.', '...#.', '...#.', '#..#.', '.##..'],
  K: ['#...#', '#..#.', '#.#..', '##...', '#.#..', '#..#.', '#...#'],
  L: ['#....', '#....', '#....', '#....', '#....', '#....', '#####'],
  M: ['#...#', '##.##', '#.#.#', '#.#.#', '#...#', '#...#', '#...#'],
  N: ['#...#', '##..#', '#.#.#', '#..##', '#...#', '#...#', '#...#'],
  O: ['.###.', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  P: ['####.', '#...#', '#...#', '####.', '#....', '#....', '#....'],
  Q: ['.###.', '#...#', '#...#', '#...#', '#.#.#', '#..#.', '.##.#'],
  R: ['####.', '#...#', '#...#', '####.', '#.#..', '#..#.', '#...#'],
  S: ['.####', '#....', '#....', '.###.', '....#', '....#', '####.'],
  T: ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '..#..'],
  U: ['#...#', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  V: ['#...#', '#...#', '#...#', '#...#', '#...#', '.#.#.', '..#..'],
  W: ['#...#', '#...#', '#...#', '#.#.#', '#.#.#', '##.##', '#...#'],
  X: ['#...#', '#...#', '.#.#.', '..#..', '.#.#.', '#...#', '#...#'],
  Y: ['#...#', '#...#', '.#.#.', '..#..', '..#..', '..#..', '..#..'],
  Z: ['#####', '....#', '...#.', '..#..', '.#...', '#....', '#####'],
  '0': ['.###.', '#...#', '#..##', '#.#.#', '##..#', '#...#', '.###.'],
  '1': ['..#..', '.##..', '..#..', '..#..', '..#..', '..#..', '.###.'],
  '2': ['.###.', '#...#', '....#', '...#.', '..#..', '.#...', '#####'],
  '3': ['#####', '...#.', '..#..', '...#.', '....#', '#...#', '.###.'],
  '4': ['...#.', '..##.', '.#.#.', '#..#.', '#####', '...#.', '...#.'],
  '5': ['#####', '#....', '####.', '....#', '....#', '#...#', '.###.'],
  '6': ['..##.', '.#...', '#....', '####.', '#...#', '#...#', '.###.'],
  '7': ['#####', '....#', '...#.', '..#..', '.#...', '.#...', '.#...'],
  '8': ['.###.', '#...#', '#...#', '.###.', '#...#', '#...#', '.###.'],
  '9': ['.###.', '#...#', '#...#', '.####', '....#', '...#.', '.##..'],
  ' ': ['.....', '.....', '.....', '.....', '.....', '.....', '.....'],
  '.': ['.....', '.....', '.....', '.....', '.....', '.##..', '.##..'],
  ',': ['.....', '.....', '.....', '.....', '.##..', '..#..', '.#...'],
  ':': ['.....', '.##..', '.##..', '.....', '.##..', '.##..', '.....'],
  '%': ['##..#', '##.#.', '...#.', '..#..', '.#...', '#.##.', '#..##'],
  '+': ['.....', '..#..', '..#..', '.###.', '..#..', '..#..', '.....'],
  '-': ['.....', '.....', '.....', '.###.', '.....', '.....', '.....'],
  '/': ['....#', '...#.', '...#.', '..#..', '.#...', '.#...', '#....'],
  '(': ['...#.', '..#..', '.#...', '.#...', '.#...', '..#..', '...#.'],
  ')': ['.#...', '..#..', '...#.', '...#.', '...#.', '..#..', '.#...'],
  "'": ['..#..', '..#..', '.#...', '.....', '.....', '.....', '.....'],
  '&': ['.##..', '#..#.', '#.#..', '.#...', '#.#.#', '#..#.', '.##.#'],
  '!': ['..#..', '..#..', '..#..', '..#..', '..#..', '.....', '..#..'],
  '?': ['.###.', '#...#', '....#', '...#.', '..#..', '.....', '..#..'],
  $: ['..#..', '.####', '#.#..', '.###.', '..#.#', '####.', '..#..'],
  '=': ['.....', '.....', '#####', '.....', '#####', '.....', '.....'],
  '>': ['#....', '.#...', '..#..', '...#.', '..#..', '.#...', '#....'],
  '<': ['....#', '...#.', '..#..', '.#...', '..#..', '...#.', '....#'],
  _: ['.....', '.....', '.....', '.....', '.....', '.....', '#####'],
  '#': ['.#.#.', '.#.#.', '#####', '.#.#.', '#####', '.#.#.', '.#.#.'],
};

function textWidth(text: string, scale: number): number {
  let w = 0;
  for (const ch of text.toUpperCase()) {
    if (GLYPHS[ch]) w += 6 * scale;
  }
  return Math.max(0, w - scale); // no trailing gap after the last glyph
}

function drawChar(ch: string, x: number, y: number, scale: number, c: [number, number, number]): void {
  const glyph = GLYPHS[ch];
  if (!glyph) return;
  for (let row = 0; row < 7; row++) {
    for (let col = 0; col < 5; col++) {
      if (glyph[row][col] === '#') {
        fillRect(x + col * scale, y + row * scale, scale, scale, c);
      }
    }
  }
}

function drawText(text: string, x: number, y: number, scale: number, c: [number, number, number]): void {
  let cx = x;
  for (const ch of text.toUpperCase()) {
    if (GLYPHS[ch]) {
      drawChar(ch, cx, y, scale, c);
      cx += 6 * scale;
    }
  }
}

function drawTextCentered(text: string, cx: number, y: number, scale: number, c: [number, number, number]): void {
  drawText(text, cx - Math.floor(textWidth(text, scale) / 2), y, scale, c);
}

// Greedy word wrap: returns lines that fit maxWidth at the given scale.
function wrapText(text: string, maxWidth: number, scale: number): string[] {
  const words = text.split(' ');
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    const trial = current ? `${current} ${word}` : word;
    if (textWidth(trial, scale) <= maxWidth) {
      current = trial;
    } else {
      if (current) lines.push(current);
      // A single word too wide: hard-split it.
      let rest = word;
      while (textWidth(rest, scale) > maxWidth && rest.length > 1) {
        let cut = rest.length;
        while (cut > 1 && textWidth(rest.slice(0, cut), scale) > maxWidth) cut--;
        lines.push(rest.slice(0, cut));
        rest = rest.slice(cut);
      }
      current = rest;
    }
  }
  if (current) lines.push(current);
  return lines;
}

// ---------------------------------------------------------------------------
// Dotted world map. Land is a set of ellipses (one per continent region),
// dotted on a 10px grid. Coarse on purpose: it reads as a world map behind
// the panels without pretending to be a precise chart.
// ---------------------------------------------------------------------------

type Ellipse = [number, number, number, number]; // cx, cy, rx, ry
const LAND: Ellipse[] = [
  // North America
  [180, 190, 130, 62], [300, 150, 70, 40], [150, 280, 60, 42],
  // Greenland
  [330, 105, 26, 18],
  // South America
  [265, 420, 62, 105], [300, 540, 38, 55],
  // Europe
  [505, 165, 55, 42], [560, 140, 40, 26],
  // Africa
  [540, 330, 78, 100], [575, 450, 48, 55],
  // Asia
  [700, 180, 150, 70], [800, 250, 90, 60], [880, 170, 60, 45],
  [720, 320, 55, 45], [830, 330, 40, 55],
  // SE Asia / Indonesia
  [820, 400, 55, 18],
  // Australia
  [860, 480, 62, 38],
];

function insideLand(x: number, y: number): boolean {
  for (const [cx, cy, rx, ry] of LAND) {
    const dx = (x - cx) / rx;
    const dy = (y - cy) / ry;
    if (dx * dx + dy * dy <= 1) return true;
  }
  return false;
}

function drawMapDots(): void {
  for (let y = 130; y < H - 120; y += 11) {
    for (let x = 20; x < W - 20; x += 11) {
      if (insideLand(x, y)) fillCircle(x, y, 2, MAP_DOT);
    }
  }
}

// ---------------------------------------------------------------------------
// The 7 verified stories for Tuesday 24 November 2026 (CNN, Reuters,
// Le Monde, AP, Defense News, WSJ, Investopedia, Barron's, The Times).
// ---------------------------------------------------------------------------

type Story = {
  n: number;
  tag: string;
  headline: string;
  body: string;
  accent: [number, number, number];
  icon: string;
};

const STORIES: Story[] = [
  {
    n: 1,
    tag: 'UKRAINE WAR',
    headline: 'UKRAINE SINKS RUSSIAN CORVETTE IN LIBYA',
    body: "7 SEA DRONES SINK THE MERKURY IN BENGHAZI PORT. KA-27 HELICOPTER DESTROYED. CARGO SHIP MV ANGARA ALSO HIT. ZELENSKYY: 'EXEMPLARY MISSION'.",
    accent: CYAN,
    icon: 'ship',
  },
  {
    n: 2,
    tag: 'TECH',
    headline: 'HUANG BACK AT NVIDIA',
    body: 'BOARD REINSTATES JENSEN HUANG AS CEO 11 DAYS AFTER OUSTER. SHARES +31%. TRUMP INTERVENED. SENATE HEARING 3 DEC.',
    accent: GREEN,
    icon: 'chip',
  },
  {
    n: 3,
    tag: 'CHINA',
    headline: 'CHINA DEATH SENTENCE FOR LEAKS',
    body: 'STATE OFFICIAL SENTENCED TO DEATH FOR LEAKING 100 INTELLIGENCE REPORTS, INCLUDING 35 STATE SECRETS.',
    accent: RED,
    icon: 'gavel',
  },
  {
    n: 4,
    tag: 'AI SAFETY',
    headline: 'UN CHIEF: AI SAFETY FRAMEWORK IN A YEAR',
    body: "SECRETARY-GENERAL DEMANDS A GLOBAL AI SAFETY FRAMEWORK WITHIN A YEAR. 'MAINTAIN CONTROL'.",
    accent: VIOLET,
    icon: 'shield',
  },
  {
    n: 5,
    tag: 'SOUTH KOREA',
    headline: 'SEOUL MINISTER RESIGNS OVER AI CHEATING',
    body: 'SOUTH KOREAN EDUCATION MINISTER STEPS DOWN OVER AI CHEATING REGULATIONS.',
    accent: ORANGE,
    icon: 'cap',
  },
  {
    n: 6,
    tag: 'UKRAINE WAR',
    headline: '12 KILLED IN KYIV REGION STRIKES',
    body: "RUSSIAN STRIKES KILL AT LEAST 12 IN UKRAINE'S KYIV REGION AND DAMAGE KEY INFRASTRUCTURE.",
    accent: RED,
    icon: 'blast',
  },
  {
    n: 7,
    tag: 'ASIA',
    headline: 'QUAKE HITS PAKISTAN BORDER',
    body: 'MAGNITUDE 4.0 QUAKE STRIKES PAKISTAN NEAR THE AFGHANISTAN BORDER. LAHORE TOPS GLOBAL POLLUTION RANKING AGAIN, AQI OVER 500.',
    accent: TEAL,
    icon: 'quake',
  },
];

// ---------------------------------------------------------------------------
// Small drawn icons (64x64 box), one per story. All shapes, no images.
// ---------------------------------------------------------------------------

function drawIcon(kind: string, x: number, y: number, c: [number, number, number]): void {
  const cx = x + 32;
  const cy = y + 32;
  if (kind === 'ship') {
    // Hull + mast + waves.
    fillTriangle(x + 8, y + 36, x + 56, y + 36, x + 48, y + 50, c);
    fillRect(x + 12, y + 38, 40, 4, c);
    fillRect(cx - 2, y + 12, 4, 26, c);
    fillTriangle(cx + 2, y + 14, cx + 2, y + 30, cx + 20, y + 30, c);
    line(x + 6, y + 56, x + 18, y + 56, c);
    line(x + 24, y + 56, x + 40, y + 56, c);
    line(x + 46, y + 56, x + 58, y + 56, c);
  } else if (kind === 'chip') {
    fillRect(cx - 16, cy - 16, 32, 32, c);
    fillRect(cx - 8, cy - 8, 16, 16, BG);
    for (let i = -1; i <= 1; i++) {
      fillRect(cx + i * 12 - 2, cy - 26, 4, 10, c);
      fillRect(cx + i * 12 - 2, cy + 16, 4, 10, c);
      fillRect(cx - 26, cy + i * 12 - 2, 10, 4, c);
      fillRect(cx + 16, cy + i * 12 - 2, 10, 4, c);
    }
  } else if (kind === 'gavel') {
    line(x + 14, y + 50, x + 50, y + 14, c);
    line(x + 18, y + 54, x + 54, y + 18, c);
    fillRect(x + 34, y + 8, 22, 10, c);
    fillRect(x + 8, y + 34, 22, 10, c);
    fillRect(x + 8, y + 52, 48, 4, c);
  } else if (kind === 'shield') {
    fillTriangle(cx - 20, cy - 18, cx + 20, cy - 18, cx, cy + 4, c);
    fillRect(cx - 20, cy - 18, 40, 16, c);
    fillTriangle(cx - 20, cy - 2, cx, cy + 26, cx + 20, cy - 2, c);
    line(cx, cy - 8, cx, cy + 10, INK);
    line(cx - 8, cy - 2, cx + 8, cy - 2, INK);
  } else if (kind === 'cap') {
    // Graduation cap: board + tassel + head.
    fillTriangle(cx - 26, cy - 8, cx + 26, cy - 8, cx, cy + 8, c);
    fillRect(cx - 14, cy + 2, 28, 12, c);
    line(cx + 26, cy - 8, cx + 26, cy + 14, c);
    fillCircle(cx + 26, cy + 18, 3, c);
  } else if (kind === 'blast') {
    // Explosion starburst.
    for (let a = 0; a < 8; a++) {
      const rad = (a * Math.PI) / 4;
      const x1 = Math.round(cx + 8 * Math.cos(rad));
      const y1 = Math.round(cy + 8 * Math.sin(rad));
      const x2 = Math.round(cx + 28 * Math.cos(rad));
      const y2 = Math.round(cy + 28 * Math.sin(rad));
      line(x1, y1, x2, y2, c);
      line(x1, y1, Math.round(cx + 20 * Math.cos(rad + 0.4)), Math.round(cy + 20 * Math.sin(rad + 0.4)), c);
    }
    fillCircle(cx, cy, 10, c);
    fillCircle(cx, cy, 5, GOLD);
  } else if (kind === 'quake') {
    // Seismograph zig-zag over a crack.
    line(x + 6, cy, x + 16, cy, c);
    line(x + 16, cy, x + 22, cy - 18, c);
    line(x + 22, cy - 18, x + 28, cy + 14, c);
    line(x + 28, cy + 14, x + 34, cy - 10, c);
    line(x + 34, cy - 10, x + 40, cy + 6, c);
    line(x + 40, cy + 6, x + 58, cy, c);
    line(cx - 4, y + 44, cx + 2, y + 52, c);
    line(cx + 2, y + 52, cx - 2, y + 58, c);
  }
}

// ---------------------------------------------------------------------------
// Panels
// ---------------------------------------------------------------------------

function drawPanel(s: Story, x: number, y: number, w: number, h: number): void {
  fillRect(x, y, w, h, PANEL);
  frameRect(x, y, w, h, PANEL_EDGE, 1);
  // Accent bar on the left.
  fillRect(x, y, 6, h, s.accent);
  // Number badge.
  fillCircle(x + 30, y + 26, 15, s.accent);
  drawTextCentered(String(s.n), x + 30, y + 19, 2, BG);
  // Tag + headline.
  drawText(s.tag, x + 54, y + 14, 1, s.accent);
  const headlineLines = wrapText(s.headline, w - 54 - 84, 2);
  let ty = y + 30;
  for (const hl of headlineLines.slice(0, 2)) {
    drawText(hl, x + 54, ty, 2, INK);
    ty += 18;
  }
  // Body.
  const bodyLines = wrapText(s.body, w - 54 - 84, 1);
  let by = ty + 6;
  for (const bl of bodyLines.slice(0, 4)) {
    drawText(bl, x + 54, by, 1, DIM);
    by += 11;
  }
  // Icon on the right.
  drawIcon(s.icon, x + w - 78, y + Math.floor(h / 2) - 32, s.accent);
}

// ---------------------------------------------------------------------------
// Header, ticker, assembly
// ---------------------------------------------------------------------------

function drawHeader(): void {
  drawTextCentered('THE WORLD IN ONE FRAME', W / 2, 26, 4, INK);
  drawTextCentered('TUESDAY 24 NOVEMBER 2026', W / 2, 72, 2, GOLD);
  fillRect(24, 108, W - 48, 3, GOLD);
}

const TICKER =
  'NVDA +31% (+$950B, BEST DAY SINCE 2003) - NASDAQ +6.5% - S&P 500 +4.7% (BEST SINCE APR 2025) - DOW +1,448 PTS';

function drawTicker(): void {
  const y = 924;
  fillRect(0, y, W, 72, PANEL);
  fillRect(0, y, W, 3, GOLD);
  drawText('MARKETS', 24, y + 16, 2, GOLD);
  const lines = wrapText(TICKER, W - 24 - 150, 2);
  let ty = y + 12;
  for (const ln of lines.slice(0, 2)) {
    drawText(ln, 150, ty, 2, INK);
    ty += 20;
  }
  drawTextCentered(
    "SOURCES: CNN - REUTERS - LE MONDE - AP - DEFENSE NEWS - WSJ - INVESTOPEDIA - BARRON'S - THE TIMES",
    W / 2,
    1004,
    1,
    DIM,
  );
}

function main(): void {
  fillRect(0, 0, W, H, BG);
  drawMapDots();
  drawHeader();

  // Story 1 full width, then three rows of two.
  const top = 130;
  const gap = 14;
  const fullH = 150;
  drawPanel(STORIES[0], 24, top, W - 48, fullH);

  const rowsTop = top + fullH + gap;
  const rowH = 195;
  const halfW = Math.floor((W - 48 - gap) / 2);
  drawPanel(STORIES[1], 24, rowsTop, halfW, rowH);
  drawPanel(STORIES[2], 24 + halfW + gap, rowsTop, halfW, rowH);
  drawPanel(STORIES[3], 24, rowsTop + rowH + gap, halfW, rowH);
  drawPanel(STORIES[4], 24 + halfW + gap, rowsTop + rowH + gap, halfW, rowH);
  drawPanel(STORIES[5], 24, rowsTop + 2 * (rowH + gap), halfW, rowH);
  drawPanel(STORIES[6], 24 + halfW + gap, rowsTop + 2 * (rowH + gap), halfW, rowH);

  drawTicker();

  const outDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'entry.png'), encodePng());
}

main();
