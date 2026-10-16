# 寝室留言板 (note-num)

寝室自用版 note.ms 替代品。部署在 Cloudflare Pages + KV，匿名接力留言板，无登录系统，门口令牌放行。

## 功能

- **接力留言板**：每次访问看到的是「前一人留的言」，自己输入一条新留言追加到时间线顶部，旧留言不被覆盖
- **匿名身份**：首次访问生成随机哈希存 localStorage（同设备=同一身份），哈希配 HSL 色块头像，扫一眼区分谁发的
- **滚动保留最近 200 条**（KV 单 key 撑住几千条没压力，200 是为了不变成垃圾场）
- **每条带相对时间**（3 分钟前 / 10 月 16 日 18:30）
- **纯文本 + URL 自动链接**
- **最新在顶 + 输入框在顶**：进入第一眼 = 最新一条 + 输入框
- **门口令牌**：Cloudflare 部署是公网 URL，加一个寝室共知令牌防外人。这不是登录系统，没账号没 session
- **Ctrl/⌘+Enter 快速发送**

## 项目结构

```
note-num/
├── public/
│   └── index.html        # 前端单页（含令牌输入页 + 留言板 UI + 全部 JS）
├── functions/
│   └── api/
│       ├── auth.js      # POST /api/auth  校验令牌 → Set-Cookie
│       └── messages.js  # GET/POST /api/messages  读写 KV
├── wrangler.toml         # Cloudflare 配置（KV 绑定 + 部署输出目录）
├── package.json
├── .gitignore
└── README.md
```

## 一次性配置（Cloudflare 后台，约 5 分钟）

### 1. 安装 wrangler（本地 CLI）

```bash
npm install -g wrangler   # 或 npx wrangler
wrangler login            # 浏览器登录 Cloudflare 账号
```

### 2. 创建 KV 命名空间

```bash
wrangler kv namespace create MESSAGES
```

输出形如 `id = "abcd1234..."`。把这个 id 填进 `wrangler.toml` 的 `[[kv_namespaces]] id = "..."`。

### 3. 创建 Pages 项目

去 Cloudflare 控制台 → Workers & Pages → Create → Pages → Connect to Git → 选这个 repo → 框架预设选 None，构建输出目录填 `public` → 保存。

### 4. 设置 ROOM_TOKEN secret（寝室令牌）

在线上项目里设置加密环境变量（不出现在 git 里）：

```bash
wrangler pages secret put ROOM_TOKEN --project-name note-num
```

按提示输入寝室 4 人共知的令牌（建议 6-8 位字符串，例如 `room-404`）。

### 5. 推送代码触发部署

```bash
git add .
git commit -m "init: 寝室留言板"
git push
```

Cloudflare 检测到 push 自动拉代码、构建、部署。之后每次 push 都自动部署。

### 令牌排查：输了令牌显示「不对」但确信没输错

按顺序查：

**第 1 步：看报错具体是哪种**（前端已区分，2026-10-16 后部署的版本）

- 显示「**服务器未配置 ROOM_TOKEN（HTTP 500）**」→ 环境变量没生效，看第 2 步
- 显示「**令牌不对，再试**」（HTTP 401）→ 变量在但值不匹配，看第 3 步

**第 2 步：ROOM_TOKEN 变量没生效（HTTP 500）**

你的 repo 里有 `wrangler.toml`（含 `pages_build_output_dir`），此时 **toml 是项目配置的唯一事实来源，Dashboard 里填的环境变量会被 toml 屏蔽**。所以向导里填的 ROOM_TOKEN 实际没传进 Functions。

解决办法（用 CLI 把 secret 写进项目，secret 不受 toml 屏蔽）：

```bash
npm install -g wrangler     # 如果还没装
wrangler login              # 浏览器登录（同一 Cloudflare 账号）
npx wrangler pages secret put ROOM_TOKEN --project-name note220
# 提示输入值时，输入你的寝室令牌（如 220），回车
```

然后触发一次重新部署：Dashboard → note220 项目 → Deployments → 最近一次部署右侧「⋯」→ **Retry deployment**（或本地随便改点东西 `git push`）。

**第 3 步：变量在但值不匹配（HTTP 401）**

- Dashboard → note220 → Settings → Environment variables → 确认 Production 环境的 `ROOM_TOKEN` 值（加密的看不到明文，只能编辑重设）
- 值前后**别带空格**，别用中文引号
- 改完后 Retry deployment 一次

**顺带的安全建议**：`220` 只有 3 位纯数字，公网上几秒就能 brute force 完。建议换成 6-8 位混合字符串（如 `note-220`、`dorm4-220`），改法同上（secret 重设 + Retry）。

## 本地开发

```bash
npm install              # 装 wrangler（可选）
wrangler pages dev ./public --kv MESSAGES --var ROOM_TOKEN:devtoken
```

打开 http://localhost:8788，令牌输 `devtoken` 即可。

## 数据结构

KV 里一个 key 存所有留言：

- key: `messages`
- value: JSON 数组（最新在前）

```json
[
  {
    "id": "a3f9b1c2...",
    "text": "谁去倒垃圾",
    "user_hash": "a3f9b1c2",
    "color": "hsl(123, 65%, 55%)",
    "ts": 1697000000
  }
]
```

新留言 `unshift` 到数组头，`slice(0, 200)` 滚动裁剪。

## API

| 方法 | 路径 | 鉴权 | 作用 |
|------|------|------|------|
| GET  | `/`                | —    | 静态前端 |
| POST | `/api/auth`        | —    | 校验令牌，对了设 `room_token` HttpOnly cookie（一年期）|
| GET  | `/api/messages`    | cookie | 返回最近 200 条 |
| POST | `/api/messages`    | cookie | 追加一条，body `{text, user_hash, color}` |

## 安全边界

- 令牌是 `HttpOnly` cookie，前端 JS 读不到，防 XSS 偷
- `SameSite=Lax`，防基本 CSRF
- 服务器端常量时间比较令牌，防时序攻击（寝室场景其实用不到，养成习惯）
- 用户输入文本服务端长度截断（最多 2000 字），输出前端先 HTML escape 再做 URL 自动链接，防 XSS
- Cloudflare 默认有边缘 DDoS 防护 + 人机验证（按需开）

## 想改的事

- 想让令牌更严？改 `functions/api/auth.js` 里的 `Max-Age`，或者每次访问都要重输
- 想分多个主题页？多创建几个 KV key（`messages:shopping`、`messages:talk` 等），前端加 URL 路由
- 想显示作者名（不是匿名）？把 `user_hash` 改成 `localStorage` 里存的自定义昵称
- 想加 Markdown？前端加一个 markdown-it 渲染（注意保持 escape 顺序：先 escape 再 markdown 再 linkify）
