// GET  /api/messages — 返回最近 N 条留言
// POST /api/messages — 追加一条新留言（unshift 到数组头，slice 滚动裁剪）
//
// 数据存在 Cloudflare KV 里：
//   key   = 'messages'
//   value = JSON 数组，[ {id, text, user_hash, color, ts}, ... ]
// 新留言 unshift 到数组头（最新在前），超过 MAX 条 slice 掉末尾。
//
// 鉴权：每个请求校验 Cookie 里的 room_token 是否等于 env.ROOM_TOKEN。

const KEY = 'messages';
const MAX = 200;        // 滚动保留条数
const MAX_TEXT = 2000;  // 单条文本最长字符
const MAX_FIELD = 64;   // user_hash/color 字段最长

function jsonResponse(obj, status, extraHeaders = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  });
}

function checkAuth(request, env) {
  if (!env.ROOM_TOKEN) return false;
  const cookie = request.headers.get('Cookie') || '';
  const m = cookie.match(/room_token=([^;]+)/);
  if (!m) return false;
  let token;
  try {
    token = decodeURIComponent(m[1]);
  } catch {
    return false;
  }
  // 常量时间比较
  if (token.length !== env.ROOM_TOKEN.length) return false;
  let diff = 0;
  for (let i = 0; i < token.length; i++) {
    diff |= token.charCodeAt(i) ^ env.ROOM_TOKEN.charCodeAt(i);
  }
  return diff === 0;
}

function genId() {
  const buf = new Uint8Array(16);
  crypto.getRandomValues(buf);
  return Array.from(buf).map(b => b.toString(16).padStart(2, '0')).join('');
}

// ===== GET /api/messages =====
export async function onRequestGet({ request, env }) {
  if (!env.MESSAGES) return jsonResponse({ error: 'KV not bound' }, 500);
  if (!checkAuth(request, env)) return jsonResponse({ error: 'unauthorized' }, 401);

  let list;
  try {
    const raw = await env.MESSAGES.get(KEY);
    list = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(list)) list = [];
  } catch {
    list = [];
  }

  return jsonResponse({ messages: list });
}

// ===== POST /api/messages =====
export async function onRequestPost({ request, env }) {
  if (!env.MESSAGES) return jsonResponse({ error: 'KV not bound' }, 500);
  if (!checkAuth(request, env)) return jsonResponse({ error: 'unauthorized' }, 401);

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: 'bad json' }, 400);
  }

  const text = (body && typeof body.text === 'string' ? body.text : '').slice(0, MAX_TEXT).trim();
  const user_hash = (body && typeof body.user_hash === 'string' ? body.user_hash : '').slice(0, MAX_FIELD);
  const color = (body && typeof body.color === 'string' ? body.color : '').slice(0, MAX_FIELD);
  if (!text) return jsonResponse({ error: 'empty text' }, 400);

  let list;
  try {
    const raw = await env.MESSAGES.get(KEY);
    list = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(list)) list = [];
  } catch {
    list = [];
  }

  const msg = {
    id: genId(),
    text,
    user_hash,
    color,
    ts: Math.floor(Date.now() / 1000),
  };
  list.unshift(msg);
  const trimmed = list.slice(0, MAX);
  await env.MESSAGES.put(KEY, JSON.stringify(trimmed));

  return jsonResponse({ ok: true, message: msg });
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
