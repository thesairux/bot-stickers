import { BROWSER_UA, guessExt } from '../download.js';

const PIN_REGEX =
  /https?:\/\/(?:[a-z]{2,3}\.|www\.)?pinterest\.(?:com|ca|co\.uk|com\.mx|es|fr|de|it|pt|cl|co|com\.au|at|ch|jp|nz|ru|ie|nl|dk|ph|in|pe|com\.ar|com\.br|com\.pe|com\.ec|com\.uy|com\.py|com\.bo|mx|kr|co\.kr)\/pin\/(?:[\w-]*--)?(\d+)/i;
const SHORT_REGEX = /https?:\/\/(?:www\.)?pin\.it\/[A-Za-z0-9]+/i;

/**
 * @typedef {import('./twitter.js').MediaRef} MediaRef
 */

/**
 * Busca un enlace de Pinterest (pin completo o pin.it corto) en un texto.
 * @param {string} text
 * @returns {{ platform: 'pinterest', url: string, id?: string, short?: boolean } | null}
 */
export function matchPinterest(text) {
  if (!text) return null;
  const pin = text.match(PIN_REGEX);
  if (pin) return { platform: 'pinterest', url: pin[0], id: pin[1] };
  const short = text.match(SHORT_REGEX);
  if (short) return { platform: 'pinterest', url: short[0], short: true };
  return null;
}

/**
 * Sigue la redirección de un enlace pin.it y devuelve el ID del pin.
 * @param {string} shortUrl
 * @param {typeof fetch} fetchImpl
 */
export async function resolveShortLink(shortUrl, fetchImpl = fetch) {
  const res = await fetchImpl(shortUrl, {
    redirect: 'follow',
    headers: { 'User-Agent': BROWSER_UA },
    signal: AbortSignal.timeout(20_000),
  });
  const fromUrl = String(res.url || '').match(/\/pin\/(?:[\w-]*--)?(\d+)/);
  if (fromUrl) {
    await res.body?.cancel().catch(() => {});
    return fromUrl[1];
  }
  const body = await res.text().catch(() => '');
  const fromBody = body.match(/pinterest\.[a-z.]+\/pin\/(?:[\w-]*--)?(\d+)/i);
  if (fromBody) return fromBody[1];
  throw new Error('no pude abrir el enlace corto de Pinterest');
}

/**
 * De un video_list de Pinterest elige el mp4 más liviano con al menos 512px;
 * si solo hay HLS (.m3u8) devuelve ese.
 * @param {Record<string, any> | undefined} videoList
 * @returns {MediaRef | null}
 */
export function pickPinterestVideo(videoList) {
  if (!videoList || typeof videoList !== 'object') return null;
  const mp4s = [];
  let hls = null;
  for (const [key, v] of Object.entries(videoList)) {
    if (!v?.url) continue;
    if (/hls/i.test(key) || /\.m3u8(\?|$)/.test(v.url)) {
      hls ??= v.url;
    } else {
      mp4s.push({ url: v.url, side: Math.max(v.width || 0, v.height || 0) });
    }
  }
  if (mp4s.length > 0) {
    const bigEnough = mp4s.filter((v) => v.side >= 512).sort((a, b) => a.side - b.side);
    const chosen = bigEnough[0] || mp4s.sort((a, b) => b.side - a.side)[0];
    return { kind: 'video', url: chosen.url, ext: 'mp4' };
  }
  if (hls) return { kind: 'video', url: hls, ext: 'mp4', hls: true };
  return null;
}

/**
 * @param {any} images  objeto "images" de Pinterest ({ orig: {url}, '736x': {url}, ... })
 * @returns {MediaRef | null}
 */
function pickPinterestImage(images) {
  if (!images || typeof images !== 'object') return null;
  const best = images.orig || images.originals || images['1200x'] || images['736x'] ||
    Object.values(images).find((img) => img?.url);
  if (!best?.url) return null;
  const ext = guessExt(best.url, 'jpg');
  // Los GIF se tratan como animados.
  return { kind: ext === 'gif' ? 'video' : 'image', url: best.url, ext };
}

/**
 * Convierte el JSON de PinResource en MediaRefs.
 * Soporta pines de imagen, GIF, video y "idea pins" (story_pin_data con varias páginas).
 * @param {any} pin  resource_response.data
 * @returns {MediaRef[]}
 */
