import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fetchLinkMedia, findLink } from '../src/sources/index.js';
import {
  extractPinterest,
  matchPinterest,
  parsePinData,
  parsePinHtml,
  pickPinterestVideo,
} from '../src/sources/pinterest.js';
import { extractTwitter, matchTwitter, pickTwitterVariant } from '../src/sources/twitter.js';

/**
 * fetch falso: responde según la URL.
 * @param {Record<string, (url: string) => any>} routes  prefijo de URL → respuesta
 */
function fakeFetch(routes) {
  const calls = [];
  const impl = async (url) => {
    calls.push(String(url));
    for (const [prefix, respond] of Object.entries(routes)) {
      if (String(url).startsWith(prefix)) return respond(String(url));
    }
    return new Response('not found', { status: 404 });
  };
  impl.calls = calls;
  return impl;
}

const json = (data) => () => Response.json(data);
const bytes = (text) => () => new Response(Buffer.from(text));

// ---------- X / Twitter ----------

test('detecta enlaces de X / Twitter en distintos formatos', () => {
  assert.deepEqual(matchTwitter('mira https://x.com/usuario_1/status/1234567890?s=20 jaja'), {
    platform: 'twitter',
    url: 'https://x.com/usuario_1/status/1234567890',
    user: 'usuario_1',
    id: '1234567890',
  });
  assert.equal(matchTwitter('https://twitter.com/jack/status/20').id, '20');
  assert.equal(matchTwitter('https://mobile.twitter.com/a/status/5').id, '5');
  assert.equal(matchTwitter('https://fxtwitter.com/a/status/6').id, '6');
  assert.equal(matchTwitter('https://vxtwitter.com/a/status/7/photo/1').id, '7');
  assert.equal(matchTwitter('https://x.com/i/web/status/8').user, 'i');
  assert.equal(matchTwitter('https://x.com/elonmusk'), null);
  assert.equal(matchTwitter('https://google.com'), null);
});

test('elige la variante de video más liviana con al menos 512px', () => {
  const variants = [
    { content_type: 'application/x-mpegURL', url: 'https://video.twimg.com/a/pl/x.m3u8' },
    { content_type: 'video/mp4', bitrate: 256000, url: 'https://video.twimg.com/a/vid/avc1/480x270/a.mp4' },
    { content_type: 'video/mp4', bitrate: 2176000, url: 'https://video.twimg.com/a/vid/avc1/1280x720/c.mp4' },
    { content_type: 'video/mp4', bitrate: 832000, url: 'https://video.twimg.com/a/vid/avc1/640x360/b.mp4' },
  ];
  assert.equal(pickTwitterVariant(variants, 'fallback'), 'https://video.twimg.com/a/vid/avc1/640x360/b.mp4');
  assert.equal(pickTwitterVariant([], 'fallback'), 'fallback');
  assert.equal(pickTwitterVariant(undefined, 'fallback'), 'fallback');
});

test('extrae fotos, videos y GIFs de un tweet (FxTwitter)', async () => {
  const fetchImpl = fakeFetch({
    'https://api.fxtwitter.com/user/status/1': json({
      code: 200,
      tweet: {
        media: {
          all: [
            { type: 'photo', url: 'https://pbs.twimg.com/media/AAA.png' },
            { type: 'gif', url: 'https://video.twimg.com/tweet_video/BBB.mp4' },
            {
              type: 'video',
              url: 'https://video.twimg.com/v/vid/avc1/1280x720/best.mp4',
              variants: [
                { content_type: 'video/mp4', url: 'https://video.twimg.com/v/vid/avc1/1280x720/best.mp4' },
                { content_type: 'video/mp4', url: 'https://video.twimg.com/v/vid/avc1/640x360/small.mp4' },
              ],
            },
          ],
        },
      },
    }),
  });
  const refs = await extractTwitter({ user: 'user', id: '1' }, { fetchImpl });
  assert.deepEqual(refs, [
    { kind: 'image', url: 'https://pbs.twimg.com/media/AAA.png', ext: 'png' },
    { kind: 'video', url: 'https://video.twimg.com/tweet_video/BBB.mp4', ext: 'mp4' },
    { kind: 'video', url: 'https://video.twimg.com/v/vid/avc1/640x360/small.mp4', ext: 'mp4' },
  ]);
});

test('si el tweet no tiene medios usa los del tweet citado', async () => {
  const fetchImpl = fakeFetch({
    'https://api.fxtwitter.com/': json({
      tweet: { media: null, quote: { media: { all: [{ type: 'photo', url: 'https://pbs.twimg.com/media/Q.jpg' }] } } },
    }),
  });
  const refs = await extractTwitter({ user: 'u', id: '2' }, { fetchImpl });
  assert.equal(refs[0].url, 'https://pbs.twimg.com/media/Q.jpg');
});

