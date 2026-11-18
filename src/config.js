import 'dotenv/config';

/**
 * Convierte "a, b ,c" en ['a', 'b', 'c'].
 * @param {string | undefined} raw
 * @returns {string[]}
 */
export function parseList(raw) {
  if (!raw) return [];
  return raw
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

/**
 * @param {string | undefined} raw
 * @param {boolean} fallback
 */
export function parseBool(raw, fallback) {
  if (raw === undefined || raw.trim() === '') return fallback;
  return ['1', 'true', 'si', 'sí', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

/**
 * @param {string | undefined} raw
 * @param {number} fallback
 * @param {number} min
 */
function parseNumber(raw, fallback, min) {
  const n = Number(raw);
  if (!Number.isFinite(n) || raw === undefined || raw.trim() === '') return fallback;
  return Math.max(min, n);
}

/** Deja solo los dígitos de un número de teléfono (+52 1 55-1234 → 52155...). */
export function onlyDigits(value) {
  return String(value || '').replace(/\D/g, '');
}

/**
 * Lee la configuración del bot desde variables de entorno.
 * @param {NodeJS.ProcessEnv} env
 */
export function loadConfig(env = process.env) {
  return {
    packName: env.STICKER_PACK_NAME || 'Bot Stickers',
    author: env.STICKER_AUTHOR || 'bot-stickers',

    // Quién puede usar el bot
    allowedNumbers: parseList(env.ALLOWED_NUMBERS).map(onlyDigits).filter(Boolean),
    allowedGroups: parseList(env.ALLOWED_GROUPS),
    allowEveryone: parseBool(env.ALLOW_EVERYONE, false),
    // Cualquiera puede pedir stickers escribiendo .sticker (en privado o en grupos)
    publicCommands: parseBool(env.PUBLIC_COMMANDS, true),
    // Máximo de stickers por minuto por persona fuera de tus listas (0 = sin límite)
    publicRateLimit: parseNumber(env.PUBLIC_RATE_LIMIT, 0, 0),
    respondInSelfChat: parseBool(env.RESPOND_IN_SELF_CHAT, true),

    // Conexión
    authDir: env.AUTH_DIR || 'auth_info',
    // Foto de perfil del bot (vacío = no tocarla)
    profilePicture: env.PROFILE_PICTURE ?? 'assets/profile.jpg',
    // Descripción ("Info") del perfil del bot (vacío = no tocarla)
    profileStatus: env.PROFILE_STATUS ?? 'stickers :D made by triton',
    pairingNumber: onlyDigits(env.PAIRING_NUMBER),

    // Límites de conversión / descarga
    maxVideoSeconds: parseNumber(env.MAX_VIDEO_SECONDS, 8, 1),
    maxDownloadBytes: parseNumber(env.MAX_DOWNLOAD_MB, 60, 1) * 1024 * 1024,
    maxStickersPerMessage: parseNumber(env.MAX_STICKERS_PER_MESSAGE, 6, 1),
    concurrency: parseNumber(env.CONCURRENCY, 2, 1),

    ytdlpPath: env.YTDLP_PATH || 'yt-dlp',
    logLevel: env.LOG_LEVEL || 'warn',
    // Mostrar en la consola qué mensajes recibe y por qué ignora alguno
    logMessages: parseBool(env.LOG_MESSAGES, true),
  };
}

export const config = loadConfig();
