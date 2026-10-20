// POST /api/img        — 上传一张图片（请求体 = 原始二进制，Content-Type 标明格式）
// GET  /api/img?id=xxx — 按 id 取图（?dl=1 时带 attachment 头，触发浏览器下载）
//
// 存储：KV key = 'img:<32位hex>'，value = 原始二进制（ArrayBuffer），
//       KV metadata = { mime, size, ts }（getWithMetadata 取回，省一个 JSON key）。
//
// 性能红线：图片本体绝不写进 messages JSON —— 否则进房间一次要拉十几 MB，
// 「秒进」直接报废。消息里只挂 {img: id, w, h, mime} 百字节级元数据，
// 前端用 <img loading="lazy"> 按需加载，滚到哪加载到哪。
//
// 缓存策略：图片内容永不变化（id 即指纹），浏览器与边缘都可放心长缓存：
//   Cache-Control: public, max-age=31536000, immutable
// 与 messages 一样，缓存查询放在 checkAuth 之后——未登录请求绝不回数据。
//
// TTL 取 30 天（比房间的 3 天滑动长）：活跃房间里的图不会被提前清掉；
// 死房间的图最多多占 27 天存储，免费 1GB 可存 2000+ 张，可忽略。
// 被裁出 50 条窗口的消息，其图片 key 会自然过期，无需手动清理。

const MAX_BYTES = 2.5 * 1024 * 1024;   // 单图 2.5MB 硬上限（客户端已压到 400KB 级，这是护栏）
const IMG_TTL = 30 * 24 * 3600;        // 30 天后自动过期
const MIME_EXT = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function sha256Hex(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function checkAuth(request, env) {
  if (!env.ROOM_TOKEN || !env.MESSAGES) return false;
  const m = (request.headers.get('Cookie') || '').match(/sid=([a-f0-9]{32})/);
  if (!m) return false;
  const stored = await env.MESSAGES.get('session:' + m[1]);
  if (!stored) return false;
  return stored === (await sha256Hex(env.ROOM_TOKEN));
}

function genId() {
  const buf = new Uint8Array(16);
  crypto.getRandomValues(buf);
  return Array.from(buf).map(b => b.toString(16).padStart(2, '0')).join('');
}

// 魔数嗅探：以文件头为准，不信客户端报的 Content-Type
function sniffMime(buf) {
  const b = new Uint8Array(buf);
  if (!b || b.length < 12) return null;
  // JPEG: FF D8 FF
  if (b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return 'image/jpeg';
  // PNG: 89 50 4E 47
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47) return 'image/png';
  // GIF: GIF8
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'image/gif';
  // WebP: RIFF....WEBP
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
      b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
  return null;
}

// ===== POST /api/img =====
export async function onRequestPost({ request, env }) {
  if (!env.MESSAGES) return jsonResponse({ error: 'KV not bound' }, 500);
  if (!(await checkAuth(request, env))) return jsonResponse({ error: 'unauthorized' }, 401);

  const declared = (request.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase();
  if (!(declared in MIME_EXT)) return jsonResponse({ error: 'unsupported type' }, 415);

  let buf;
  try {
    buf = await request.arrayBuffer();
  } catch {
    return jsonResponse({ error: 'bad body' }, 400);
  }
  if (!buf || buf.byteLength === 0) return jsonResponse({ error: 'empty body' }, 400);
  if (buf.byteLength > MAX_BYTES) return jsonResponse({ error: 'too large' }, 413);

  const real = sniffMime(buf);
  if (!real || real !== declared) return jsonResponse({ error: 'not an image' }, 415);

  const id = genId();
  await env.MESSAGES.put('img:' + id, buf, {
    expirationTtl: IMG_TTL,
    metadata: { mime: real, size: buf.byteLength, ts: Math.floor(Date.now() / 1000) },
  });
  return jsonResponse({ ok: true, id, mime: real, size: buf.byteLength });
}

// ===== GET /api/img?id=xxx[&dl=1] =====
export async function onRequestGet({ request, env, context }) {
  if (!env.MESSAGES) return jsonResponse({ error: 'KV not bound' }, 500);
  if (!(await checkAuth(request, env))) return jsonResponse({ error: 'unauthorized' }, 401);

  const url = new URL(request.url);
  const id = url.searchParams.get('id') || '';
  if (!/^[a-f0-9]{32}$/.test(id)) return jsonResponse({ error: 'bad id' }, 400);
  const dl = url.searchParams.get('dl') === '1';

  // 边缘缓存：同一张图（含 dl 变体）本节点直接回，不打 KV。
  // 缓存副本自带全套响应头（Content-Type / immutable / attachment），可直接返回。
  const cacheKey = new Request(url.origin + '/__edge/img/' + id + (dl ? '?dl=1' : ''), { method: 'GET' });
  try {
    const hit = await caches.default.match(cacheKey);
    if (hit) return hit;
  } catch (e) { /* 缓存层出任何问题都退回直读 KV */ }

  const { value, metadata } = await env.MESSAGES.getWithMetadata('img:' + id, { type: 'arrayBuffer' });
  if (!value) return jsonResponse({ error: 'not found' }, 404);

  const mime = (metadata && metadata.mime) || 'application/octet-stream';
  const headers = {
    'Content-Type': mime,
    'Cache-Control': 'public, max-age=31536000, immutable',
  };
  if (dl) {
    const ext = MIME_EXT[mime] || 'bin';
    headers['Content-Disposition'] = 'attachment; filename="note220-' + id.slice(0, 8) + '.' + ext + '"';
  }

  const res = new Response(value, { headers });
  try {
    if (context && typeof context.waitUntil === 'function') {
      context.waitUntil(caches.default.put(cacheKey, res.clone()));
    }
  } catch (e) { /* 缓存失败不影响本次响应 */ }
  return res;
}

// ===== OPTIONS（CORS 预检，与 /api/messages 保持一致） =====
export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}
