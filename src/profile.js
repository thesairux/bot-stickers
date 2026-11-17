import { S_WHATSAPP_NET } from 'baileys';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Recorta la imagen al centro en cuadrado y la deja en JPEG de 640x640
 * (el formato que usa WhatsApp para las fotos de perfil). Se hace con ffmpeg
 * para no depender de sharp/jimp. También quita los metadatos (EXIF/GPS).
 * @param {string} path
 * @returns {Promise<Buffer>}
 */
export async function prepareProfilePicture(path) {
  const ffmpegBin = process.env.FFMPEG_PATH || 'ffmpeg';
  try {
    const { stdout } = await execFileAsync(
      ffmpegBin,
      [
        '-hide_banner', '-loglevel', 'error', '-nostdin',
        '-i', path,
        '-map_metadata', '-1',
        '-vf', "crop='min(iw,ih)':'min(iw,ih)',scale=640:640:flags=lanczos",
        '-frames:v', '1',
        '-c:v', 'mjpeg', '-q:v', '4',
        '-f', 'image2pipe', '-',
      ],
      { encoding: 'buffer', timeout: 60_000, maxBuffer: 20 * 1024 * 1024 },
    );
    if (!stdout?.length) throw new Error('ffmpeg no generó la imagen');
    return stdout;
  } catch (err) {
    const detail = String(err.stderr || err.message).trim().split('\n').pop();
    throw new Error(`no pude preparar la foto de perfil: ${detail}`);
  }
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
  await sock.query({
    tag: 'iq',
    attrs: { to: S_WHATSAPP_NET, type: 'set', xmlns: 'w:profile:picture' },
    content: [{ tag: 'picture', attrs: { type: 'image' }, content: img }],
  });
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
