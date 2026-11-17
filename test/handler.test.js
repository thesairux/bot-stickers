import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkAccess, isSelfChat, samePhone, senderPhone } from '../src/access.js';
import { loadConfig } from '../src/config.js';
import { createHandler } from '../src/handler.js';
import { getMediaInfo, parseCommand, unwrap } from '../src/messages.js';

const ME = { id: '5215511112222:7@s.whatsapp.net', lid: '99887766:7@lid', name: 'Yo' };
const SELF_CHAT = '5215511112222@s.whatsapp.net';

/** WhatsApp falso: guarda todo lo que el bot envía. */
function fakeSock({ lidToPn = {} } = {}) {
  const sent = [];
  let n = 0;
  return {
    user: ME,
    sent,
    signalRepository: {
      lidMapping: { getPNForLID: async (lid) => lidToPn[lid] || null },
    },
    async sendMessage(jid, content, opts) {
      sent.push({ jid, content, quoted: opts?.quoted });
      n += 1;
      return { key: { id: `BOT${n}`, remoteJid: jid, fromMe: true } };
    },
  };
}

function setup(env = {}, overrides = {}) {
  const sock = fakeSock(overrides.sock);
  const config = loadConfig({ MAX_VIDEO_SECONDS: '8', ...env });
  const calls = { download: [], fetchLink: [], convert: [] };
  const logs = [];
  const handle = createHandler({
    getSock: () => sock,
    config,
    log: { log: (m) => logs.push(m), warn: (m) => logs.push(m), error: () => {} },
    downloadMedia: async (msg) => {
      calls.download.push(msg);
      if (overrides.downloadFails) throw new Error('falló la descarga');
      return Buffer.from('fake-image');
    },
    fetchLink: async (link, opts) => {
      calls.fetchLink.push({ link, opts });
      return overrides.linkItems || [
        { animated: false, path: `${opts.workDir}/a.jpg`, ext: 'jpg' },
        { animated: true, path: `${opts.workDir}/b.mp4`, ext: 'mp4' },
      ];
    },
    convert: async (input, opts) => {
      calls.convert.push({ input, opts });
      return Buffer.from('RIFF-webp');
    },
  });
  const stickers = () => sock.sent.filter((s) => s.content.sticker);
  const reactions = () => sock.sent.filter((s) => s.content.react).map((s) => s.content.react.text);
  const texts = () => sock.sent.filter((s) => s.content.text).map((s) => s.content.text);
  return { sock, config, calls, logs, handle, stickers, reactions, texts };
}

let idCounter = 0;
function msg({ chat = SELF_CHAT, fromMe = true, message, ...key }) {
  idCounter += 1;
  return { key: { remoteJid: chat, fromMe, id: `MSG${idCounter}`, ...key }, message };
}
const image = (caption) => ({ imageMessage: { caption, mimetype: 'image/jpeg', url: 'https://mmg/x' } });
const video = () => ({ videoMessage: { mimetype: 'video/mp4', url: 'https://mmg/v', fileLength: 1000 } });
const text = (t) => ({ conversation: t });

// ---------- Utilidades ----------

test('parseCommand reconoce comandos y la opción recortar', () => {
  assert.deepEqual(parseCommand('!ayuda'), { command: 'help', crop: false });
  assert.deepEqual(parseCommand('!S recortar'), { command: 'sticker', crop: true });
  assert.deepEqual(parseCommand('!id'), { command: 'id', crop: false });
  assert.deepEqual(parseCommand('hola Recortar'), { command: null, crop: true });
  assert.deepEqual(parseCommand('https://x.com/a/status/1'), { command: null, crop: false });
});

test('unwrap quita envoltorios de mensajes temporales y "ver una vez"', () => {
  const content = unwrap({ ephemeralMessage: { message: { viewOnceMessageV2: { message: image('hi') } } } });
  assert.ok(content.imageMessage);
  assert.deepEqual(getMediaInfo(content), { animated: false, ext: 'jpg' });
  assert.deepEqual(getMediaInfo({ documentMessage: { mimetype: 'image/gif' } }), { animated: true, ext: 'gif' });
  assert.deepEqual(getMediaInfo({ documentMessage: { mimetype: 'video/quicktime' } }), { animated: true, ext: 'mp4' });
  assert.equal(getMediaInfo({ documentMessage: { mimetype: 'application/pdf' } }), null);
});

test('samePhone tolera el 1 de México y el 9 de Argentina', () => {
  assert.ok(samePhone('5215512345678', '5215512345678'));
  assert.ok(samePhone('5215512345678', '525512345678'));
  assert.ok(samePhone('5491123456789', '541123456789'));
  assert.ok(!samePhone('5215512345678', '5215512345679'));
  assert.ok(!samePhone('', '123'));
});

