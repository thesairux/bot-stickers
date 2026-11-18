import { downloadMediaMessage, generateMessageIDV2, isJidGroup, proto } from 'baileys';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkAccess, isAllowedNumber, isRegularChat, isSelfChat, senderPhone } from './access.js';
import { createLimiter, createRateLimiter } from './limiter.js';
import { getMediaInfo, getQuotedMessage, getText, parseCommand, unwrap } from './messages.js';
import { fetchLinkMedia, findLink } from './sources/index.js';
import { convertToSticker } from './sticker.js';

/** Mensajes "append" más viejos que esto se ignoran (no procesar historial). */
const MAX_APPEND_AGE_SECONDS = 10 * 60;

/**
 * ¿Hay que procesar este evento messages.upsert?
 * - "notify": mensajes nuevos en tiempo real → sí.
 * - "append": llegan así los mensajes que mandaste mientras el bot se
 *   conectaba; se procesan solo si son recientes.
 * @param {string} type
 * @param {{ messageTimestamp?: any }} msg
 * @param {number} [nowSeconds]
 */
export function shouldHandleUpsert(type, msg, nowSeconds = Date.now() / 1000) {
  if (type === 'notify') return true;
  if (type !== 'append') return false;
  const ts = toNumber(msg?.messageTimestamp);
  return ts > 0 && nowSeconds - ts <= MAX_APPEND_AGE_SECONDS;
}

/** Describe lo que llegó, para los mensajes de la consola. */
function describeInput(content, text, command) {
  if (content.imageMessage) return 'una foto';
  if (content.videoMessage) return content.videoMessage.gifPlayback ? 'un GIF' : 'un video';
  if (getMediaInfo(content)) return 'un archivo';
  if (command) return `el comando ${text.split(/\s+/)[0]}`;
  const link = findLink(text);
  if (link) return `un enlace de ${link.platform === 'twitter' ? 'X' : 'Pinterest'}`;
  return null;
}

/**
 * Texto de ayuda.
 * @param {ReturnType<typeof import('./config.js').loadConfig>} config
 * @param {{ auto?: boolean }} [opts]  auto = en este chat convierte sin comando
 */
export function helpText(config, { auto = false } = {}) {
  if (auto) {
    const lines = [
      '🤖 *Bot de Stickers*',
      '',
      'Mándame cualquiera de estas cosas y te devuelvo el sticker:',
      '• 📷 Una foto',
      `• 🎥 Un video o GIF (se usan los primeros ${config.maxVideoSeconds} s)`,
      '• 🐦 Un enlace de X / Twitter',
      '• 📌 Un enlace de Pinterest',
      '',
      '✂️ Escribe *recortar* junto a la foto o el enlace para que el sticker llene todo el cuadrado.',
    ];
    if (config.publicCommands) lines.push('👥 En grupos: responde *.sticker* a una foto, video o enlace.');
    return lines.join('\n');
  }
  return [
    '🤖 *Bot de Stickers*',
    '',
    '*Cómo pedir un sticker*',
    '• Manda una foto, video o GIF con *.sticker* en el texto',
    '• Responde *.sticker* a una foto, video, GIF o enlace',
    '• *.sticker* + un enlace de X / Twitter o Pinterest',
    '',
    '*Opciones*',
    `• De los videos se usan los primeros ${config.maxVideoSeconds} s.`,
    '• *.sticker recortar* → llena todo el cuadrado (sin bordes transparentes).',
    '• *.id* muestra el ID de este chat.',
  ].join('\n');
}

/** Conjunto con tamaño máximo (para recordar los mensajes que mandó el bot). */
class RecentSet {
  constructor(max = 1000) {
    this.max = max;
    this.items = new Set();
  }
  add(value) {
    if (!value) return;
    this.items.add(value);
    if (this.items.size > this.max) this.items.delete(this.items.values().next().value);
  }
  has(value) {
    return this.items.has(value);
  }
}

/**
 * Crea la función que procesa cada mensaje entrante.
 * Las dependencias se pueden reemplazar en los tests.
 *
 * @param {{
 *   getSock: () => any,
 *   config: ReturnType<typeof import('./config.js').loadConfig>,
 *   log?: Pick<Console, 'log' | 'warn' | 'error'>,
 *   downloadMedia?: (msg: any) => Promise<Buffer>,
 *   fetchLink?: typeof fetchLinkMedia,
 *   convert?: typeof convertToSticker,
 * }} deps
 */
