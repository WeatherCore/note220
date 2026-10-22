// GET  /api/messages?room=xxx — 返回该房间最近 50 条
// POST /api/messages — 追加一条新留言（unshift 到数组头，裁剪后写回 KV）
// DELETE /api/messages?room=xxx&id=yyy — 撤回一条留言（全员可删，带图连本体一起清）
//
// 数据模型（每个房间一个 key）：
//   key   = 'messages:<房间名>'（房间名仅允许 1-32 位字母/数字/ - / _，防野 key）
//   value = JSON 数组，[ {id, text, name, color, ts, img?, mime?, w?, h?}, ... ]，最新在前
// 可选图片字段：img = 32 位 hex id（本体存 KV 'img:<id>'，走 /api/img 通道），
// 只存百字节级元数据，绝不把图片塞进消息 JSON（否则进房间一次拉十几 MB）。
// 写入带 3 天滑动 TTL：房间 3 天没人发言就整个自动清空，活跃房间每次发言续期。
//
// 鉴权：cookie 里的 sid 是随机会话 id（由 /api/auth 签发），
// KV session:<sid> 的值 = sha256(ROOM_TOKEN)，对得上才放行。
// cookie 里不存令牌原文——这是为「陌生电脑」场景设计的。

const ROOM_TTL = 3 * 24 * 3600;        // 房间滑动过期：3 天没人发言整间清空
const MAX = 50;                        // 每房间保留条数
const MAX_TEXT = 100000;               // 单条文本最长字符（约一个完整源文件）
const MAX_FIELD = 64;                  // name/color 字段最长
const TOTAL_LIMIT = 4 * 1024 * 1024;   // 单房间总长护栏（KV value 上限 25MB，留足余量）
const EDGE_TTL = 10;                   // GET 结果的边缘缓存秒数：显著加快「秒进」，POST 时主动失效

function jsonResponse(obj, status, extraHeaders = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  });
}

function getRoomName(str) {
  return typeof str === 'string' && /^[a-zA-Z0-9_-]{1,32}$/.test(str) ? str : 'main';
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
  // 掺入令牌指纹：改令牌 = 全部旧会话自动失效
  return stored === (await sha256Hex(env.ROOM_TOKEN));
}