test('isSelfChat reconoce tu propio chat por número o por LID', () => {
  assert.ok(isSelfChat('5215511112222@s.whatsapp.net', ME));
  assert.ok(isSelfChat('99887766@lid', ME));
  assert.ok(!isSelfChat('5215533334444@s.whatsapp.net', ME));
});

test('senderPhone obtiene el número aunque el chat venga como @lid', async () => {
  const sock = fakeSock({ lidToPn: { '555@lid': '5215599990000@s.whatsapp.net' } });
  assert.equal(await senderPhone({ remoteJid: '5215500001111@s.whatsapp.net' }, sock), '5215500001111');
  assert.equal(await senderPhone({ remoteJid: '123@lid', remoteJidAlt: '5215500002222@s.whatsapp.net' }, sock), '5215500002222');
  assert.equal(await senderPhone({ remoteJid: '555@lid' }, sock), '5215599990000');
  assert.equal(
    await senderPhone({ remoteJid: '1203630@g.us', participant: '7@lid', participantAlt: '5215500003333@s.whatsapp.net' }, sock),
    '5215500003333',
  );
});

test('checkAccess: nunca responde a lo que tú mandas a otras personas', async () => {
  const sock = fakeSock();
  const config = loadConfig({ ALLOWED_NUMBERS: '5215500001111' });
  const toFriend = msg({ chat: '5215500001111@s.whatsapp.net', fromMe: true, message: image() });
  assert.equal((await checkAccess(toFriend, sock, config)).allowed, false);
  const fromFriend = msg({ chat: '5215500001111@s.whatsapp.net', fromMe: false, message: image() });
  assert.equal((await checkAccess(fromFriend, sock, config)).allowed, true);
  const status = msg({ chat: 'status@broadcast', fromMe: false, message: image() });
  assert.equal((await checkAccess(status, sock, config)).allowed, false);
});

// ---------- Flujo completo ----------

test('foto en tu chat personal → sticker citando el mensaje, con reacciones', async () => {
  const t = setup();
  const m = msg({ message: image() });
  await t.handle(m);
  assert.equal(t.calls.download.length, 1);
  assert.equal(t.stickers().length, 1);
  assert.equal(t.stickers()[0].quoted, m);
  assert.deepEqual(t.reactions(), ['⏳', '✅']);
  assert.equal(t.calls.convert[0].opts.animated, false);
  assert.equal(t.calls.convert[0].opts.fit, 'contain');
});

test('video con pie "recortar" → sticker animado recortado', async () => {
  const t = setup();
  await t.handle(msg({ message: { videoMessage: { caption: 'recortar', mimetype: 'video/mp4', url: 'u' } } }));
  assert.equal(t.calls.convert[0].opts.animated, true);
  assert.equal(t.calls.convert[0].opts.fit, 'crop');
  assert.equal(t.calls.convert[0].opts.maxVideoSeconds, 8);
});

test('enlace de X → un sticker por cada foto/video del tweet', async () => {
  const t = setup();
  await t.handle(msg({ message: text('https://x.com/user/status/123') }));
  assert.equal(t.calls.fetchLink.length, 1);
  assert.equal(t.calls.fetchLink[0].link.platform, 'twitter');
  assert.equal(t.stickers().length, 2);
  assert.deepEqual(t.calls.convert.map((c) => c.opts.animated), [false, true]);
});

test('enlace de Pinterest dentro de un texto más largo', async () => {
  const t = setup();
  await t.handle(msg({ message: { extendedTextMessage: { text: 'hazme este porfa https://pin.it/AbC12 gracias' } } }));
  assert.equal(t.calls.fetchLink[0].link.platform, 'pinterest');
  assert.equal(t.stickers().length, 2);
});

test('mensajes temporales también funcionan', async () => {
  const t = setup();
  await t.handle(msg({ message: { ephemeralMessage: { message: image() } } }));
  assert.equal(t.stickers().length, 1);
});

test('responder "!s" a una foto convierte la foto citada', async () => {
  const t = setup();
  const m = msg({
    message: {
      extendedTextMessage: {
        text: '!s',
        contextInfo: { stanzaId: 'ORIG1', participant: SELF_CHAT, quotedMessage: image() },
      },
    },
  });
  await t.handle(m);
  assert.equal(t.calls.download.length, 1);
  assert.equal(t.calls.download[0].key.id, 'ORIG1');
  assert.ok(t.calls.download[0].message.imageMessage);
  assert.equal(t.stickers().length, 1);
});

test('responder "!s" a un mensaje con enlace convierte el enlace', async () => {
  const t = setup();
  await t.handle(msg({
    message: {
      extendedTextMessage: {
        text: '!s',
        contextInfo: { stanzaId: 'ORIG2', quotedMessage: { conversation: 'https://twitter.com/a/status/5' } },
      },
    },
  }));
  assert.equal(t.calls.fetchLink[0].link.id, '5');
});

