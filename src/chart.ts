import { ratingColor } from "./rating";

const WIDTH = 400;
const HEIGHT = 220;
const LEFT = 40;
const TOP = 12;
const RIGHT = WIDTH - 12;
const BOTTOM = HEIGHT - 25;
const DIGITS: Record<string, string[]> = {
  "0": ["111", "101", "101", "101", "111"],
  "1": ["010", "110", "010", "010", "111"],
  "2": ["111", "001", "111", "100", "111"],
  "3": ["111", "001", "111", "001", "111"],
  "4": ["101", "101", "111", "001", "001"],
  "5": ["111", "100", "111", "001", "111"],
  "6": ["111", "100", "111", "101", "111"],
  "7": ["111", "001", "010", "010", "010"],
  "8": ["111", "101", "111", "101", "111"],
  "9": ["111", "101", "111", "001", "111"],
  "-": ["000", "000", "111", "000", "000"],
};

// Small PNG renderer: no native canvas, external chart service, or font download.
export async function ratingChart(values: number[], firstChallenge = 0): Promise<Uint8Array<ArrayBuffer>> {
  if (!values.length || values.length > 201 || values.some((value) => !Number.isFinite(value))) {
    throw new Error("A rating chart requires between 1 and 201 finite values.");
  }
  const pixels = new Uint8Array(WIDTH * HEIGHT * 4);
  pixels.fill(255);
  const min = Math.min(...values) - 100;
  const max = Math.max(...values) + 100;
  const y = (value: number) => Math.round(BOTTOM - (value - min) / (max - min) * (BOTTOM - TOP));
  const x = (index: number) => Math.round(LEFT + index / Math.max(1, values.length - 1) * (RIGHT - LEFT));
  function pixel(px: number, py: number, color: number): void {
    if (px < 0 || px >= WIDTH || py < 0 || py >= HEIGHT) return;
    const offset = (py * WIDTH + px) * 4;
    pixels[offset] = color >> 16 & 255;
    pixels[offset + 1] = color >> 8 & 255;
    pixels[offset + 2] = color & 255;
  }
  function line(x0: number, y0: number, x1: number, y1: number, color: number): void {
    const dx = Math.abs(x1 - x0), sx = x0 < x1 ? 1 : -1;
    const dy = -Math.abs(y1 - y0), sy = y0 < y1 ? 1 : -1;
    let error = dx + dy;
    for (;;) {
      pixel(x0, y0, color);
      if (x0 === x1 && y0 === y1) break;
      const twice = 2 * error;
      if (twice >= dy) { error += dy; x0 += sx; }
      if (twice <= dx) { error += dx; y0 += sy; }
    }
  }
  function text(value: number, px: number, py: number): void {
    for (const digit of String(Math.round(value))) {
      const glyph = DIGITS[digit]!;
      for (let row = 0; row < 5; row++) {
        for (let column = 0; column < 3; column++) {
          if (glyph[row]![column] === "1") {
            for (let a = 0; a < 2; a++) for (let b = 0; b < 2; b++) {
              pixel(px + column * 2 + a, py + row * 2 + b, 0x334155);
            }
          }
        }
      }
      px += 8;
    }
  }
  for (let row = TOP; row <= BOTTOM; row++) {
    const color = ratingColor(min + (BOTTOM - row) / (BOTTOM - TOP) * (max - min));
    const pastel = [color >> 16 & 255, color >> 8 & 255, color & 255]
      .map((channel) => Math.round(channel * 0.14 + 255 * 0.86));
    const rgb = pastel[0]! << 16 | pastel[1]! << 8 | pastel[2]!;
    for (let column = LEFT; column <= RIGHT; column++) pixel(column, row, rgb);
  }
  const ticks = [0, 1200, 1400, 1600, 1900, 2100, 2300, 2400, 2600, 3000]
    .filter((value) => value >= min && value <= max);
  if (!ticks.length) ticks.push(values[0]!);
  for (const tick of ticks) {
    line(LEFT, y(tick), RIGHT, y(tick), 0xcbd5e1);
    text(tick, 2, y(tick) - 4);
  }
  line(LEFT, TOP, LEFT, BOTTOM, 0x64748b);
  line(LEFT, BOTTOM, RIGHT, BOTTOM, 0x64748b);
  for (let i = 0; i < values.length; i++) {
    if (i) line(x(i - 1), y(values[i - 1]!), x(i), y(values[i]!), 0x2563eb);
    for (let a = -2; a <= 2; a++) for (let b = -2; b <= 2; b++) {
      if (a * a + b * b <= 4) pixel(x(i) + a, y(values[i]!) + b, 0x1d4ed8);
    }
  }
  text(firstChallenge, LEFT, BOTTOM + 8);
  if (values.length > 1) text(firstChallenge + values.length - 1, RIGHT - 32, BOTTOM + 8);

  const raw = new Uint8Array((WIDTH * 4 + 1) * HEIGHT);
  for (let row = 0; row < HEIGHT; row++) {
    raw.set(pixels.subarray(row * WIDTH * 4, (row + 1) * WIDTH * 4), row * (WIDTH * 4 + 1) + 1);
  }
  const compression = new CompressionStream("deflate");
  const compressed = new Response(compression.readable).arrayBuffer();
  const writer = compression.writable.getWriter();
  await writer.write(raw);
  await writer.close();
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, WIDTH);
  view.setUint32(4, HEIGHT);
  header[8] = 8;
  header[9] = 6;
  const chunks = [
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", new Uint8Array(await compressed)),
    pngChunk("IEND", new Uint8Array()),
  ];
  const png = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) { png.set(chunk, offset); offset += chunk.length; }
  return png;
}

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let i = 0; i < 8; i++) crc = crc & 1 ? 0xedb88320 ^ crc >>> 1 : crc >>> 1;
  return crc >>> 0;
});

function pngChunk(type: string, data: Uint8Array): Uint8Array<ArrayBuffer> {
  const result = new Uint8Array(data.length + 12);
  const view = new DataView(result.buffer);
  view.setUint32(0, data.length);
  result.set(new TextEncoder().encode(type), 4);
  result.set(data, 8);
  let crc = 0xffffffff;
  for (let i = 4; i < data.length + 8; i++) crc = CRC_TABLE[(crc ^ result[i]!) & 255]! ^ crc >>> 8;
  view.setUint32(data.length + 8, (crc ^ 0xffffffff) >>> 0);
  return result;
}
