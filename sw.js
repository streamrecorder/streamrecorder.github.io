// StreamRecorder SW — проксирует видео/превью из Telegram через main thread.
// Версия протокола: клиент проверяет заголовок X-SW-Video, чтобы понять,
// перехватывает ли SW <video>-запросы (на iOS Safari — нет, там blob-fallback).

// Версия протокола. Поднимается при несовместимых изменениях: клиент
// сверяется с ней по заголовку X-SW-Video, а activate вычищает старые
// кеши (см. THUMB_CACHE/STATIC_CACHE).
const SW_VERSION = 'sr-sw-v5';

// Превью видео практически immutable (thumbId поста не меняется):
// держим их в Cache Storage бессрочно + отдаём с годовыми HTTP-заголовками,
// чтобы работал и дисковый HTTP-кеш браузера. Лимит — защита от переполнения
// квоты (иначе браузер может снести всё origin-хранилище целиком).
const THUMB_CACHE = 'tg-thumbs-v5';
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
          // Статика: чистим прошлые версии.
          .filter((n) => n.startsWith('sr-static-') && n !== STATIC_CACHE)
          // Превью: чистим прошлые версии тоже. Раньше в фильтре стоял
          // только sr-static-*, из-за чего tg-thumbs жил вечно и переживал
          // выход из аккаунта — следующий человек за тем же браузером
          // получал превью чужих закрытых каналов из кеша.
          .filter((n) => n.startsWith('tg-thumbs') && n !== THUMB_CACHE)
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
// Превью идут через очередь с темпом, поэтому их ответ всегда ждёт дольше,
// чем один GetFile. 25с — с запасом на flood wait, но быстрее, чем пользователь
// решит, что «превью не грузятся».
const SW_THUMB_TIMEOUT_MS = 25000;

// Окно нашего origin под нашим управлением — единственное, которому
// отдаём байты из Telegram. По спецификации SW и так не видит запросы
// неконтролируемых клиентов (проверено: cross-origin fetch с чужого
// сайта уходит в сеть, минуя SW), но явная проверка закрывает остаток:
// обращение к чужому хосту с путём /tg-video/ из нашей вкладки, а также
// подмену клиента в matchAll.
async function pickRequestingClient(event) {
  const id = event.clientId || event.resultingClientId;
  if (!id) return null;
  try {
    const client = await self.clients.get(id);
    if (!client || client.type !== 'window') return null;
    if (!(client.url || '').startsWith(self.registration.scope)) return null;
    return client;
  } catch (_) {
    return null;
  }
}

async function guardOwnClient(event, handler) {
  const client = await pickRequestingClient(event);
  if (!client) {
    return new Response(null, {
      status: 403,
      headers: { 'X-SW-Video': SW_VERSION },
    });
  }
  return handler(client);
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  // Прокси-маркеры ищем только внутри СВОЕГО origin: иначе запрос с
  // нашей вкладки к чужому хосту, у которого в пути есть /tg-video/,
  // перехватывался бы нашим SW. Внутри пути, а не с начала: билд может
  // лежать в подпути (/client/).
  const isOurs = url.origin === self.location.origin;
  const videoIdx = isOurs ? url.pathname.indexOf('/tg-video/') : -1;
  const thumbIdx = isOurs ? url.pathname.indexOf('/tg-thumb/') : -1;
  if (videoIdx !== -1) {
    event.respondWith(guardOwnClient(event, (client) => handleVideoRequest(event, url, videoIdx, client)));
  } else if (thumbIdx !== -1) {
    event.respondWith(guardOwnClient(event, (client) => handleThumbRequest(event, url, thumbIdx, client)));
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
    // Без Access-Control-Allow-Origin. Ответы SW не нужны чужим origin'ам:
    // видео всегда запрашивает наша же вкладка, а wildcard-CORS делал
    // байты читаемыми из любого контекста, куда ответ попал.
    'X-SW-Video': SW_VERSION,
    ...extra,
  };
}

// Потолок на размер, заявленный в URL. Размер приходит из пути и в
// ?download=1 управляет циклом GetFile: без проверки подставленное
// в URL число гоняло бы вкладку в бесконечный цикл запросов к Telegram
// и ловило flood wait на аккаунте. 64 GB — с запасом выше любой реальной записи.
const MAX_FILE_SIZE = 64 * 1024 * 1024 * 1024;

