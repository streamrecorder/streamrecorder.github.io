// StreamRecorder SW — проксирует видео/превью из Telegram через main thread.
// Версия протокола: клиент проверяет заголовок X-SW-Video, чтобы понять,
// перехватывает ли SW <video>-запросы (на iOS Safari — нет, там blob-fallback).

const SW_VERSION = 'sr-sw-v3';

// Превью видео практически immutable (thumbId поста не меняется):
// держим их в Cache Storage бессрочно + отдаём с годовыми HTTP-заголовками,
// чтобы работал и дисковый HTTP-кеш браузера. Лимит — защита от переполнения
// квоты (иначе браузер может снести всё origin-хранилище целиком).
const THUMB_CACHE = 'tg-thumbs';
const MAX_THUMBS = 1000;
// Статика (аватарки каналов, бейджи, иконки): cache-first в SW,
// чтобы долгий кеш не зависел от заголовков хостинга.
const STATIC_CACHE = 'sr-static-v1';
const MAX_STATIC = 300;
const STATIC_RE = /\.(png|jpe?g|webp|avif|gif|svg|ico)$/i;

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    try {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((n) => n.startsWith('sr-static-') && n !== STATIC_CACHE)
          .map((n) => caches.delete(n))
      );
    } catch (_) {}
    await self.clients.claim();
  })());
});

// Один HTTP-ответ ограничиваем, чтобы не собирать сотни MTProto-запросов
// ради одного гигантского Range (Safari иногда просит весь файл целиком).
const MAX_HTTP_CHUNK = 2 * 1024 * 1024; // 2 MB на один 206-ответ
const SW_TIMEOUT_MS = 45000;

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  // Маркер ищем внутри пути, а не с начала: билд может лежать в подпути (/client/).
  const videoIdx = url.pathname.indexOf('/tg-video/');
  const thumbIdx = url.pathname.indexOf('/tg-thumb/');
  if (videoIdx !== -1) {
    event.respondWith(handleVideoRequest(event, url, videoIdx));
  } else if (thumbIdx !== -1) {
    event.respondWith(handleThumbRequest(event, url, thumbIdx));
  } else if (isCacheableStatic(url, event.request)) {
    event.respondWith(handleStaticRequest(event));
  }
});

// Cache Storage не знает протухания — чистим сами: keys() идёт
// в порядке вставки, удаляем самые старые с запасом 10%.
async function trimCache(cache, max) {
  try {
    const keys = await cache.keys();
    if (keys.length > max) {
      const victims = keys.slice(0, keys.length - max + Math.ceil(max * 0.1));
      await Promise.all(victims.map((k) => cache.delete(k)));
    }
  } catch (_) {}
}

function isCacheableStatic(url, request) {
  if (request.method !== 'GET') return false;
  if (url.origin !== self.location.origin) return false;
  if (url.pathname.indexOf('/tg-video/') !== -1 || url.pathname.indexOf('/tg-thumb/') !== -1) return false;
  return STATIC_RE.test(url.pathname);
}

// Статика: cache-first. В Cache Storage лежит бессрочно (до обновления SW),
// поэтому повторные визиты не трогают сеть вообще.
async function handleStaticRequest(event) {
  let cache = null;
  try {
    cache = await caches.open(STATIC_CACHE);
    const hit = await cache.match(event.request);
    if (hit) return hit;
  } catch (_) {
    cache = null;
  }
  try {
    const res = await fetch(event.request);
    if (cache && res && res.ok) {
      try {
        await cache.put(event.request, res.clone());
        trimCache(cache, MAX_STATIC).catch(() => {});
      } catch (_) {}
    }
    return res;
  } catch (_) {
    try {
      if (cache) {
        const hit = await cache.match(event.request);
        if (hit) return hit;
      }
    } catch (_) {}
    return new Response(null, { status: 504 });
  }
}

// Парсит Range по RFC 7233: "bytes=START-END", "bytes=START-", "bytes=-SUFFIX".
// Возвращает {start, end} | {suffix} | null при невалидном заголовке.
function parseRange(rangeHeader, fileSize) {
  if (!rangeHeader) return null;
  const m = rangeHeader.match(/bytes\s*=\s*(\d*)-(\d*)/);
  if (!m) return null;
  const [, startStr, endStr] = m;
  if (startStr === '' && endStr === '') return null;
  if (startStr === '') {
    // Суффикс: последние N байт
    const suffix = parseInt(endStr, 10);
    if (!Number.isFinite(suffix) || suffix <= 0) return null;
    const start = Math.max(0, fileSize - suffix);
    return { start, end: fileSize - 1 };
  }
  const start = parseInt(startStr, 10);
  if (!Number.isFinite(start) || start < 0 || start >= fileSize) return null;
  let end = endStr === '' ? fileSize - 1 : parseInt(endStr, 10);
  if (!Number.isFinite(end) || end < start) return null;
  if (end >= fileSize) end = fileSize - 1;
  return { start, end };
}