export function parsePinData(pin) {
  if (!pin || typeof pin !== 'object') return [];

  const video = pickPinterestVideo(pin.videos?.video_list);
  if (video) return [video];

  const pages = pin.story_pin_data?.pages;
  if (Array.isArray(pages) && pages.length > 0) {
    const refs = [];
    for (const page of pages) {
      for (const block of page?.blocks || []) {
        const ref = pickPinterestVideo(block?.video?.video_list) || pickPinterestImage(block?.image?.images);
        if (ref) refs.push(ref);
      }
    }
    if (refs.length > 0) return refs;
  }

  const image = pickPinterestImage(pin.images);
  return image ? [image] : [];
}

/**
 * Plan B: leer el HTML del pin y sacar el video o la imagen de ahí.
 * @param {string} html
 * @returns {MediaRef[]}
 */
export function parsePinHtml(html) {
  if (!html) return [];
  const unescape = (s) => s.replace(/\\u002F/g, '/').replace(/\\\//g, '/').replace(/&amp;/g, '&');

  const mp4 = html.match(/https?:\\?\/\\?\/v1\.pinimg\.com\\?\/videos\\?\/[^"'\s]+?\.mp4/);
  if (mp4) return [{ kind: 'video', url: unescape(mp4[0]), ext: 'mp4' }];

  const m3u8 = html.match(/https?:\\?\/\\?\/v1\.pinimg\.com\\?\/videos\\?\/[^"'\s]+?\.m3u8/);
  if (m3u8) return [{ kind: 'video', url: unescape(m3u8[0]), ext: 'mp4', hls: true }];

  // Si es un pin de video pero no encontramos el archivo, mejor no devolver
  // la miniatura: así el bot prueba con yt-dlp.
  if (/<meta[^>]+(?:property|name)=["']og:video/i.test(html)) return [];

  const og = metaContent(html, 'og:image');
  const orig = html.match(/https?:\\?\/\\?\/i\.pinimg\.com\\?\/originals\\?\/[^"'\s]+?\.(?:jpe?g|png|gif|webp)/i);
  const url = og ? unescape(og) : orig ? unescape(orig[0]) : null;
  if (!url) return [];
  const ext = guessExt(url, 'jpg');
  return [{ kind: ext === 'gif' ? 'video' : 'image', url, ext }];
}

function metaContent(html, property) {
  const a = new RegExp(`<meta[^>]+(?:property|name)=["']${property}["'][^>]+content=["']([^"']+)["']`, 'i');
  const b = new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${property}["']`, 'i');
  return (html.match(a) || html.match(b))?.[1] || null;
}

/**
 * Obtiene las imágenes/videos de un pin de Pinterest.
 * Primero usa la API interna (la misma que usa la web), luego el HTML.
 * @param {{ id?: string, url: string, short?: boolean }} link
 * @param {{ fetchImpl?: typeof fetch }} [opts]
 * @returns {Promise<MediaRef[]>}
 */
export async function extractPinterest(link, { fetchImpl = fetch } = {}) {
  const id = link.id || (await resolveShortLink(link.url, fetchImpl));
  link.id = id;

  try {
    const data = JSON.stringify({ options: { field_set_key: 'unauth_react_main_pin', id } });
    const res = await fetchImpl(
      `https://www.pinterest.com/resource/PinResource/get/?data=${encodeURIComponent(data)}`,
      {
        headers: {
          'User-Agent': BROWSER_UA,
          Accept: 'application/json',
          'X-Pinterest-PWS-Handler': 'www/[username].js',
        },
        signal: AbortSignal.timeout(20_000),
      },
    );
    if (res.ok) {
      const json = await res.json();
      const refs = parsePinData(json?.resource_response?.data);
      if (refs.length > 0) return refs;
    }
  } catch {
    // seguimos con el HTML
  }

  try {
    const res = await fetchImpl(`https://www.pinterest.com/pin/${id}/`, {
      headers: { 'User-Agent': BROWSER_UA, Accept: 'text/html' },
      signal: AbortSignal.timeout(20_000),
    });
    if (res.ok) return parsePinHtml(await res.text());
  } catch {
    // el llamador intentará con yt-dlp
  }
  return [];
}
