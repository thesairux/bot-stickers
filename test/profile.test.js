import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { promisify } from 'node:util';
import { loadConfig } from '../src/config.js';
import { cleanJpeg, prepareProfilePicture, syncProfilePicture, syncProfileStatus } from '../src/profile.js';

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

/** Lista los marcadores de un JPEG hasta los datos de imagen (SOS). */
function markers(jpeg) {
  const list = [];
  let i = 2;
  while (jpeg[i] === 0xff && jpeg[i + 1] !== 0xda) {
    list.push(jpeg[i + 1]);
    i += 2 + jpeg.readUInt16BE(i + 2);
  }
  return list;
}

test('cleanJpeg quita EXIF, perfil de color y comentarios sin dañar la imagen', async () => {
  const src = await makeImage('clean-src.jpg', '64x64', 'yellow');
  const original = await readFile(src);
  const segment = (marker, payload) => {
    const head = Buffer.from([0xff, marker, 0, 0]);
    head.writeUInt16BE(payload.length + 2, 2);
    return Buffer.concat([head, payload]);
  };
  // SOI + APP1(EXIF) + APP2(ICC) + COM + resto del JPEG original
  const dirty = Buffer.concat([
    original.subarray(0, 2),
    segment(0xe1, Buffer.from('Exif\0\0GPS-secreto')),
    segment(0xe2, Buffer.from('ICC_PROFILE\0Display P3')),
    segment(0xfe, Buffer.from('Lavc60')),
    original.subarray(2),
  ]);
  assert.ok(markers(dirty).includes(0xe1));

  const clean = cleanJpeg(dirty);
  for (const m of markers(clean)) {
    assert.ok(!(m >= 0xe1 && m <= 0xef) && m !== 0xfe, `quedó el marcador 0x${m.toString(16)}`);
  }
  assert.ok(!clean.includes(Buffer.from('GPS-secreto')));
  assert.equal(await dimensions(clean), 'mjpeg,64,64');
  assert.throws(() => cleanJpeg(Buffer.from('no soy jpeg')), /no es un JPEG/);
});

test('la foto que se sube es un JPEG básico sin metadatos', async () => {
  const jpeg = await prepareProfilePicture('assets/profile.jpg');
  assert.deepEqual(
    markers(jpeg).filter((m) => (m >= 0xe1 && m <= 0xef) || m === 0xfe),
    [],
  );
  assert.ok(markers(jpeg).includes(0xc0), 'debe ser JPEG baseline (SOF0)');
  assert.equal(jpeg[jpeg.length - 2], 0xff);
  assert.equal(jpeg[jpeg.length - 1], 0xd9);
});
