import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { promisify } from 'node:util';
import { loadConfig } from '../src/config.js';
import { prepareProfilePicture, syncProfilePicture, syncProfileStatus } from '../src/profile.js';

const run = promisify(execFile);
let dir;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pfp-test-'));
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function makeImage(name, size, color = 'blue') {
  const path = join(dir, name);
  await run('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `color=c=${color}:s=${size}`, '-frames:v', '1', path]);
  return path;
}

async function dimensions(buf) {
  const path = join(dir, `probe-${Math.random()}.jpg`);
  await writeFile(path, buf);
  const { stdout } = await run('ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height,codec_name', '-of', 'csv=p=0', path]);
  return stdout.trim();
}

function fakeSock() {
  const queries = [];
  return { queries, query: async (node) => { queries.push(node); return {}; } };
}

const quietLog = { log: () => {}, warn: () => {} };

test('la foto incluida existe y es cuadrada de 640x640', async () => {
  assert.equal(await dimensions(await prepareProfilePicture('assets/profile.jpg')), 'mjpeg,640,640');
});

test('cualquier imagen se recorta en cuadrado de 640x640 JPEG', async () => {
  const wide = await makeImage('wide.png', '1600x900');
  const buf = await prepareProfilePicture(wide);
  assert.equal(buf[0], 0xff);
  assert.equal(buf[1], 0xd8, 'debe ser JPEG');
  assert.equal(await dimensions(buf), 'mjpeg,640,640');
});

test('sube la foto una sola vez y otra vez solo si cambia la imagen', async () => {
  const authDir = await mkdtemp(join(dir, 'auth-'));
  const sock = fakeSock();
  const path = await makeImage('pfp.png', '800x800', 'red');

  assert.equal(await syncProfilePicture(sock, { path, authDir, log: quietLog }), 'updated');
  assert.equal(sock.queries.length, 1);
  const iq = sock.queries[0];
  assert.equal(iq.tag, 'iq');
  assert.deepEqual(iq.attrs, { to: '@s.whatsapp.net', type: 'set', xmlns: 'w:profile:picture' });
  assert.equal(iq.content[0].tag, 'picture');
  assert.ok(Buffer.isBuffer(iq.content[0].content));

  // Reconexión: misma imagen → no vuelve a subirla.
  assert.equal(await syncProfilePicture(sock, { path, authDir, log: quietLog }), 'unchanged');
  assert.equal(sock.queries.length, 1);

  // Imagen nueva → la sube.
  await makeImage('pfp.png', '800x800', 'green');
  assert.equal(await syncProfilePicture(sock, { path, authDir, log: quietLog }), 'updated');
  assert.equal(sock.queries.length, 2);
});

test('vacío o archivo inexistente → no hace nada ni truena', async () => {
  const sock = fakeSock();
  const warnings = [];
  assert.equal(await syncProfilePicture(sock, { path: '', authDir: dir }), 'disabled');
  assert.equal(
    await syncProfilePicture(sock, { path: join(dir, 'no-existe.jpg'), authDir: dir, log: { log() {}, warn: (m) => warnings.push(m) } }),
    'disabled',
  );
  assert.equal(sock.queries.length, 0);
  assert.match(warnings[0], /PROFILE_PICTURE/);
});

test('PROFILE_PICTURE: por defecto usa assets/profile.jpg y vacío la desactiva', () => {
  assert.equal(loadConfig({}).profilePicture, 'assets/profile.jpg');
  assert.equal(loadConfig({ PROFILE_PICTURE: '' }).profilePicture, '');
  assert.equal(loadConfig({ PROFILE_PICTURE: 'otra.png' }).profilePicture, 'otra.png');
});

test('descripción: se pone una vez y otra vez solo si cambia el texto', async () => {
  const authDir = await mkdtemp(join(dir, 'auth-status-'));
  const updates = [];
  const sock = { updateProfileStatus: async (text) => updates.push(text) };

  assert.equal(await syncProfileStatus(sock, { status: 'stickers :D made by triton', authDir, log: quietLog }), 'updated');
  assert.deepEqual(updates, ['stickers :D made by triton']);

  assert.equal(await syncProfileStatus(sock, { status: 'stickers :D made by triton', authDir, log: quietLog }), 'unchanged');
  assert.equal(updates.length, 1);

  assert.equal(await syncProfileStatus(sock, { status: 'otra cosa ✨', authDir, log: quietLog }), 'updated');
  assert.deepEqual(updates, ['stickers :D made by triton', 'otra cosa ✨']);
});

test('descripción vacía o demasiado larga → no la toca', async () => {
  const updates = [];
  const sock = { updateProfileStatus: async (text) => updates.push(text) };
  const warnings = [];
  const log = { log() {}, warn: (m) => warnings.push(m) };
  assert.equal(await syncProfileStatus(sock, { status: '', authDir: dir, log }), 'disabled');
  assert.equal(await syncProfileStatus(sock, { status: 'x'.repeat(140), authDir: dir, log }), 'disabled');
  assert.equal(updates.length, 0);
  assert.match(warnings[0], /139/);
});

test('PROFILE_STATUS: por defecto "stickers :D made by triton" y vacío la desactiva', () => {
  assert.equal(loadConfig({}).profileStatus, 'stickers :D made by triton');
  assert.equal(loadConfig({ PROFILE_STATUS: '' }).profileStatus, '');
});