test('si FxTwitter falla usa VxTwitter', async () => {
  const fetchImpl = fakeFetch({
    'https://api.fxtwitter.com/': () => new Response('error', { status: 500 }),
    'https://api.vxtwitter.com/u/status/3': json({
      media_extended: [{ type: 'image', url: 'https://pbs.twimg.com/media/V.jpg' }],
    }),
  });
  const refs = await extractTwitter({ user: 'u', id: '3' }, { fetchImpl });
  assert.deepEqual(refs, [{ kind: 'image', url: 'https://pbs.twimg.com/media/V.jpg', ext: 'jpg' }]);
});

// ---------- Pinterest ----------

test('detecta enlaces de Pinterest (completos, con slug, de otros países y pin.it)', () => {
  assert.deepEqual(matchPinterest('https://www.pinterest.com/pin/123456789/'), {
    platform: 'pinterest',
    url: 'https://www.pinterest.com/pin/123456789',
    id: '123456789',
  });
  assert.equal(matchPinterest('https://mx.pinterest.com/pin/555/').id, '555');
  assert.equal(matchPinterest('https://pinterest.es/pin/777').id, '777');
  assert.equal(matchPinterest('https://www.pinterest.com.mx/pin/888/').id, '888');
  assert.equal(
    matchPinterest('https://pinterest.com/pin/unas-azules-para-el-verano--2885187256207927').id,
    '2885187256207927',
  );
  assert.deepEqual(matchPinterest('mira https://pin.it/4AbCdEf ok'), {
    platform: 'pinterest',
    url: 'https://pin.it/4AbCdEf',
    short: true,
  });
  assert.equal(matchPinterest('https://www.pinterest.com/usuario/mi-tablero/'), null);
});

test('pin de imagen → imagen original', () => {
  const refs = parsePinData({
    id: '1',
    images: {
      '236x': { url: 'https://i.pinimg.com/236x/a.jpg', width: 236 },
      orig: { url: 'https://i.pinimg.com/originals/a.jpg', width: 1000 },
    },
    videos: null,
  });
  assert.deepEqual(refs, [{ kind: 'image', url: 'https://i.pinimg.com/originals/a.jpg', ext: 'jpg' }]);
});

test('pin GIF → se trata como animado', () => {
  const refs = parsePinData({ images: { orig: { url: 'https://i.pinimg.com/originals/b.gif' } } });
  assert.deepEqual(refs, [{ kind: 'video', url: 'https://i.pinimg.com/originals/b.gif', ext: 'gif' }]);
});

test('pin de video → mp4 más liviano con al menos 512px, o HLS si no hay mp4', () => {
  assert.deepEqual(
    pickPinterestVideo({
      V_HLSV4: { url: 'https://v1.pinimg.com/videos/hls/x.m3u8', width: 720, height: 1280 },
      V_720P: { url: 'https://v1.pinimg.com/videos/mc/720p/x.mp4', width: 720, height: 1280 },
      V_EXP3: { url: 'https://v1.pinimg.com/videos/mc/expMp4/x_t3.mp4', width: 240, height: 426 },
      V_EXP4: { url: 'https://v1.pinimg.com/videos/mc/expMp4/x_t4.mp4', width: 360, height: 640 },
    }),
    { kind: 'video', url: 'https://v1.pinimg.com/videos/mc/expMp4/x_t4.mp4', ext: 'mp4' },
  );
  assert.deepEqual(pickPinterestVideo({ V_HLSV3_MOBILE: { url: 'https://v1.pinimg.com/videos/hls/y.m3u8' } }), {
    kind: 'video',
    url: 'https://v1.pinimg.com/videos/hls/y.m3u8',
    ext: 'mp4',
    hls: true,
  });
  assert.equal(pickPinterestVideo(null), null);
});

test('idea pin con varias páginas → un sticker por página', () => {
  const refs = parsePinData({
    images: { orig: { url: 'https://i.pinimg.com/originals/cover.jpg' } },
    story_pin_data: {
      pages: [
        { blocks: [{ video: { video_list: { V_EXP7: { url: 'https://v1.pinimg.com/videos/p1.mp4', width: 720, height: 1280 } } } }] },
        { blocks: [{ image: { images: { originals: { url: 'https://i.pinimg.com/originals/p2.png' } } } }] },
      ],
    },
  });
  assert.deepEqual(refs, [
    { kind: 'video', url: 'https://v1.pinimg.com/videos/p1.mp4', ext: 'mp4' },
    { kind: 'image', url: 'https://i.pinimg.com/originals/p2.png', ext: 'png' },
  ]);
});

test('plan B: saca la imagen o el video del HTML del pin', () => {
  assert.deepEqual(
    parsePinHtml('<html><meta property="og:image" content="https://i.pinimg.com/736x/z.jpg"></html>'),
    [{ kind: 'image', url: 'https://i.pinimg.com/736x/z.jpg', ext: 'jpg' }],
  );
  assert.deepEqual(
    parsePinHtml('{"url":"https:\\/\\/v1.pinimg.com\\/videos\\/mc\\/720p\\/a\\/b.mp4"}'),
    [{ kind: 'video', url: 'https://v1.pinimg.com/videos/mc/720p/a/b.mp4', ext: 'mp4' }],
  );
  // Pin de video sin archivo visible: no devolver la miniatura.
  assert.deepEqual(
    parsePinHtml('<meta property="og:video" content="x"><meta property="og:image" content="https://i.pinimg.com/736x/t.jpg">'),
    [],
  );
});