async function handleVideoRequest(event, url, markerIdx, client) {
  // Format: <base>/tg-video/<chatId>/<messageId>/<size>
  const parts = url.pathname.slice(markerIdx).split('/');
  const chatId = parts[2];
  const messageId = parseInt(parts[3], 10);
  const fileSize = parseInt(parts[4], 10);

  if (!chatId || !Number.isFinite(messageId) || !Number.isFinite(fileSize) || fileSize <= 0 || fileSize > MAX_FILE_SIZE) {
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
            const chunk = await requestChunkFromMainThread(event, client, chatId, messageId, currentStart, end);
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
    const chunk = await requestChunkFromMainThread(event, client, chatId, messageId, start, end);
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

function requestChunkFromMainThread(event, client, chatId, messageId, start, end) {
  return new Promise((resolve, reject) => {
    if (!client) {
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
      try { client.postMessage({ type: 'abort-tg-chunk', reqId }); } catch (_) {}
      done(reject, new Error('SW chunk timeout'));
    }, SW_TIMEOUT_MS);

    const abortHandler = () => {
      try { client.postMessage({ type: 'abort-tg-chunk', reqId }); } catch (_) {}
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
      // Строго та вкладка, чей <video> запросил чанк. Раньше здесь был
      // fallback на matchAll(includeUncontrolled: true) — то есть байты
      // авторизованной сессии мог уйти в любое окно этого origin.
      client.postMessage({
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

async function handleThumbRequest(event, url, markerIdx, client) {
  let cache = null;
  try {
    cache = await caches.open(THUMB_CACHE);
    // ignoreSearch: параметр ?r=N — это cache-buster ретрая в LazyImg,
    // он не должен плодить отдельные записи кеша для одного превью.
    const cachedResponse = await cache.match(event.request, { ignoreSearch: true });
    if (cachedResponse) {
      return cachedResponse;
    }
  } catch (_) {
    cache = null;
  }

  const parts = url.pathname.slice(markerIdx).split('/');
  const chatId = parts[2];
  const messageId = parseInt(parts[3], 10);
  if (!chatId || !Number.isFinite(messageId) || messageId <= 0) {
    return new Response(null, { status: 400 });
  }

  return new Promise((resolve) => {
    if (!client) {
      return resolve(new Response(null, { status: 404 }));
    }

    // Страховка от вечного «пустого» превью: если вкладка не ответила
    // (flood wait, потерянное соединение, клиент не авторизован), <img>
    // не должен висеть в ожидании вечно — отдаём 404, LazyImg переспросит.
    let settled = false;
    const finish = (fn, val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(val);
    };
    const timer = setTimeout(() => {
      finish(resolve, new Response(null, { status: 404, headers: { 'X-SW-Thumb': 'timeout' } }));
    }, SW_THUMB_TIMEOUT_MS);

    const messageChannel = new MessageChannel();
    messageChannel.port1.onmessage = async (msgEvent) => {
      if (msgEvent.data.error || !msgEvent.data.chunk) {
        finish(resolve, new Response(null, { status: 404 }));
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
            // private: превью закрытых каналов не должны попадать в
            // общий дисковый HTTP-кеш браузера.
            'Cache-Control': 'private, max-age=31536000, immutable'
          }
        });
        finish(resolve, response);
        // Кладём в Cache Storage в фоне, чтобы не задерживать <img>.
        // Имя кеша версионировано: при смене версии activate вычистит
        // старый tg-thumbs, а logout на странице сносит кеш целиком.
        try {
          if (cache) {
            // Ключ кеша — чистый URL без cache-buster'а ретрая и без
            // условных заголовков оригинального запроса (cache.put
            // чувствителен к Range/If-None-Match).
            const cacheKey = new Request(url.origin + url.pathname);
            await cache.put(cacheKey, response.clone());
            await trimCache(cache, MAX_THUMBS);
          }
        } catch (_) {}
      }
    };

    try {
      client.postMessage({
        type: 'fetch-tg-thumb',
        chatId,
        messageId
      }, [messageChannel.port2]);
    } catch (_) {
      finish(resolve, new Response(null, { status: 404 }));
    }
  });
}