function videoHeaders(start, end, fileSize, extra = {}) {
  return {
    'Content-Range': `bytes ${start}-${end}/${fileSize}`,
    'Accept-Ranges': 'bytes',
    'Content-Length': String(end - start + 1),
    'Content-Type': 'video/mp4',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Expose-Headers': 'Content-Range, Content-Length, Accept-Ranges',
    'X-SW-Video': SW_VERSION,
    ...extra,
  };
}

async function handleVideoRequest(event, url, markerIdx) {
  // Format: <base>/tg-video/<chatId>/<messageId>/<size>
  const parts = url.pathname.slice(markerIdx).split('/');
  const chatId = parts[2];
  const messageId = parseInt(parts[3], 10);
  const fileSize = parseInt(parts[4], 10);

  if (!chatId || !Number.isFinite(messageId) || !Number.isFinite(fileSize) || fileSize <= 0) {
    return new Response('Bad tg-video URL', { status: 400 });
  }
  if (event.request.method === 'HEAD') {
    return new Response(null, {
      status: 200,
      headers: {
        'Accept-Ranges': 'bytes',
        'Content-Length': String(fileSize),
        'Content-Type': 'video/mp4',
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*',
        'X-SW-Video': SW_VERSION,
      },
    });
  }
  if (event.request.method !== 'GET') {
    return new Response(null, { status: 405 });
  }

  // Режим скачивания целиком (?download=1): потоковая отдача всего файла.
  if (url.searchParams.has('download')) {
    const stream = new ReadableStream({
      async start(controller) {
        // Отдаём кусками по MAX_HTTP_CHUNK, чтобы не держать гигантские буферы.
        let currentStart = 0;
        try {
          while (currentStart < fileSize) {
            if (event.request.signal.aborted) break;
            const end = Math.min(currentStart + MAX_HTTP_CHUNK - 1, fileSize - 1);
            const chunk = await requestChunkFromMainThread(event, chatId, messageId, currentStart, end);
            controller.enqueue(new Uint8Array(chunk));
            currentStart = end + 1;
          }
          controller.close();
        } catch (e) {
          controller.error(e);
        }
      },
      cancel() {
        // Клиент закрыл соединение — чанк-запросы отменятся по abort signal.
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'video/mp4',
        'Content-Length': fileSize.toString(),
        'Content-Disposition': 'attachment',
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*',
        'X-SW-Video': SW_VERSION,
      }
    });
  }

  const rawRange = event.request.headers.get('Range');
  // Без Range отдаём первый кусок как 206 (полный файл слишком велик,
  // чтобы качать его из Telegram целиком ради одного ответа).
  const parsed = rawRange ? parseRange(rawRange, fileSize) : { start: 0, end: fileSize - 1 };
  if (!parsed) {
    return new Response(null, {
      status: 416,
      headers: {
        'Content-Range': `bytes */${fileSize}`,
        'Accept-Ranges': 'bytes',
        'X-SW-Video': SW_VERSION,
      },
    });
  }

  // Режем слишком большие диапазоны: браузер запросит остаток следующими Range.
  let { start, end } = parsed;
  if (end - start + 1 > MAX_HTTP_CHUNK) {
    end = start + MAX_HTTP_CHUNK - 1;
  }

  try {
    const chunk = await requestChunkFromMainThread(event, chatId, messageId, start, end);
    return new Response(chunk, {
      status: 206,
      headers: videoHeaders(start, end, fileSize),
    });
  } catch (e) {
    const msg = String((e && e.message) || e);
    if (msg.includes('Aborted')) {
      // Браузер отменил запрос (seek/переключение части) — тихий разрыв.
      return new Response(null, { status: 499, headers: { 'X-SW-Video': SW_VERSION } });
    }
    return new Response('Upstream chunk error: ' + msg, {
      status: 502,
      headers: { 'X-SW-Video': SW_VERSION },
    });
  }
}