test('resuelve enlaces cortos pin.it y consulta la API de Pinterest', async () => {
  const fetchImpl = fakeFetch({
    'https://pin.it/': () => ({ url: 'https://www.pinterest.com/pin/4242/sent/?invite_code=x', body: null, ok: true }),
    'https://www.pinterest.com/resource/PinResource/get/': (url) => {
      const data = JSON.parse(new URL(url).searchParams.get('data'));
      assert.equal(data.options.id, '4242');
      return Response.json({
        resource_response: { data: { images: { orig: { url: 'https://i.pinimg.com/originals/ok.jpg' } } } },
      });
    },
  });
  const link = matchPinterest('https://pin.it/AbC123');
  const refs = await extractPinterest(link, { fetchImpl });
  assert.equal(link.id, '4242');
  assert.deepEqual(refs, [{ kind: 'image', url: 'https://i.pinimg.com/originals/ok.jpg', ext: 'jpg' }]);
});

test('si la API de Pinterest falla, usa el HTML', async () => {
  const fetchImpl = fakeFetch({
    'https://www.pinterest.com/resource/': () => new Response('nope', { status: 403 }),
    'https://www.pinterest.com/pin/77/': () =>
      new Response('<meta content="https://i.pinimg.com/736x/h.png" property="og:image">'),
  });
  const refs = await extractPinterest({ id: '77', url: 'https://www.pinterest.com/pin/77' }, { fetchImpl });
  assert.deepEqual(refs, [{ kind: 'image', url: 'https://i.pinimg.com/736x/h.png', ext: 'png' }]);
});

// ---------- Descarga ----------

test('findLink reconoce X y Pinterest e ignora otros enlaces', () => {
  assert.equal(findLink('https://x.com/a/status/1').platform, 'twitter');
  assert.equal(findLink('https://pin.it/xyz').platform, 'pinterest');
  assert.equal(findLink('https://youtube.com/watch?v=1'), null);
  assert.equal(findLink(''), null);
});

test('fetchLinkMedia descarga cada medio a la carpeta de trabajo', async () => {
  const workDir = await mkdtemp(join(tmpdir(), 'src-test-'));
  try {
    const fetchImpl = fakeFetch({
      'https://api.fxtwitter.com/': json({
        tweet: {
          media: {
            all: [
              { type: 'photo', url: 'https://pbs.twimg.com/media/P.jpg' },
              { type: 'video', url: 'https://video.twimg.com/v.mp4' },
            ],
          },
        },
      }),
      'https://pbs.twimg.com/media/P.jpg': bytes('JPEGDATA'),
      'https://video.twimg.com/v.mp4': bytes('MP4DATA'),
    });
    const items = await fetchLinkMedia(findLink('https://x.com/u/status/9'), {
      workDir, maxSeconds: 8, maxBytes: 1024, maxItems: 6, ytdlpPath: 'yt-dlp', fetchImpl,
    });
    assert.equal(items.length, 2);
    assert.deepEqual(items.map((i) => [i.animated, i.ext]), [[false, 'jpg'], [true, 'mp4']]);
    assert.equal(await readFile(items[0].path, 'utf8'), 'JPEGDATA');
    assert.equal(await readFile(items[1].path, 'utf8'), 'MP4DATA');
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});

test('fetchLinkMedia respeta el tamaño máximo de descarga', async () => {
  const workDir = await mkdtemp(join(tmpdir(), 'src-test-'));
  try {
    const fetchImpl = fakeFetch({
      'https://api.fxtwitter.com/': json({ tweet: { media: { all: [{ type: 'photo', url: 'https://pbs.twimg.com/big.jpg' }] } } }),
      'https://pbs.twimg.com/big.jpg': bytes('x'.repeat(5000)),
    });
    const ytdlp = async () => {
      throw new Error('yt-dlp: no video');
    };
    await assert.rejects(
      fetchLinkMedia(findLink('https://x.com/u/status/9'), {
        workDir, maxSeconds: 8, maxBytes: 1000, maxItems: 6, ytdlpPath: 'yt-dlp', fetchImpl, ytdlp,
      }),
      /supera el máximo/,
    );
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});

test('si no hay medios usa yt-dlp como último recurso', async () => {
  const workDir = await mkdtemp(join(tmpdir(), 'src-test-'));
  try {
    const fetchImpl = fakeFetch({}); // todo da 404
    let calledWith;
    const ytdlp = async (url) => {
      calledWith = url;
      return join(workDir, 'ytdlp-1.webm');
    };
    const items = await fetchLinkMedia(findLink('https://www.pinterest.com/pin/31337/'), {
      workDir, maxSeconds: 8, maxBytes: 1000, maxItems: 6, ytdlpPath: 'yt-dlp', fetchImpl, ytdlp,
    });
    assert.equal(calledWith, 'https://www.pinterest.com/pin/31337/');
    assert.deepEqual(items, [{ animated: true, path: join(workDir, 'ytdlp-1.webm'), ext: 'webm' }]);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});
