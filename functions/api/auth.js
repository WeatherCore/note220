// POST /api/auth — 校验寝室令牌，对了设一年期 HttpOnly cookie
// 这不是登录系统：没账号、没 session、没用户身份。
// 就是个门口暗号：输对了设 cookie，后续请求带 cookie 就放行。
export async function onRequestPost({ request, env }) {
  // 服务器未配置 ROOM_TOKEN secret 时，直接拒绝（避免空字符串被绕过）
  if (!env.ROOM_TOKEN) {
    return jsonResponse({ error: 'server not configured' }, 500);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: 'bad json' }, 400);
  }

  const token = body && typeof body.token === 'string' ? body.token : '';
  // 常量时间比较，防时序攻击（寝室场景其实用不到，但养成习惯）
  const ok = constantTimeEqual(token, env.ROOM_TOKEN);
  if (!ok) {
    return jsonResponse({ error: 'invalid token' }, 401);
  }

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      // HttpOnly: JS 读不到（防 XSS 偷 cookie）
      // Secure: 只走 HTTPS（Cloudflare 默认 HTTPS）
      // SameSite=Lax: 防基本 CSRF
      // Max-Age=1 年：输一次令牌，一年免再输
      'Set-Cookie':
        'room_token=' + encodeURIComponent(token) +
        '; HttpOnly; Secure; SameSite=Lax; Max-Age=31536000; Path=/',
    },
  });
}

function jsonResponse(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function constantTimeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