export function createHandler(deps) {
  const { getSock, config, log = console } = deps;
  const convert = deps.convert || convertToSticker;
  const fetchLink = deps.fetchLink || fetchLinkMedia;
  const downloadMedia =
    deps.downloadMedia ||
    ((msg) => {
      const sock = getSock();
      return downloadMediaMessage(msg, 'buffer', {}, {
        logger: sock.logger,
        reuploadRequest: sock.updateMediaMessage,
      });
    });

  const limit = createLimiter(config.concurrency);
  const sentByBot = new RecentSet();
  const warnedChats = new RecentSet(200);
  const warnedStubs = new RecentSet(200);
  const publicLimiter = createRateLimiter(config.publicRateLimit ?? 5, 60_000);
  const greetedChats = new RecentSet(5000);
  const note = (text) => {
    if (config.logMessages !== false) log.log(`[bot] ${text}`);
  };

  /**
   * Envía un mensaje anotando su ID ANTES de mandarlo, para reconocerlo
   * si WhatsApp nos lo devuelve y no responderle al propio bot.
   */
  async function send(chat, content, quoted) {
    const sock = getSock();
    const messageId = generateMessageIDV2(sock.user?.id);
    sentByBot.add(messageId);
    const sent = await sock.sendMessage(chat, content, { messageId, ...(quoted ? { quoted } : {}) });
    sentByBot.add(sent?.key?.id);
    return sent;
  }

  async function react(chat, key, emoji) {
    try {
      await send(chat, { react: { text: emoji, key } });
    } catch {
      // las reacciones no son importantes
    }
  }

  /**
   * Arma la lista de "trabajos" (qué convertir) para el mensaje.
   * @returns {{ type: 'media', msg: any, info: { animated: boolean, ext: string }, size: number } |
   *           { type: 'link', link: any } | null}
   */
  function resolveTarget(msg, content, text, command) {
    const media = getMediaInfo(content);
    if (media) return { type: 'media', msg, info: media, size: mediaSize(content) };

    if (command === 'sticker') {
      const quoted = getQuotedMessage(msg, content);
      if (quoted) {
        const quotedContent = unwrap(quoted.message);
        const quotedMedia = getMediaInfo(quotedContent);
        if (quotedMedia) {
          return { type: 'media', msg: { ...quoted, message: quotedContent }, info: quotedMedia, size: mediaSize(quotedContent) };
        }
        const quotedLink = findLink(getText(quotedContent));
        if (quotedLink) return { type: 'link', link: quotedLink };
      }
    }

    const link = findLink(text);
    if (link) return { type: 'link', link };
    return null;
  }

  /**
   * Descarga y convierte; devuelve cuántos stickers se enviaron.
   */
  async function makeStickers(chat, msg, target, fit) {
    const workDir = await mkdtemp(join(tmpdir(), 'botstk-'));
    try {
      /** @type {Array<{ animated: boolean, path: string, ext: string }>} */
      let items;
      if (target.type === 'media') {
        if (target.size > config.maxDownloadBytes) {
          throw new Error(`el archivo es muy pesado (máximo ${Math.round(config.maxDownloadBytes / 1048576)} MB)`);
        }
        const buffer = await downloadMedia(target.msg);
        const path = join(workDir, `wa.${target.info.ext}`);
        await writeFile(path, buffer);
        items = [{ ...target.info, path }];
      } else {
        items = await fetchLink(target.link, {
          workDir,
          maxSeconds: config.maxVideoSeconds,
          maxBytes: config.maxDownloadBytes,
          maxItems: config.maxStickersPerMessage,
          ytdlpPath: config.ytdlpPath,
        });
      }

      let sent = 0;
      for (const item of items.slice(0, config.maxStickersPerMessage)) {
        const sticker = await convert({ path: item.path }, {
          animated: item.animated,
          ext: item.ext,
          fit,
          packName: config.packName,
          author: config.author,
          maxVideoSeconds: config.maxVideoSeconds,
        });
        await send(chat, { sticker }, msg);
        sent += 1;
      }
      return sent;
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }

  /**
   * @param {import('baileys').proto.IWebMessageInfo} msg
   */
  return async function handleMessage(msg) {
    const chat = msg?.key?.remoteJid;
    if (!chat) return;
    if (sentByBot.has(msg.key.id)) return;
    const sock = getSock();

    if (!msg.message) {
      // Mensaje que no se pudo descifrar (pasa a veces justo después de vincular).
      const isCiphertext = msg.messageStubType === proto.WebMessageInfo.StubType.CIPHERTEXT;
      if (isCiphertext && (msg.key.fromMe || isSelfChat(chat, sock.user)) && !warnedStubs.has(msg.key.id)) {
        warnedStubs.add(msg.key.id);
        note('⚠️ Me llegó un mensaje tuyo que todavía no puedo leer (pasa justo después de vincular). ' +
          'WhatsApp lo reenvía solo; si en unos segundos no hay sticker, mándalo otra vez.');
      }
      return;
    }

    const content = unwrap(msg.message);
    if (!content) return;
    if (content.stickerMessage || content.reactionMessage || content.protocolMessage) return;

    const text = getText(content);
    const { command, crop } = parseCommand(text);

    const access = await checkAccess(msg, sock, config);
    const what = describeInput(content, text, command);

    if (command === 'id') {
      const phone = access.phone ?? (await senderPhone(msg.key, sock));
      log.log(`[bot] !id → chat ${chat}${phone ? ` (número ${phone})` : ''}`);
      // Solo respondemos a ti o a números/grupos permitidos, para no
      // contestarle a cualquiera si el bot corre en tu número personal.
      if (access.allowed || msg.key.fromMe || isAllowedNumber(phone, config)) {
        const lines = [`🆔 ID de este chat:\n${chat}`];
        if (phone) lines.push(`📱 Tu número: ${phone}`);
        await send(chat, { text: lines.join('\n\n') }, msg);
      }
      return;
    }

    // Automático (sin comando): tu chat "Mensaje para ti", ALLOWED_NUMBERS y ALLOWED_GROUPS.
    // Con comando (.sticker / .ayuda): tú en cualquier chat y, si PUBLIC_COMMANDS=true, cualquiera.
    let allowed = access.allowed;
    let isPublic = false;
    if (!allowed && (command === 'sticker' || command === 'help') && isRegularChat(chat)) {
      if (msg.key.fromMe) {
        allowed = true;
      } else if (config.publicCommands) {
        allowed = true;
        isPublic = true;
      }
    }

    if (!allowed) {
      if (what && !warnedChats.has(chat)) {
        warnedChats.add(chat);
        const tip = config.publicCommands ? ' (igual puede pedir stickers escribiendo .sticker)' : '';
        if (isJidGroup(chat)) {
          note(`Ignoré ${what} en el grupo ${chat}: no está en ALLOWED_GROUPS${tip}.`);
        } else if (msg.key.fromMe) {
          note(`Ignoré ${what} que mandaste a otro chat (${chat}). Para stickers usa "Mensaje para ti" o escribe .sticker.`);
        } else {
          log.log(
            `[bot] Ignoré un mensaje de ${access.phone || chat}. ` +
              `Si quieres que el bot le responda siempre, agrégalo a ALLOWED_NUMBERS${tip}.`,
          );
        }
      }
      return;
    }

    if (what) {
      const where = isSelfChat(chat, sock.user)
        ? 'en tu chat "Mensaje para ti"'
        : isJidGroup(chat) ? `en el grupo ${chat}` : msg.key.fromMe ? `tuyo en ${chat}` : `de ${access.phone || chat}`;
      note(`📩 Recibí ${what} ${where}.`);
    }

    if (command === 'help') {
      await send(chat, { text: helpText(config, { auto: access.allowed }) }, msg);
      return;
    }

    const target = resolveTarget(msg, content, text, command);
    if (!target) {
      if (command === 'sticker') {
        await send(chat, { text: 'Responde *.sticker* a una foto, video o enlace, o mándalos con *.sticker* en el texto.' }, msg);
      } else if (access.allowed && text && !msg.key.fromMe && !isJidGroup(chat) && !greetedChats.has(chat)) {
        // Alguien escribió "hola" (u otro texto): le explicamos una vez qué mandar.
        greetedChats.add(chat);
        await send(chat, { text: helpText(config, { auto: true }) }, msg);
      }
      return;
    }

    // Límite por persona para quien no está en tus listas (ALLOW_EVERYONE o .sticker público).
    if (isPublic || access.everyone) {
      const who = access.phone || (await senderPhone(msg.key, sock)) || msg.key.participant || chat;
      const verdict = publicLimiter.take(who);
      if (verdict !== 'ok') {
        note(`⏳ ${who} pidió demasiados stickers seguidos; lo ignoro por un minuto.`);
        if (verdict === 'limited-first') {
          await send(chat, { text: '⏳ Vas muy rápido. Espera un minuto y vuelve a intentarlo 🙏' }, msg).catch(() => {});
        }
        return;
      }
    }

    await react(chat, msg.key, '⏳');
    try {
      const count = await limit(() => makeStickers(chat, msg, target, crop ? 'crop' : 'contain'));
      await react(chat, msg.key, '✅');
      note(`✅ Listo: envié ${count === 1 ? '1 sticker' : `${count} stickers`}.`);
    } catch (err) {
      log.error('[bot] Error creando sticker:', err);
      await react(chat, msg.key, '❌');
      await send(chat, { text: `😕 No pude crear el sticker: ${err.message}` }, msg).catch(() => {});
    }
  };
}

function mediaSize(content) {
  const media = content.imageMessage || content.videoMessage || content.documentMessage;
  return toNumber(media?.fileLength);
}

/** Número normal a partir de un número o un Long de protobuf. */
function toNumber(value) {
  if (!value) return 0;
  return typeof value === 'object' && typeof value.toNumber === 'function' ? value.toNumber() : Number(value);
}