test('"!s" sin nada que convertir explica cómo usarlo', async () => {
  const t = setup();
  await t.handle(msg({ message: text('!s') }));
  assert.equal(t.stickers().length, 0);
  assert.match(t.texts()[0], /Responde con \*!s\*/);
});

test('!ayuda responde con el menú', async () => {
  const t = setup();
  await t.handle(msg({ message: text('!ayuda') }));
  assert.match(t.texts()[0], /Pinterest/);
  assert.match(t.texts()[0], /recortar/);
});

test('texto normal sin enlace → no hace nada', async () => {
  const t = setup();
  await t.handle(msg({ message: text('hola') }));
  assert.equal(t.sock.sent.length, 0);
});

test('ignora stickers y los mensajes que envió el propio bot', async () => {
  const t = setup();
  await t.handle(msg({ message: { stickerMessage: { url: 'x' } } }));
  assert.equal(t.sock.sent.length, 0);

  await t.handle(msg({ message: text('!ayuda') }));
  const botReply = t.sock.sent.at(-1);
  const before = t.sock.sent.length;
  await t.handle({ key: { remoteJid: SELF_CHAT, fromMe: true, id: 'BOT1' }, message: { conversation: botReply.content.text } });
  assert.equal(t.sock.sent.length, before);
});

test('fotos que tú mandas a tus amigos NO se convierten', async () => {
  const t = setup();
  await t.handle(msg({ chat: '5215533334444@s.whatsapp.net', fromMe: true, message: image() }));
  assert.equal(t.sock.sent.length, 0);
});

test('número permitido (aunque llegue como @lid) → sí; desconocido → no y avisa en consola', async () => {
  const t = setup({ ALLOWED_NUMBERS: '+52 1 55 0000 1111' });
  await t.handle(msg({
    chat: '42@lid', remoteJidAlt: '5215500001111@s.whatsapp.net', fromMe: false, message: image(),
  }));
  assert.equal(t.stickers().length, 1);

  await t.handle(msg({ chat: '5215577778888@s.whatsapp.net', fromMe: false, message: image() }));
  await t.handle(msg({ chat: '5215577778888@s.whatsapp.net', fromMe: false, message: image() }));
  assert.equal(t.stickers().length, 1);
  assert.equal(t.logs.filter((l) => l.includes('5215577778888')).length, 1, 'avisa una sola vez');
});

test('ALLOW_EVERYONE=true responde a cualquier chat privado', async () => {
  const t = setup({ ALLOW_EVERYONE: 'true' });
  await t.handle(msg({ chat: '5215577778888@s.whatsapp.net', fromMe: false, message: image() }));
  assert.equal(t.stickers().length, 1);
});

test('grupos: solo los de ALLOWED_GROUPS', async () => {
  const t = setup({ ALLOWED_GROUPS: '120363000000000001@g.us' });
  await t.handle(msg({ chat: '120363000000000001@g.us', fromMe: false, participant: '5@lid', message: video() }));
  assert.equal(t.stickers().length, 1);
  await t.handle(msg({ chat: '120363000000000999@g.us', fromMe: false, participant: '5@lid', message: video() }));
  assert.equal(t.stickers().length, 1);
});

test('!id responde a ti, pero no a desconocidos', async () => {
  const t = setup();
  await t.handle(msg({ chat: '120363000000000777@g.us', fromMe: true, message: text('!id') }));
  assert.match(t.texts()[0], /120363000000000777@g\.us/);

  const t2 = setup();
  await t2.handle(msg({
    chat: '120363000000000777@g.us', fromMe: false, participant: '5215577778888@s.whatsapp.net', message: text('!id'),
  }));
  assert.equal(t2.texts().length, 0);
  assert.ok(t2.logs.some((l) => l.includes('120363000000000777@g.us')), 'igual lo muestra en consola');
});

test('archivo demasiado pesado → error sin descargar', async () => {
  const t = setup({ MAX_DOWNLOAD_MB: '1' });
  await t.handle(msg({ message: { videoMessage: { url: 'u', mimetype: 'video/mp4', fileLength: { toNumber: () => 5 * 1024 * 1024 } } } }));
  assert.equal(t.calls.download.length, 0);
  assert.deepEqual(t.reactions(), ['⏳', '❌']);
  assert.match(t.texts()[0], /muy pesado/);
});

test('si algo falla reacciona con ❌ y explica el error', async () => {
  const t = setup({}, { downloadFails: true });
  await t.handle(msg({ message: image() }));
  assert.deepEqual(t.reactions(), ['⏳', '❌']);
  assert.match(t.texts()[0], /No pude crear el sticker: falló la descarga/);
});