function genId() {
  const buf = new Uint8Array(16);
  crypto.getRandomValues(buf);
  return Array.from(buf).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function readList(env, room) {
  try {
    const raw = await env.MESSAGES.get('messages:' + room);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

// ===== GET /api/messages =====
export async function onRequestGet({ request, env, context }) {
  if (!env.MESSAGES) return jsonResponse({ error: 'KV not bound' }, 500);
  if (!(await checkAuth(request, env))) return jsonResponse({ error: 'unauthorized' }, 401);

  const url = new URL(request.url);
  const room = getRoomName(url.searchParams.get('room'));

  // 边缘缓存：同一房间 10 秒内的重复 GET 直接回本节点缓存，不打 KV。
  // 注意必须放在 checkAuth 之后——绝不能把留言数据回给未登录请求。
  // 缓存内容是「房间级」数据（和哪个用户无关），按 URL 缓存是安全的。
  const cacheKey = new Request(url.origin + '/__edge/messages?room=' + room, { method: 'GET' });
  try {
    const hit = await caches.default.match(cacheKey);
    if (hit) {
      const body = await hit.text();
      return new Response(body, {
        headers: {
          'Content-Type': 'application/json',
          // 给浏览器的响应保持 no-store：防止「发完消息 → 重拉列表」命中浏览器缓存看不到新留言
          'Cache-Control': 'no-store',
        },
      });
    }
  } catch (e) { /* 缓存层出任何问题都退回直读 KV */ }

  const list = await readList(env, room);
  const payload = JSON.stringify({ room: room, messages: list });

  // 存进边缘缓存的副本带短 TTL；返回给浏览器的那份是 no-store
  const cacheRes = new Response(payload, {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=' + EDGE_TTL,
    },
  });
  try {
    if (context && typeof context.waitUntil === 'function') {
      context.waitUntil(caches.default.put(cacheKey, cacheRes));
    } else {
      await caches.default.put(cacheKey, cacheRes);
    }
  } catch (e) { /* 缓存失败不影响本次响应 */ }

  return new Response(payload, {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

// ===== POST /api/messages =====
export async function onRequestPost({ request, env }) {
  if (!env.MESSAGES) return jsonResponse({ error: 'KV not bound' }, 500);
  if (!(await checkAuth(request, env))) return jsonResponse({ error: 'unauthorized' }, 401);

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: 'bad json' }, 400);
  }

  const room = getRoomName(body && body.room);
  const text = (body && typeof body.text === 'string' ? body.text : '').slice(0, MAX_TEXT).trim();
  const name = (body && typeof body.name === 'string' ? body.name : '').slice(0, MAX_FIELD).trim();
  const color = (body && typeof body.color === 'string' ? body.color : '').slice(0, MAX_FIELD);

  // 图片元数据（可选）：img 必须是 /api/img 签发的 32 位 hex id。
  // mime 只接受白名单；w/h 是缩略图占位尺寸，防布局跳动用，限个安全范围。
  const imgId = body && typeof body.img === 'string' ? body.img : '';
  if (imgId && !/^[a-f0-9]{32}$/.test(imgId)) return jsonResponse({ error: 'bad img id' }, 400);
  const IMG_MIMES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
  const mime = body && typeof body.mime === 'string' && IMG_MIMES.indexOf(body.mime) !== -1 ? body.mime : '';
  const w = body && Number.isInteger(body.w) ? Math.min(Math.max(body.w, 0), 10000) : 0;
  const h = body && Number.isInteger(body.h) ? Math.min(Math.max(body.h, 0), 10000) : 0;

  // 有图可无文字，有字可无图，但两者都不能空
  if (!text && !imgId) return jsonResponse({ error: 'empty text' }, 400);
  if (imgId && !mime) return jsonResponse({ error: 'bad img mime' }, 400);

  const list = await readList(env, room);
  const msg = {
    id: genId(),
    text,
    name,
    color,
    ts: Math.floor(Date.now() / 1000),
  };
  if (imgId) {
    msg.img = imgId;
    msg.mime = mime;
    if (w) msg.w = w;
    if (h) msg.h = h;
  }
  list.unshift(msg);

  let trimmed = list.slice(0, MAX);
  let json = JSON.stringify(trimmed);
  if (json.length > TOTAL_LIMIT) {
    // 总长超护栏：从最旧的一条开始丢，直到塞得下
    // （每丢一条只序列化那一条，避免每轮全量重新序列化）
    let excess = json.length - TOTAL_LIMIT;
    while (trimmed.length > 1 && excess > 0) {
      excess -= JSON.stringify(trimmed[trimmed.length - 1]).length + 1; // +1 是逗号
      trimmed = trimmed.slice(0, -1);
    }
    json = JSON.stringify(trimmed);
  }
  await env.MESSAGES.put('messages:' + room, json, { expirationTtl: ROOM_TTL });

  // 有新留言：立刻失效该房间的边缘缓存，下一次 GET（包括刷新页面）拿到的是新数据
  try {
    const origin = new URL(request.url).origin;
    await caches.default.delete(new Request(origin + '/__edge/messages?room=' + room, { method: 'GET' }));
  } catch (e) { /* 失效失败也只是多等 10 秒 TTL */ }

  return jsonResponse({ ok: true, message: msg });
}

// ===== DELETE /api/messages?room=xxx&id=<32位hex> =====
// 撤回消息，全员可删：房间是共用的，任何持有效会话的人都能删任何一条。
// 实现 = 从数组里去掉该 id 后整体写回（与 POST 同样的读改写竞态窗口，
// 极端并发下可能互相覆盖，对寝室场景可接受；迁 D1 后变成 DELETE WHERE id=?）。
export async function onRequestDelete({ request, env, context }) {
  if (!env.MESSAGES) return jsonResponse({ error: 'KV not bound' }, 500);
  if (!(await checkAuth(request, env))) return jsonResponse({ error: 'unauthorized' }, 401);

  const url = new URL(request.url);
  const room = getRoomName(url.searchParams.get('room'));
  const id = url.searchParams.get('id') || '';
  // id 必须是 /api/messages 签发的 32 位 hex，与图片 id 同一套白名单
  if (!/^[a-f0-9]{32}$/.test(id)) return jsonResponse({ error: 'bad id' }, 400);

  const list = await readList(env, room);
  const idx = list.findIndex(function (m) { return m && m.id === id; });
  if (idx === -1) return jsonResponse({ error: 'not found' }, 404);
  const removed = list.splice(idx, 1)[0];

  // 带图消息：顺手删掉图片本体 key（否则它会孤悬到 30 天自然过期，白占存储）
  // 清理失败不影响消息删除本身——残留 key 有 TTL 兜底
  if (removed && removed.img) {
    try {
      const p = env.MESSAGES.delete('img:' + removed.img);
      if (context && typeof context.waitUntil === 'function') {
        context.waitUntil(p);
      } else {
        await p;
      }
    } catch (e) { /* 忽略 */ }
  }

  // 写回并滑动续期：删除也算房间活动，与 POST 口径一致
  await env.MESSAGES.put('messages:' + room, JSON.stringify(list), { expirationTtl: ROOM_TTL });

  // 与 POST 一致：立刻失效该房间的边缘缓存，其他人的下一次刷新拿到的是删后数据
  try {
    const origin = new URL(request.url).origin;
    await caches.default.delete(new Request(origin + '/__edge/messages?room=' + room, { method: 'GET' }));
  } catch (e) { /* 失效失败也只是多等 10 秒 TTL */ }

  return jsonResponse({ ok: true });
}

// ===== OPTIONS（CORS 预检，给本地开发用） =====
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
