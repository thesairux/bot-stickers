import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { promisify } from 'node:util';
import webp from 'node-webpmux';
import { ANIMATED_LIMIT_BYTES, STATIC_LIMIT_BYTES, convertToSticker } from '../src/sticker.js';

const run = promisify(execFile);
let dir;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'stk-test-'));
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function ffmpeg(...args) {
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
}

async function load(buf) {
  const img = new webp.Image();
  await img.load(buf);
  return img;
}

/** Lee el canal alfa de un píxel del primer frame. */
async function alphaAt(stickerBuf, x, y) {
  const webpPath = join(dir, `probe-${x}-${y}-${Math.random()}.webp`);
  await writeFile(webpPath, stickerBuf);
  const { stdout } = await run(
    'ffmpeg',
    ['-loglevel', 'error', '-i', webpPath, '-frames:v', '1', '-pix_fmt', 'rgba', '-f', 'rawvideo', '-'],
    { encoding: 'buffer', maxBuffer: 16 * 1024 * 1024 },
  );
  assert.equal(stdout.length, 512 * 512 * 4);
  return stdout[(y * 512 + x) * 4 + 3];
}

test('foto horizontal → sticker 512x512 con bordes transparentes y metadatos', async () => {
  const png = join(dir, 'wide.png');
  await ffmpeg('-f', 'lavfi', '-i', 'testsrc2=s=1280x720', '-frames:v', '1', png);

  const buf = await convertToSticker(await readFile(png), {
    animated: false,
    ext: 'png',
    packName: 'Mi Pack',
    author: 'Yo',
  });
  assert.ok(buf.length <= STATIC_LIMIT_BYTES, `pesa ${buf.length}`);

  const img = await load(buf);
  assert.equal(img.width, 512);
  assert.equal(img.height, 512);
  assert.equal(img.hasAnim, false);
  const exif = img.exif.toString('utf8');
  assert.ok(exif.includes('"sticker-pack-name":"Mi Pack"'));
  assert.ok(exif.includes('"sticker-pack-publisher":"Yo"'));

  assert.equal(await alphaAt(buf, 256, 5), 0, 'el borde superior debe ser transparente');
  assert.equal(await alphaAt(buf, 256, 256), 255, 'el centro debe ser opaco');
});

test('modo "recortar" llena todo el cuadrado', async () => {
  const png = join(dir, 'wide2.png');
  await ffmpeg('-f', 'lavfi', '-i', 'color=c=red:s=900x300', '-frames:v', '1', png);
  const buf = await convertToSticker({ path: png }, { animated: false, fit: 'crop' });
  assert.equal(await alphaAt(buf, 256, 5), 255);
});

test('video largo → sticker animado de 512x512 que pesa menos de 500 KB', async () => {
  const mp4 = join(dir, 'clip.mp4');
  await ffmpeg('-f', 'lavfi', '-i', 'testsrc=s=720x1280:r=30', '-t', '12', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', mp4);

  const buf = await convertToSticker({ path: mp4 }, { animated: true, ext: 'mp4', maxVideoSeconds: 8 });
  assert.ok(buf.length <= ANIMATED_LIMIT_BYTES, `pesa ${buf.length}`);
  const img = await load(buf);
  assert.equal(img.width, 512);
  assert.equal(img.height, 512);
  assert.ok(img.hasAnim);
  assert.ok(img.frames.length > 10);
  assert.ok(img.exif.toString('utf8').includes('sticker-pack-name'));
});

test('GIF → sticker animado', async () => {
  const gif = join(dir, 'anim.gif');
  await ffmpeg('-f', 'lavfi', '-i', 'testsrc=s=320x240:r=10:d=2', gif);
  const buf = await convertToSticker(await readFile(gif), { animated: true, ext: 'gif' });
  const img = await load(buf);
  assert.ok(img.hasAnim);
  assert.equal(img.width, 512);
});

test('archivo que no es imagen da un error claro', async () => {
  await assert.rejects(
    convertToSticker(Buffer.from('esto no es una imagen'), { animated: false, ext: 'jpg' }),
    /ffmpeg falló/,
  );
});

test('por defecto el paquete y el autor dicen "tritonitis"', async () => {
  const png = join(dir, 'default-meta.png');
  await ffmpeg('-f', 'lavfi', '-i', 'color=c=green:s=200x200', '-frames:v', '1', png);
  const img = await load(await convertToSticker({ path: png }, { animated: false }));
  const exif = img.exif.toString('utf8');
  assert.ok(exif.includes('"sticker-pack-name":"tritonitis"'));
  assert.ok(exif.includes('"sticker-pack-publisher":"tritonitis"'));
});