function requestChunkFromMainThread(event, chatId, messageId, start, end) {
  return new Promise(async (resolve, reject) => {
    let clients = [];
    try {
      // Сначала — именно та вкладка, чей <video> запросил чанк.
      if (event.clientId) {
        const client = await self.clients.get(event.clientId);
        if (client) clients = [client];
      }
      if (clients.length === 0) {
        clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      }
    } catch (_) {
      try {
        clients = await self.clients.matchAll({ type: 'window' });
      } catch (__) {
        clients = [];
      }
    }
    if (clients.length === 0) {
      return reject(new Error('No main window available'));
    }

    const reqId = Math.random().toString(36).slice(2);
    let settled = false;
    const done = (fn, val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { event.request.signal.removeEventListener('abort', abortHandler); } catch (_) {}
      fn(val);
    };

    const timer = setTimeout(() => {
      try { clients[0].postMessage({ type: 'abort-tg-chunk', reqId }); } catch (_) {}
      done(reject, new Error('SW chunk timeout'));
    }, SW_TIMEOUT_MS);

    const abortHandler = () => {
      try { clients[0].postMessage({ type: 'abort-tg-chunk', reqId }); } catch (_) {}
      done(reject, new Error('Aborted'));
    };

    const messageChannel = new MessageChannel();
    messageChannel.port1.onmessage = (msgEvent) => {
      if (msgEvent.data && msgEvent.data.error) {
        done(reject, new Error(String(msgEvent.data.error)));
      } else if (msgEvent.data) {
        done(resolve, msgEvent.data.chunk);
      } else {
        done(reject, new Error('Empty chunk response'));
      }
    };

    try {
      event.request.signal.addEventListener('abort', abortHandler, { once: true });
    } catch (_) {}

    try {
      clients[0].postMessage({
        type: 'fetch-tg-chunk',
        reqId,
        chatId,
        messageId,
        start,
        end
      }, [messageChannel.port2]);
    } catch (e) {
      done(reject, e);
    }
  });
}

async function handleThumbRequest(event, url, markerIdx) {
  let cache = null;
  try {
    cache = await caches.open(THUMB_CACHE);
    const cachedResponse = await cache.match(event.request);
    if (cachedResponse) {
      return cachedResponse;
    }
  } catch (_) {
    cache = null;
  }

  const parts = url.pathname.slice(markerIdx).split('/');
  const chatId = parts[2];
  const messageId = parseInt(parts[3], 10);

  return new Promise(async (resolve) => {
    let clients = [];
    try {
      if (event.clientId) {
        const client = await self.clients.get(event.clientId);
        if (client) clients = [client];
      }
      if (clients.length === 0) {
        clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      }
    } catch (_) {
      clients = [];
    }
    if (clients.length === 0) {
      return resolve(new Response(null, { status: 404 }));
    }

    const messageChannel = new MessageChannel();
    messageChannel.port1.onmessage = async (msgEvent) => {
      if (msgEvent.data.error || !msgEvent.data.chunk) {
        resolve(new Response(null, { status: 404 }));
      } else {
        // Полный набор «долгих» заголовков: дисковый HTTP-кеш отдаёт
        // превью год без ревалидации даже мимо SW. ETag стабильный —
        // байты превью для (chatId, messageId) не меняются.
        const now = new Date();
        const buf = msgEvent.data.chunk;
        let len = 0;
        try { len = buf ? buf.byteLength : 0; } catch (_) {}
        const response = new Response(buf, {
          headers: {
            'Content-Type': 'image/jpeg',
            'Content-Length': String(len),
            'Date': now.toUTCString(),
            'Expires': new Date(now.getTime() + 31536000 * 1000).toUTCString(),
            'Last-Modified': now.toUTCString(),
            'ETag': `"tg-${chatId}-${messageId}"`,
            'Cache-Control': 'public, max-age=31536000, immutable'
          }
        });
        resolve(response);
        // Кладём в Cache Storage в фоне, чтобы не задерживать <img>.
        // Имя кеша не версионируем — превью переживают обновления SW.
        try {
          if (cache) {
            await cache.put(event.request, response.clone());
            await trimCache(cache, MAX_THUMBS);
          }
        } catch (_) {}
      }
    };

    try {
      clients[0].postMessage({
        type: 'fetch-tg-thumb',
        chatId,
        messageId
      }, [messageChannel.port2]);
    } catch (_) {
      resolve(new Response(null, { status: 404 }));
    }
  });
}
