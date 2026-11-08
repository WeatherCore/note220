// POST   /api/auth — 校验令牌 → 签发随机会话 id（KV 存指纹）→ Set-Cookie sid
// DELETE /api/auth — 「用完退出」：删 KV 会话 + 清 cookie
//
// 会话与令牌分离，为「陌生电脑」场景设计：
//   cookie 里只有 32 位随机 sid，令牌原文不落在那台机器上；
//   KV session:<sid> 的值 = {"fp": sha256(ROOM_TOKEN), "short": 是否短会话}（v2 格式），
//     改令牌 = 全部旧会话自动失效；short 供 /api/img 分流缓存策略（短会话 no-store）。
//     v1 裸指纹格式兼容读取（按短会话处理），存量设备无需重新输令牌。
//   会话寿命：默认 30 分钟（陌生电脑），勾「记住我」1 年（自己的设备）；
//   「退出」调 DELETE 即刻吊销当前会话（cookie 是 HttpOnly，前端 JS 清不掉，必须走这里）。
//
// 防爆破（v2 新增）：按 CF-Connecting-IP 记认证失败次数，固定窗口 10 分钟 10 次失败即拒。
//   只在「失败」时写计数（成功登录不记），KV 写失败一律放行（fail-open）——
//   防护优先于自锁，KV 抖动不能把真用户锁在门外。
//   注意：这挡的是低打扰慢速爆破；认真加固请上 Cloudflare WAF 速率限制（README 有章节）。

const SESSION_SHORT = 30 * 60;             // 30 分钟（陌生电脑默认）
const SESSION_REMEMBER = 365 * 24 * 3600; // 1 年（勾记住我）
const RL_WINDOW = 10 * 60;                // 失败计数窗口：10 分钟
const RL_MAX = 10;                        // 窗口内允许的失败次数上限

export async function onRequestPost({ request, env }) {
  // 服务器未配置 ROOM_TOKEN secret 时，直接拒绝（避免空字符串被绕过）
  if (!env.ROOM_TOKEN) {
    return jsonResponse({ error: 'server not configured' }, 500);
  }
  if (!env.MESSAGES) {
    return jsonResponse({ error: 'KV not bound' }, 500);
  }

  // 防爆破闸门：先查这个 IP 是否已被拉黑，超限直接 429，连令牌都不比
  const ip = getClientIp(request);
  const rlKey = 'rlauth:' + (ip || 'unknown');
  const fails = parseInt((await safeGet(env.MESSAGES, rlKey)) || '0', 10);
  if (fails >= RL_MAX) {
    return jsonResponse({ error: 'too many attempts, retry later' }, 429);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: 'bad json' }, 400);
  }

  const token = body && typeof body.token === 'string' ? body.token : '';
  const remember = !!(body && body.remember);
  // 常量时间比较，防时序攻击（寝室场景其实用不到，养成习惯）
  if (!constantTimeEqual(token, env.ROOM_TOKEN)) {
    // 失败计数 +1（成功不计数）：整桶 10 分钟后自然过期，固定窗口语义
    await safeIncrFail(env.MESSAGES, rlKey);
    return jsonResponse({ error: 'invalid token' }, 401);
  }

  const sid = genId();
  const ttl = remember ? SESSION_REMEMBER : SESSION_SHORT;
  // 会话值存令牌指纹 + 会话类别，不存令牌原文
  await env.MESSAGES.put(
    'session:' + sid,
    JSON.stringify({ fp: await sha256Hex(env.ROOM_TOKEN), short: !remember }),
    { expirationTtl: ttl }
  );

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      // HttpOnly: JS 读不到（防 XSS 偷）   Secure: 只走 HTTPS
      // SameSite=Lax: 防基本 CSRF         Max-Age 与会话 TTL 同步
      'Set-Cookie':
        'sid=' + sid + '; HttpOnly; Secure; SameSite=Lax; Max-Age=' + ttl + '; Path=/',
    },
  });
}

// ===== DELETE /api/auth — 退出：吊销会话 + 清 cookie =====
export async function onRequestDelete({ request, env }) {
  const sid = getSidFromCookie(request);
  if (sid && env.MESSAGES) {
    try { await env.MESSAGES.delete('session:' + sid); } catch (e) {}
  }
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      // Max-Age=0 让浏览器立刻丢掉 cookie
      'Set-Cookie': 'sid=; HttpOnly; Secure; SameSite=Lax; Max-Age=0; Path=/',
    },
  });
}

// ===== 防爆破辅助：全部 fail-open，KV 出问题不拦真用户 =====

// Cloudflare 边缘注入的客户端 IP；直连 localhost:8788 时可能没有，退 'unknown'
function getClientIp(request) {
  return (request.headers.get('CF-Connecting-IP') || '').trim();
}

async function safeGet(kv, key) {
  try { return await kv.get(key); } catch (e) { return null; }
}

// 失败计数：每次失败都重新起算 RL_WINDOW（滑动式固定窗，攻击者无法借旧桶续命）；
// 计数写失败静默放行 —— 攻击面让位于可用性
async function safeIncrFail(kv, key) {
  try {
    const cur = parseInt((await kv.get(key)) || '0', 10);
    await kv.put(key, String((isNaN(cur) ? 0 : cur) + 1), { expirationTtl: RL_WINDOW });
  } catch (e) { /* fail-open */ }
}

function getSidFromCookie(request) {
  const m = (request.headers.get('Cookie') || '').match(/sid=([a-f0-9]{32})/);
  return m ? m[1] : '';
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

function genId() {
  const buf = new Uint8Array(16);
  crypto.getRandomValues(buf);
  return Array.from(buf).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function sha256Hex(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}
