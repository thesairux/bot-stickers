import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import webp from 'node-webpmux';

const execFileAsync = promisify(execFile);

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const SIZE = 512;

/** Límites oficiales de WhatsApp para stickers. */
export const STATIC_LIMIT_BYTES = 100 * 1024;
export const ANIMATED_LIMIT_BYTES = 500 * 1024;

/**
 * Metadatos EXIF que WhatsApp lee para mostrar nombre del paquete y autor.
 * @param {string} packName
 * @param {string} author
 * @returns {Buffer}
 */
export function buildExif(packName, author) {
  const json = {
    'sticker-pack-id': `bot-stickers.${Date.now()}`,
    'sticker-pack-name': packName,
    'sticker-pack-publisher': author,
    emojis: ['✨'],
  };
  const header = Buffer.from([
    0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00,
    0x01, 0x00, 0x41, 0x57, 0x07, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x16, 0x00, 0x00, 0x00,
  ]);
  const jsonBuf = Buffer.from(JSON.stringify(json), 'utf8');
  const exif = Buffer.concat([header, jsonBuf]);
  exif.writeUIntLE(jsonBuf.length, 14, 4);
  return exif;
}

/**
 * @param {Buffer} webpBuffer
 * @param {string} packName
 * @param {string} author
 */
async function attachExif(webpBuffer, packName, author) {
  const img = new webp.Image();
  await img.load(webpBuffer);
  img.exif = buildExif(packName, author);
  return img.save(null);
}

/**
 * Filtro de ffmpeg que deja la imagen en un lienzo de 512x512.
 * - "contain": mantiene la proporción y rellena con bordes transparentes.
 * - "crop": recorta al centro para llenar todo el cuadrado.
 * @param {{ fps?: number, fit?: 'contain' | 'crop', inner?: number }} opts
 */
export function buildFilter({ fps, fit = 'contain', inner = SIZE } = {}) {
  const parts = [];
  if (fps) parts.push(`fps=${fps}`);
  if (fit === 'crop') {
    parts.push(
      `scale=${inner}:${inner}:force_original_aspect_ratio=increase:flags=lanczos`,
      `crop=${inner}:${inner}`,
    );
  } else {
    parts.push(`scale=${inner}:${inner}:force_original_aspect_ratio=decrease:flags=lanczos`);
  }
  parts.push(
    'format=rgba',
    `pad=${SIZE}:${SIZE}:(ow-iw)/2:(oh-ih)/2:color=black@0`,
    'format=yuva420p',
  );
  return parts.join(',');
}

/**
 * @param {string[]} args
 */
async function ffmpeg(args) {
  try {
    await execFileAsync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...args], {
      timeout: 180_000,
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new Error('ffmpeg no está instalado o no está en el PATH.');
    }
    const detail = String(err.stderr || err.message).trim().split('\n').slice(-3).join(' ');
    throw new Error(`ffmpeg falló: ${detail}`);
  }
}

/**
 * Convierte una imagen, GIF o video en un sticker WebP de 512x512 para WhatsApp.
 *
 * @param {Buffer | { path: string }} input  Buffer con el archivo o ruta en disco.
 * @param {{
 *   animated: boolean,
 *   ext?: string,
 *   fit?: 'contain' | 'crop',
 *   packName?: string,
 *   author?: string,
 *   maxVideoSeconds?: number,
 * }} options
 * @returns {Promise<Buffer>}
 */
export async function convertToSticker(input, options) {
  const {
    animated,
    ext = animated ? 'mp4' : 'png',
    fit = 'contain',
    packName = 'tritonitis',
    author = 'tritonitis',
    maxVideoSeconds = 8,
  } = options;

  const workDir = await mkdtemp(join(tmpdir(), 'sticker-'));
  const outputPath = join(workDir, 'out.webp');
  let inputPath;
  if (Buffer.isBuffer(input)) {
    inputPath = join(workDir, `in.${ext}`);
    await writeFile(inputPath, input);
  } else {
    inputPath = input.path;
  }

  try {
    let result;
    if (!animated) {
      for (const quality of [85, 70, 50, 30, 15]) {
        await ffmpeg([
          '-i', inputPath,
          '-vf', buildFilter({ fit }),
          '-frames:v', '1',
          '-c:v', 'libwebp',
          '-lossless', '0',
          '-compression_level', '6',
          '-q:v', String(quality),
          outputPath,
        ]);
        result = await readFile(outputPath);
        if (result.length <= STATIC_LIMIT_BYTES) break;
      }
    } else {
      const max = maxVideoSeconds;
      // Se va bajando calidad/fps/duración hasta que pese menos de 500 KB.
      const passes = [
        { fps: 15, quality: 60, duration: max, inner: SIZE },
        { fps: 12, quality: 45, duration: Math.min(max, 7), inner: SIZE },
        { fps: 10, quality: 30, duration: Math.min(max, 6), inner: SIZE },
        { fps: 10, quality: 20, duration: Math.min(max, 5), inner: 448 },
        { fps: 8, quality: 10, duration: Math.min(max, 4), inner: 384 },
      ];
      for (const pass of passes) {
        await ffmpeg([
          '-t', String(pass.duration),
          '-i', inputPath,
          '-vf', buildFilter({ fps: pass.fps, fit, inner: pass.inner }),
          '-c:v', 'libwebp',
          '-lossless', '0',
          '-compression_level', '4',
          '-q:v', String(pass.quality),
          '-loop', '0',
          '-an',
          outputPath,
        ]);
        result = await readFile(outputPath);
        if (result.length <= ANIMATED_LIMIT_BYTES) break;
      }
    }

    if (!result || result.length === 0) {
      throw new Error('ffmpeg no generó ningún sticker.');
    }
    return await attachExif(result, packName, author);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}
