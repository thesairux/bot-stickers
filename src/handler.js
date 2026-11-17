import { downloadMediaMessage } from 'baileys';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkAccess, isAllowedNumber, senderPhone } from './access.js';
import { createLimiter } from './limiter.js';
import { getMediaInfo, getQuotedMessage, getText, parseCommand, unwrap } from './messages.js';
import { fetchLinkMedia, findLink } from './sources/index.js';
import { convertToSticker } from './sticker.js';

export function helpText(config) {
  return [
    '🤖 *Bot de Stickers*',
    '',
    'Mándame cualquiera de estas cosas y te devuelvo el sticker:',
    '• 📷 Una foto',
    `• 🎥 Un video o GIF (se usan los primeros ${config.maxVideoSeconds} s)`,
    '• 🐦 Un enlace de X / Twitter',
    '• 📌 Un enlace de Pinterest (pinterest.com/pin/… o pin.it/…)',
    '',
    '*Opciones*',
    '• Escribe *recortar* en el pie de foto o junto al enlace para que el sticker llene todo el cuadrado (sin bordes transparentes).',
    '• Responde a una foto, video o enlace con *!s* para convertirlo.',
    '• *!id* muestra el ID de este chat (para configurar grupos).',
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

  async function send(chat, content, quoted) {
    const sent = await getSock().sendMessage(chat, content, quoted ? { quoted } : undefined);
    sentByBot.add(sent?.key?.id);
    return sent;
  }

  async function react(chat, key, emoji) {
    try {
      await getSock().sendMessage(chat, { react: { text: emoji, key } });
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
    if (!chat || !msg.message) return;
    if (sentByBot.has(msg.key.id)) return;

    const content = unwrap(msg.message);
    if (!content) return;
    if (content.stickerMessage || content.reactionMessage || content.protocolMessage) return;

    const text = getText(content);
    const { command, crop } = parseCommand(text);
    const sock = getSock();

    const access = await checkAccess(msg, sock, config);

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

    if (!access.allowed) {
      const wouldProcess = command || getMediaInfo(content) || findLink(text);
      if (wouldProcess && !msg.key.fromMe && !warnedChats.has(chat)) {
        warnedChats.add(chat);
        log.log(
          `[bot] Ignoré un mensaje de ${access.phone || chat}. ` +
            'Si quieres que el bot le responda, agrégalo a ALLOWED_NUMBERS (o el grupo a ALLOWED_GROUPS).',
        );
      }
      return;
    }

    if (command === 'help') {
      await send(chat, { text: helpText(config) }, msg);
      return;
    }

    const target = resolveTarget(msg, content, text, command);
    if (!target) {
      if (command === 'sticker') {
        await send(chat, { text: 'Responde con *!s* a una foto, video o enlace (o mándamelo directo).' }, msg);
      }
      return;
    }

    await react(chat, msg.key, '⏳');
    try {
      await limit(() => makeStickers(chat, msg, target, crop ? 'crop' : 'contain'));
      await react(chat, msg.key, '✅');
    } catch (err) {
      log.error('[bot] Error creando sticker:', err);
      await react(chat, msg.key, '❌');
      await send(chat, { text: `😕 No pude crear el sticker: ${err.message}` }, msg).catch(() => {});
    }
  };
}

function mediaSize(content) {
  const media = content.imageMessage || content.videoMessage || content.documentMessage;
  const length = media?.fileLength;
  if (!length) return 0;
  // Puede venir como número o como Long de protobuf.
  return typeof length === 'object' && typeof length.toNumber === 'function' ? length.toNumber() : Number(length);
}
