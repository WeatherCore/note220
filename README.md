# 寝室留言板 (note220)

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

## 一次性配置（Cloudflare 后台）

> 前置：KV 命名空间已创建，id 已填进 `wrangler.toml`（✅ 已完成）。`ROOM_TOKEN` 不用提前设，向导里填。

### 步骤 0：先把本地 wrangler.toml 推上 GitHub

```bash
git add wrangler.toml
git commit -m "chore: 对齐项目名 note220"
git push
```

⚠️ 必须先 push：向导部署时用的是 GitHub 上的 `wrangler.toml`，本地没推上去会导致部署名对不上（远端还是 `note-num`，会和向导里的 `note220` 冲突）。

### 步骤 1：Dashboard 向导逐字段对照

| 界面字段 | 填什么 | 说明 |
|---|---|---|
| **项目名称** | `note220`（默认） | 保持和 `wrangler.toml` 里的 `name` 一致即可 |
| **构建命令** | **留空** | 纯静态 + Functions，没有任何构建步骤 |
| **部署命令** | `npx wrangler pages deploy` | ⚠️ 把默认的 `npx wrangler deploy` 改成这个——显式按 Pages 项目部署，name 和输出目录自动从 wrangler.toml 读 |
| **预览命令** | 留空 | 非必填；如果界面不让留空，填 `npx wrangler pages deploy` |
| **启用预览构建** | 关 | 省构建额度，PR 预览用不上 |
| **使用 Cloudflare Access 保护** | 关 | 我们有自己的令牌 |
| **路径** | `/`（默认） | 不动 |
| **API 令牌** | 不动 | 「将自动创建新令牌」就好 |
| **变量名称** | `ROOM_TOKEN` | 寝室门口令牌的变量名，代码里 `env.ROOM_TOKEN` 读的就是它 |
| **变量值** | 寝室令牌（如 `room-404`） | 6-8 位，4 人共知。**务必点旁边的「加密」**，加密后 dashboard 里也看不到明文 |

### 步骤 2：点「部署」

向导会自动从 GitHub 拉代码 → 构建 → 部署。成功后访问 `https://note220.pages.dev`（具体域名以部署完页面显示为准），输令牌能进留言板就通了。

之后日常更新 = 本地 `git push`，Cloudflare 自动重新拉取部署。

### 令牌后续想改？

Dashboard → 你的项目 → Settings → 环境变量（Variables）→ 编辑 `ROOM_TOKEN` 的值 → 保存后下次部署生效。或者用 CLI：

```bash
npx wrangler pages secret put ROOM_TOKEN --project-name note220
```

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
