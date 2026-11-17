import { BROWSER_UA, guessExt } from '../download.js';

const TWITTER_REGEX =
  /https?:\/\/(?:www\.|mobile\.)?(?:x|twitter|fxtwitter|vxtwitter|fixupx|fixvx)\.com\/(?:i\/web|([A-Za-z0-9_]{1,15}))\/status(?:es)?\/(\d+)/i;

/**
 * @typedef {{ kind: 'image' | 'video', url: string, ext: string, hls?: boolean }} MediaRef
 */

/**
 * Busca el primer enlace de un tweet dentro de un texto.
 * @param {string} text
 * @returns {{ platform: 'twitter', url: string, user: string, id: string } | null}
 */
export function matchTwitter(text) {
  const m = text?.match(TWITTER_REGEX);
  if (!m) return null;
  return { platform: 'twitter', url: m[0], user: m[1] || 'i', id: m[2] };
}

/**
 * Elige la variante mp4 más liviana que tenga al menos 512px de lado mayor.
 * Twitter pone la resolución en la URL: .../vid/avc1/640x360/xxx.mp4
 * @param {Array<{ url?: string, content_type?: string, bitrate?: number }> | undefined} variants
 * @param {string | undefined} fallbackUrl
 */
export function pickTwitterVariant(variants, fallbackUrl) {
  const mp4s = (variants || [])
    .filter((v) => v?.url && (v.content_type === 'video/mp4' || /\.mp4(\?|$)/.test(v.url)))
    .map((v) => {
      const res = v.url.match(/\/(\d{2,4})x(\d{2,4})\//);
      const side = res ? Math.max(Number(res[1]), Number(res[2])) : 0;
      return { url: v.url, side, bitrate: v.bitrate || 0 };
    });
  if (mp4s.length === 0) return fallbackUrl;
  const bigEnough = mp4s
    .filter((v) => v.side >= 512)
    .sort((a, b) => a.side - b.side || a.bitrate - b.bitrate);
  if (bigEnough.length > 0) return bigEnough[0].url;
  return mp4s.sort((a, b) => b.side - a.side || b.bitrate - a.bitrate)[0].url;
}

/**
 * Convierte la respuesta de api.fxtwitter.com a MediaRefs.
 * Si el tweet no tiene medios pero cita otro tweet que sí, usa los del citado.
 * @param {any} data
 * @returns {MediaRef[]}
 */
export function parseFxTwitter(data) {
  const tweet = data?.tweet;
  let media = tweet?.media?.all || [];
  if (media.length === 0) media = tweet?.quote?.media?.all || [];
  const refs = [];
  for (const item of media) {
    if (!item?.url) continue;
    if (item.type === 'photo') {
      refs.push({ kind: 'image', url: item.url, ext: guessExt(item.url, 'jpg') });
    } else if (item.type === 'video' || item.type === 'gif') {
      const url = pickTwitterVariant(item.variants, item.url);
      refs.push({ kind: 'video', url, ext: 'mp4' });
    }
  }
  return refs;
}

/**
 * Convierte la respuesta de api.vxtwitter.com a MediaRefs.
 * @param {any} data
 * @returns {MediaRef[]}
 */
export function parseVxTwitter(data) {
  let media = data?.media_extended || [];
  if (media.length === 0) media = data?.qrt?.media_extended || [];
  const refs = [];
  for (const item of media) {
    if (!item?.url) continue;
    if (item.type === 'image') {
      refs.push({ kind: 'image', url: item.url, ext: guessExt(item.url, 'jpg') });
    } else if (item.type === 'video' || item.type === 'gif') {
      refs.push({ kind: 'video', url: item.url, ext: 'mp4' });
    }
  }
  return refs;
}

async function getJson(url, fetchImpl) {
  const res = await fetchImpl(url, {
    headers: { 'User-Agent': BROWSER_UA, Accept: 'application/json' },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/**
 * Obtiene las fotos/videos/GIFs de un tweet usando las APIs públicas de
 * FxTwitter y, si falla, VxTwitter. Devuelve [] si no encontró nada
 * (el llamador puede intentar con yt-dlp).
 * @param {{ user: string, id: string }} link
 * @param {{ fetchImpl?: typeof fetch }} [opts]
 * @returns {Promise<MediaRef[]>}
 */
export async function extractTwitter(link, { fetchImpl = fetch } = {}) {
  const attempts = [
    [`https://api.fxtwitter.com/${link.user}/status/${link.id}`, parseFxTwitter],
    [`https://api.vxtwitter.com/${link.user}/status/${link.id}`, parseVxTwitter],
  ];
  for (const [url, parse] of attempts) {
    try {
      const refs = parse(await getJson(url, fetchImpl));
      if (refs.length > 0) return refs;
    } catch {
      // probamos con la siguiente API
    }
  }
  return [];
}
