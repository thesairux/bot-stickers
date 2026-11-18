import { normalizeMessageContent } from 'baileys';

/**
 * Saca el contenido real del mensaje (quita envoltorios de mensajes
 * temporales, "ver una vez", editados, documentos con texto, etc.).
 * @param {import('baileys').proto.IMessage | null | undefined} message
 */
export function unwrap(message) {
  return normalizeMessageContent(message) || null;
}

/**
 * Texto o pie de foto del mensaje.
 * @param {import('baileys').proto.IMessage} content
 */
export function getText(content) {
  return (
    content?.conversation ||
    content?.extendedTextMessage?.text ||
    content?.imageMessage?.caption ||
    content?.videoMessage?.caption ||
    content?.documentMessage?.caption ||
    ''
  ).trim();
}

/**
 * Si el mensaje trae una foto/video/GIF convertible, dice cómo tratarlo.
 * @param {import('baileys').proto.IMessage} content
 * @returns {{ animated: boolean, ext: string } | null}
 */
export function getMediaInfo(content) {
  if (!content) return null;
  if (content.imageMessage) {
    return { animated: false, ext: 'jpg' };
  }
  if (content.videoMessage) {
    // Los GIF de WhatsApp en realidad son videos mp4 con gifPlayback=true.
    return { animated: true, ext: 'mp4' };
  }
  if (content.documentMessage) {
    const mime = content.documentMessage.mimetype || '';
    if (mime === 'image/gif') return { animated: true, ext: 'gif' };
    if (mime.startsWith('image/')) return { animated: false, ext: mime.split('/')[1] || 'png' };
    if (mime.startsWith('video/')) return { animated: true, ext: 'mp4' };
  }
  return null;
}

/**
 * Devuelve el contextInfo del mensaje (donde viene la cita/respuesta).
 * @param {import('baileys').proto.IMessage} content
 */
function getContextInfo(content) {
  for (const value of Object.values(content || {})) {
    if (value && typeof value === 'object' && value.contextInfo) return value.contextInfo;
  }
  return null;
}

/**
 * Si el mensaje responde (cita) a otro, arma un WAMessage con el citado
 * para poder descargar su contenido.
 * @param {import('baileys').proto.IWebMessageInfo} msg
 * @param {import('baileys').proto.IMessage} content
 * @returns {import('baileys').proto.IWebMessageInfo | null}
 */
export function getQuotedMessage(msg, content) {
  const ctx = getContextInfo(content);
  if (!ctx?.quotedMessage) return null;
  return {
    key: {
      remoteJid: msg.key.remoteJid,
      id: ctx.stanzaId,
      participant: ctx.participant,
      fromMe: false,
    },
    message: ctx.quotedMessage,
  };
}

/** Prefijos aceptados para los comandos: !sticker, .sticker o /sticker */
const PREFIXES = ['!', '.', '/'];
const COMMANDS = {
  help: ['ayuda', 'help', 'menu', 'start'],
  id: ['id'],
  sticker: ['s', 'sticker', 'stiker', 'stk'],
};

/**
 * Interpreta comandos y opciones del texto.
 * @param {string} text
 * @returns {{ command: 'help' | 'id' | 'sticker' | null, crop: boolean }}
 */
export function parseCommand(text) {
  const lower = text.toLowerCase().trim();
  const first = lower.split(/\s+/)[0] || '';
  const crop = /(^|\s)(recortar|recorte|crop|cuadrado)(\s|$)/.test(lower);

  if (PREFIXES.includes(first[0])) {
    const word = first.slice(1);
    for (const [command, words] of Object.entries(COMMANDS)) {
      if (words.includes(word)) return { command, crop };
    }
  }
  return { command: null, crop };
}
