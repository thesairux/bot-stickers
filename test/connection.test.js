import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describeDisconnect } from '../src/connection.js';

/** Imita el error Boom que manda Baileys. */
const boom = (statusCode, message = '') => Object.assign(new Error(message), { output: { statusCode } });

test('QR expirado → explica y reintenta rápido', () => {
  const info = describeDisconnect(boom(408, 'QR refs attempts ended'));
  assert.equal(info.reconnect, true);
  assert.equal(info.quickRetry, true);
  assert.match(info.message, /QR expiró/);
});

test('tiempo agotado sin QR → problema de internet, reintenta con espera', () => {
  const info = describeDisconnect(boom(408, 'Timed Out'));
  assert.equal(info.reconnect, true);
  assert.ok(!info.quickRetry);
  assert.match(info.message, /internet/);
  assert.match(info.message, /408/);
});

test('515 después de escanear → reinicio normal', () => {
  const info = describeDisconnect(boom(515, 'Stream Errored (restart required)'));
  assert.equal(info.reconnect, true);
  assert.equal(info.quickRetry, true);
});

test('sesión cerrada desde el teléfono → borra sesión y se detiene', () => {
  const info = describeDisconnect(boom(401));
  assert.equal(info.reconnect, false);
  assert.equal(info.wipeSession, true);
});

test('otra ventana abierta (440) → se detiene sin pelear por la sesión', () => {
  const info = describeDisconnect(boom(440));
  assert.equal(info.reconnect, false);
  assert.ok(!info.wipeSession);
});

test('sin error conocido → reintenta', () => {
  assert.equal(describeDisconnect(undefined).reconnect, true);
  assert.equal(describeDisconnect(boom(503)).reconnect, true);
});
