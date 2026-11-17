import { S_WHATSAPP_NET } from 'baileys';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Deja un JPEG "limpio": quita los segmentos APP1–APP15 (EXIF, perfil de
 * color ICC, XMP…) y los comentarios (COM). Solo quedan el encabezado JFIF y
 * los datos de la imagen, igual que el JPEG que generan sharp/jimp.
 * @param {Buffer} jpeg
 * @returns {Buffer}
 */
export function cleanJpeg(jpeg) {
  if (jpeg.length < 4 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) {
    throw new Error('no es un JPEG válido');
  }
  const parts = [jpeg.subarray(0, 2)];
  let i = 2;
  while (i + 4 <= jpeg.length) {
    if (jpeg[i] !== 0xff) throw new Error('JPEG dañado');
    const marker = jpeg[i + 1];
    if (marker === 0xda) {
      // SOS: desde aquí son los datos comprimidos de la imagen.
      parts.push(jpeg.subarray(i));
      return Buffer.concat(parts);
    }
    const length = jpeg.readUInt16BE(i + 2);
    const isAppExtra = marker >= 0xe1 && marker <= 0xef;
    const isComment = marker === 0xfe;
    if (!isAppExtra && !isComment) parts.push(jpeg.subarray(i, i + 2 + length));
    i += 2 + length;
  }
  throw new Error('JPEG incompleto');
}

/**
 * Recorta la imagen al centro en cuadrado y la deja en JPEG de 640x640
 * (el formato que usa WhatsApp para las fotos de perfil). Se hace con ffmpeg
 * para no depender de sharp/jimp. El resultado es un JPEG básico 4:2:0 sin
 * metadatos (ni EXIF/GPS ni perfil de color).
 * @param {string} path
 * @returns {Promise<Buffer>}
 */
export async function prepareProfilePicture(path) {
  const ffmpegBin = process.env.FFMPEG_PATH || 'ffmpeg';
  let stdout;
  try {
    ({ stdout } = await execFileAsync(
      ffmpegBin,
      [
        '-hide_banner', '-loglevel', 'error', '-nostdin',
        '-i', path,
        '-map_metadata', '-1',
        '-vf', "crop='min(iw,ih)':'min(iw,ih)',scale=640:640:flags=lanczos",
        '-frames:v', '1',
        '-c:v', 'mjpeg',
        '-pix_fmt', 'yuvj420p',
        '-huffman', 'default',
        '-flags:v', '+bitexact',
        '-q:v', '5',
        '-f', 'image2pipe', '-',
      ],
      { encoding: 'buffer', timeout: 60_000, maxBuffer: 20 * 1024 * 1024 },
    ));
  } catch (err) {
    const detail = String(err.stderr || err.message).trim().split('\n').pop();
    throw new Error(`no pude preparar la foto de perfil: ${detail}`);
  }
  if (!stdout?.length) throw new Error('no pude preparar la foto de perfil: ffmpeg no generó la imagen');
  return cleanJpeg(stdout);
}

/**
 * Pone la foto de perfil del bot si cambió desde la última vez.
 * Guarda un hash en la carpeta de sesión para no subirla en cada reconexión.
 *
 * @param {{ query: (node: any) => Promise<any> }} sock
 * @param {{ path: string, authDir: string, log?: Pick<Console, 'log' | 'warn'> }} opts
 * @returns {Promise<'updated' | 'unchanged' | 'disabled'>}
 */
export async function syncProfilePicture(sock, { path, authDir, log = console }) {
  if (!path) return 'disabled';

  let source;
  try {
    source = await readFile(path);
  } catch {
    log.warn(`[bot] No encontré la foto de perfil en "${path}". Revisa PROFILE_PICTURE en tu .env.`);
    return 'disabled';
  }

  const hash = createHash('sha256').update(source).digest('hex');
  const stateFile = join(authDir, 'profile-picture.sha256');
  const previous = await readFile(stateFile, 'utf8').catch(() => '');
  if (previous.trim() === hash) return 'unchanged';

  const img = await prepareProfilePicture(path);
  try {
    await sock.query({
      tag: 'iq',
      attrs: { to: S_WHATSAPP_NET, type: 'set', xmlns: 'w:profile:picture' },
      content: [{ tag: 'picture', attrs: { type: 'image' }, content: img }],
    });
  } catch (err) {
    if (/not-acceptable/i.test(String(err?.message))) {
      throw new Error('WhatsApp no aceptó la imagen (not-acceptable). Prueba con otra foto en PROFILE_PICTURE.');
    }
    throw err;
  }
  await writeFile(stateFile, hash);
  log.log('[bot] 🖼️  Foto de perfil actualizada.');
  return 'updated';
}

/** Máximo de caracteres que WhatsApp permite en la "Info" del perfil. */
export const MAX_STATUS_LENGTH = 139;

/**
 * Pone la descripción ("Info") del perfil del bot si cambió desde la última vez.
 *
 * @param {{ updateProfileStatus: (status: string) => Promise<void> }} sock
 * @param {{ status: string, authDir: string, log?: Pick<Console, 'log' | 'warn'> }} opts
 * @returns {Promise<'updated' | 'unchanged' | 'disabled'>}
 */
export async function syncProfileStatus(sock, { status, authDir, log = console }) {
  const text = (status || '').trim();
  if (!text) return 'disabled';
  if ([...text].length > MAX_STATUS_LENGTH) {
    log.warn(`[bot] La descripción tiene más de ${MAX_STATUS_LENGTH} caracteres; WhatsApp no la acepta. Acórtala en PROFILE_STATUS.`);
    return 'disabled';
  }

  const stateFile = join(authDir, 'profile-status.txt');
  const previous = await readFile(stateFile, 'utf8').catch(() => null);
  if (previous === text) return 'unchanged';

  await sock.updateProfileStatus(text);
  await writeFile(stateFile, text);
  log.log(`[bot] 📝 Descripción actualizada: "${text}"`);
  return 'updated';
}
