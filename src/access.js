import { isJidGroup, isLidUser, isPnUser, jidDecode } from 'baileys';

/**
 * Parte "usuario" de un JID: '5215512345678:3@s.whatsapp.net' → '5215512345678'.
 * @param {string | null | undefined} jid
 */
export function jidUser(jid) {
  if (!jid) return '';
  return jidDecode(jid)?.user || '';
}

/**
 * ¿Es el chat "Mensaje para ti" (tu propio número)?
 * @param {string} chatJid
 * @param {{ id?: string, lid?: string } | undefined} me  sock.user
 */
export function isSelfChat(chatJid, me) {
  if (!chatJid || !me) return false;
  const user = jidUser(chatJid);
  return Boolean(user) && (user === jidUser(me.id) || user === jidUser(me.lid));
}

/**
 * Compara dos números (solo dígitos). Acepta que coincidan los últimos 10
 * dígitos para tolerar diferencias como el "1" de México (521… vs 52…)
 * o el "9" de Argentina (549… vs 54…).
 * @param {string} a
 * @param {string} b
 */
export function samePhone(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  return a.length >= 10 && b.length >= 10 && a.slice(-10) === b.slice(-10);
}

/**
 * Obtiene el número de teléfono (solo dígitos) de quien escribe.
 * Con las cuentas nuevas de WhatsApp el remitente puede venir como "@lid"
 * (identificador anónimo), así que buscamos el número real en remoteJidAlt /
 * participantAlt o en el mapa LID→número de Baileys.
 * @param {import('baileys').WAMessageKey} key
 * @param {any} sock
 * @returns {Promise<string>}
 */
export async function senderPhone(key, sock) {
  const candidates = isJidGroup(key.remoteJid)
    ? [key.participant, key.participantAlt]
    : [key.remoteJid, key.remoteJidAlt];
  for (const jid of candidates) {
    if (jid && isPnUser(jid)) return jidUser(jid);
  }
  const lid = candidates.find((jid) => jid && isLidUser(jid));
  if (lid && sock?.signalRepository?.lidMapping) {
    try {
      const pn = await sock.signalRepository.lidMapping.getPNForLID(lid);
      if (pn) return jidUser(pn);
    } catch {
      // sin mapeo disponible
    }
  }
  return '';
}

/**
 * Decide si el bot debe atender este mensaje.
 *
 * - Chat "Mensaje para ti" (si el bot corre en TU número): sí, si RESPOND_IN_SELF_CHAT.
 * - Grupos: solo los que estén en ALLOWED_GROUPS.
 * - Chats privados: números en ALLOWED_NUMBERS, o todos si ALLOW_EVERYONE=true.
 * - Nunca responde a lo que TÚ mandas a otras personas.
 *
 * @param {import('baileys').proto.IWebMessageInfo} msg
 * @param {any} sock
 * @param {ReturnType<typeof import('./config.js').loadConfig>} config
 * @returns {Promise<{ allowed: boolean, phone?: string }>}
 */
export async function checkAccess(msg, sock, config) {
  const chat = msg.key?.remoteJid;
  if (!isRegularChat(chat)) {
    return { allowed: false };
  }

  if (isJidGroup(chat)) {
    return { allowed: config.allowedGroups.includes(chat) };
  }

  if (msg.key.fromMe) {
    return { allowed: config.respondInSelfChat && isSelfChat(chat, sock.user) };
  }

  const phone = await senderPhone(msg.key, sock);
  if (config.allowEveryone) {
    // "everyone": entró solo por ALLOW_EVERYONE (no está en tu lista) → se le aplica el límite.
    return { allowed: true, phone, everyone: !isAllowedNumber(phone, config) };
  }
  return { allowed: isAllowedNumber(phone, config), phone };
}

/**
 * ¿Es un chat normal (privado o grupo)? Excluye estados, listas de difusión y canales.
 * @param {string | null | undefined} chat
 */
export function isRegularChat(chat) {
  return Boolean(chat) && chat !== 'status@broadcast' && !chat.endsWith('@broadcast') && !chat.endsWith('@newsletter');
}

/**
 * @param {string} phone
 * @param {{ allowedNumbers: string[] }} config
 */
export function isAllowedNumber(phone, config) {
  return config.allowedNumbers.some((allowed) => samePhone(allowed, phone));
}
