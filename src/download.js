import { execFile } from 'node:child_process';
import { open, readdir, stat } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/**
 * Descarga una URL a un archivo, cortando si supera maxBytes.
 * @param {string} url
 * @param {string} filePath
 * @param {{ maxBytes: number, fetchImpl?: typeof fetch, headers?: Record<string,string> }} opts
 * @returns {Promise<{ path: string, size: number, contentType: string }>}
 */
export async function downloadToFile(url, filePath, { maxBytes, fetchImpl = fetch, headers = {} }) {
  const res = await fetchImpl(url, {
    headers: { 'User-Agent': BROWSER_UA, ...headers },
    redirect: 'follow',
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok || !res.body) {
    throw new Error(`HTTP ${res.status} al descargar el archivo`);
  }
  const declared = Number(res.headers.get('content-length'));
  if (declared && declared > maxBytes) {
    await res.body.cancel().catch(() => {});
    throw new Error(`el archivo pesa ${toMb(declared)} MB (máximo ${toMb(maxBytes)} MB)`);
  }

  const file = await open(filePath, 'w');
  let size = 0;
  try {
    for await (const chunk of res.body) {
      size += chunk.length;
      if (size > maxBytes) {
        throw new Error(`el archivo supera el máximo de ${toMb(maxBytes)} MB`);
      }
      await file.write(chunk);
    }
  } finally {
    await file.close();
  }
  if (size === 0) throw new Error('la descarga llegó vacía');
  return { path: filePath, size, contentType: res.headers.get('content-type') || '' };
}

/**
 * Descarga solo los primeros segundos de un stream HLS (.m3u8) a un mp4 usando ffmpeg.
 * @param {string} url
 * @param {string} filePath
 * @param {number} seconds
 */
export async function downloadHls(url, filePath, seconds) {
  const ffmpegBin = process.env.FFMPEG_PATH || 'ffmpeg';
  try {
    await execFileAsync(
      ffmpegBin,
      ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
        '-t', String(seconds + 1), '-i', url, '-an', '-c:v', 'copy', filePath],
      { timeout: 180_000, maxBuffer: 10 * 1024 * 1024 },
    );
  } catch (err) {
    const detail = String(err.stderr || err.message).trim().split('\n').pop();
    throw new Error(`no se pudo descargar el video (HLS): ${detail}`);
  }
  return { path: filePath };
}

/**
 * Último recurso: descargar un video con yt-dlp (solo los primeros segundos).
 * @param {string} url
 * @param {string} workDir
 * @param {{ ytdlpPath: string, maxSeconds: number, maxBytes: number }} opts
 * @returns {Promise<string>} ruta del archivo descargado
 */
export async function downloadWithYtDlp(url, workDir, { ytdlpPath, maxSeconds, maxBytes }) {
  const prefix = `ytdlp-${Date.now()}`;
  try {
    await execFileAsync(
      ytdlpPath,
      [
        '--no-playlist',
        '--no-warnings',
        '--quiet',
        '-f', 'bv*[height<=720][ext=mp4]/bv*[height<=720]/b[height<=720]/bv*/b',
        '--download-sections', `*0-${Math.ceil(maxSeconds) + 1}`,
        '--max-filesize', String(maxBytes),
        '-o', join(workDir, `${prefix}.%(ext)s`),
        url,
      ],
      { timeout: 240_000, maxBuffer: 10 * 1024 * 1024 },
    );
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new Error('yt-dlp no está instalado (se necesita para este enlace).');
    }
    const detail = String(err.stderr || err.message).trim().split('\n').pop();
    throw new Error(`yt-dlp no pudo descargar el enlace: ${detail}`);
  }
  const files = (await readdir(workDir)).filter(
    (name) => name.startsWith(prefix) && !name.endsWith('.part'),
  );
  if (files.length === 0) throw new Error('yt-dlp no descargó ningún archivo.');
  const path = join(workDir, files[0]);
  if ((await stat(path)).size === 0) throw new Error('yt-dlp descargó un archivo vacío.');
  return path;
}

/**
 * Intenta adivinar la extensión de un archivo a partir de su URL.
 * @param {string} url
 * @param {string} fallback
 */
export function guessExt(url, fallback) {
  try {
    const u = new URL(url);
    const format = u.searchParams.get('format');
    if (format) return format.toLowerCase();
    const ext = extname(u.pathname).slice(1).toLowerCase();
    return ext || fallback;
  } catch {
    return fallback;
  }
}

function toMb(bytes) {
  return (bytes / 1024 / 1024).toFixed(1);
}
