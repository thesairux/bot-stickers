import makeWASocket, {
  Browsers,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
} from 'baileys';
import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import pino from 'pino';
import QRCode from 'qrcode';
import qrcode from 'qrcode-terminal';
import { config } from './config.js';
import { describeDisconnect } from './connection.js';
import { createHandler } from './handler.js';
import { syncProfilePicture, syncProfileStatus } from './profile.js';

const logger = pino({ level: config.logLevel });

let sock;
let reconnectDelay = 2_000;
const QR_IMAGE = resolve('qr.png');

const handleMessage = createHandler({ getSock: () => sock, config });

function printSetupHints() {
  const me = sock.user;
  console.log(`[bot] ✅ Conectado como ${me?.name || ''} (${me?.id?.split(':')[0].split('@')[0]})`);
  const rules = [];
  if (config.respondInSelfChat) rules.push('tu chat "Mensaje para ti"');
  if (config.allowEveryone) rules.push('CUALQUIER chat privado');
  else if (config.allowedNumbers.length) rules.push(`los números: ${config.allowedNumbers.join(', ')}`);
  if (config.allowedGroups.length) rules.push(`${config.allowedGroups.length} grupo(s)`);
  console.log(`[bot] Respondo en: ${rules.length ? rules.join(' · ') : '(nadie todavía — revisa tu .env)'}`);
  console.log('[bot] Mándale una foto, video o enlace de X/Pinterest. Escribe !ayuda para ver opciones.');
}

export async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState(config.authDir);

  let version;
  try {
    ({ version } = await fetchLatestBaileysVersion());
  } catch {
    // si falla, Baileys usa su versión por defecto
  }

  sock = makeWASocket({
    version,
    logger,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    browser: Browsers.ubuntu('Chrome'),
    markOnlineOnConnect: false,
    syncFullHistory: false,
  });

  sock.ev.on('creds.update', saveCreds);

  let pairingRequested = false;

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr && config.pairingNumber) {
      // Vincular con código de 8 dígitos en vez de QR (útil en servidores).
      if (!pairingRequested) {
        pairingRequested = true;
        try {
          const code = await sock.requestPairingCode(config.pairingNumber);
          console.log(`\n[bot] Tu código de vinculación es: ${code}`);
          console.log('      WhatsApp → Dispositivos vinculados → Vincular con número de teléfono\n');
        } catch (err) {
          console.error('[bot] No pude pedir el código de vinculación:', err.message);
        }
      }
    } else if (qr) {
      console.log('\n[bot] Escanea este QR con WhatsApp → Dispositivos vinculados → Vincular un dispositivo:\n');
      qrcode.generate(qr, { small: true });
      // Copia en imagen por si el de la terminal se ve deformado.
      QRCode.toFile(QR_IMAGE, qr, { width: 400, margin: 2 })
        .then(() => console.log(`[bot] ¿No se deja escanear? Abre la imagen: ${QR_IMAGE}`))
        .catch(() => {});
      console.log('[bot] El QR cambia cada ~20-60 s; si expira aparece uno nuevo solo.\n');
    }

    if (connection === 'open') {
      reconnectDelay = 2_000;
      rm(QR_IMAGE, { force: true }).catch(() => {});
      printSetupHints();
      syncProfilePicture(sock, { path: config.profilePicture, authDir: config.authDir })
        .catch((err) => console.warn('[bot] No pude cambiar la foto de perfil:', err.message));
      syncProfileStatus(sock, { status: config.profileStatus, authDir: config.authDir })
        .catch((err) => console.warn('[bot] No pude cambiar la descripción:', err.message));
    }

    if (connection === 'close') {
      const info = describeDisconnect(lastDisconnect?.error);
      console.warn(`[bot] ${info.message}`);
      if (info.wipeSession) {
        await rm(config.authDir, { recursive: true, force: true });
      }
      if (!info.reconnect) {
        process.exit(1);
      }
      const delay = info.quickRetry ? 1_000 : reconnectDelay;
      if (!info.quickRetry) {
        console.warn(`[bot] Reintentando en ${delay / 1000}s…`);
        reconnectDelay = Math.min(reconnectDelay * 2, 60_000);
      }
      setTimeout(() => startBot().catch((err) => console.error('[bot] Error al reconectar:', err)), delay);
    }
  });

  sock.ev.on('messages.upsert', ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      handleMessage(msg).catch((err) => console.error('[bot] Error inesperado:', err));
    }
  });
}
