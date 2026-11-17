import { DisconnectReason } from 'baileys';

/**
 * Traduce el motivo de desconexión de Baileys a algo entendible y decide
 * qué hacer: reconectar, borrar la sesión o detenerse.
 *
 * @param {any} error  lastDisconnect.error (un Boom de Baileys)
 * @returns {{ code: number | undefined, message: string, reconnect: boolean, wipeSession?: boolean, quickRetry?: boolean }}
 */
export function describeDisconnect(error) {
  const code = error?.output?.statusCode;
  const raw = String(error?.message || '');

  if (code === DisconnectReason.timedOut && /QR refs attempts ended/i.test(raw)) {
    return {
      code,
      message: '⌛ El QR expiró sin escanearse. Te muestro uno nuevo: escanéalo dentro de 1 minuto.',
      reconnect: true,
      quickRetry: true,
    };
  }

  switch (code) {
    case DisconnectReason.restartRequired: // 515: normal justo después de escanear el QR
      return { code, message: '🔄 Vinculado. Reiniciando la conexión…', reconnect: true, quickRetry: true };
    case DisconnectReason.loggedOut: // 401
      return {
        code,
        message: '🚪 La sesión se cerró desde el teléfono. Borro la sesión guardada; vuelve a iniciar el bot y escanea un QR nuevo.',
        reconnect: false,
        wipeSession: true,
      };
    case DisconnectReason.connectionReplaced: // 440
      return {
        code,
        message: '⚠️ El bot se abrió en otra ventana o computadora y esta conexión fue reemplazada. Deja solo una abierta.',
        reconnect: false,
      };
    case DisconnectReason.badSession: // 500
    case DisconnectReason.multideviceMismatch: // 411
      return {
        code,
        message: '⚠️ La sesión guardada está dañada. La borro; vuelve a iniciar el bot y escanea un QR nuevo.',
        reconnect: false,
        wipeSession: true,
      };
    case DisconnectReason.forbidden: // 403
      return {
        code,
        message: '⛔ WhatsApp rechazó la conexión (el número puede estar restringido o bloqueado).',
        reconnect: false,
      };
    case 405:
      return {
        code,
        message: '⚠️ WhatsApp rechazó la conexión (código 405). Actualiza el bot con "git pull" y "npm install", y vuelve a intentar.',
        reconnect: true,
      };
    case DisconnectReason.timedOut: // 408
    case DisconnectReason.connectionClosed: // 428
    case DisconnectReason.unavailableService: // 503
    default:
      return {
        code,
        message:
          `📡 Se cortó o no se pudo establecer la conexión con WhatsApp (código ${code ?? '?'}${raw ? `: ${raw}` : ''}). ` +
          'Revisa tu internet (si usas VPN o el wifi de un colegio/trabajo, prueba sin ella o con otra red).',
        reconnect: true,
      };
  }
}
