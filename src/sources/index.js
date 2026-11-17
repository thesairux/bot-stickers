import { join } from 'node:path';
import { downloadHls, downloadToFile, downloadWithYtDlp } from '../download.js';
import { extractPinterest, matchPinterest } from './pinterest.js';
import { extractTwitter, matchTwitter } from './twitter.js';

/**
 * @typedef {{ platform: 'twitter' | 'pinterest', url: string, [k: string]: any }} Link
 * @typedef {{ animated: boolean, path: string, ext: string }} LocalMedia
 */

/**
 * Detecta si el texto trae un enlace soportado (X/Twitter o Pinterest).
 * @param {string} text
 * @returns {Link | null}
 */
export function findLink(text) {
  return matchTwitter(text) || matchPinterest(text);
}

const extractors = {
  twitter: extractTwitter,
  pinterest: extractPinterest,
};

/**
 * Descarga los medios de un enlace a la carpeta de trabajo.
 * @param {Link} link
 * @param {{
 *   workDir: string,
 *   maxSeconds: number,
 *   maxBytes: number,
 *   maxItems: number,
 *   ytdlpPath: string,
 *   fetchImpl?: typeof fetch,
 *   ytdlp?: typeof downloadWithYtDlp,
 * }} opts
 * @returns {Promise<LocalMedia[]>}
 */
export async function fetchLinkMedia(link, opts) {
  const { workDir, maxSeconds, maxBytes, maxItems, ytdlpPath, fetchImpl = fetch, ytdlp = downloadWithYtDlp } = opts;

  let refs = [];
  let extractError;
  try {
    refs = await extractors[link.platform](link, { fetchImpl });
  } catch (err) {
    extractError = err;
  }

  const results = [];
  for (const [i, ref] of refs.slice(0, maxItems).entries()) {
    const path = join(workDir, `link-${i}.${ref.ext}`);
    try {
      if (ref.hls) {
        await downloadHls(ref.url, path, maxSeconds);
      } else {
        await downloadToFile(ref.url, path, { maxBytes, fetchImpl });
      }
      results.push({ animated: ref.kind === 'video', path, ext: ref.ext });
    } catch (err) {
      extractError ??= err;
    }
  }
  if (results.length > 0) return results;

  // Plan C: yt-dlp (sirve para videos de X y de Pinterest).
  const pageUrl = link.platform === 'pinterest' && link.id
    ? `https://www.pinterest.com/pin/${link.id}/`
    : link.url;
  try {
    const path = await ytdlp(pageUrl, workDir, { ytdlpPath, maxSeconds, maxBytes });
    return [{ animated: true, path, ext: path.split('.').pop() || 'mp4' }];
  } catch (err) {
    const reason = extractError?.message || err.message;
    throw new Error(
      refs.length > 0
        ? `no pude descargar el contenido (${reason})`
        : `no encontré fotos ni videos en ese enlace (${reason})`,
    );
  }
}
