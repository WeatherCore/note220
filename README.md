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
note220/
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

---

## 部署到 Cloudflare（fork → 上线，约 10 分钟）

下面这条流程是把项目从 fork 到能用跑通过的最短路径，**每一步都标了坑**，照着走就行。

### 0. Fork & Clone

在 GitHub 上 fork 这个仓库到自己账号，然后 clone 到本地：

```bash
git clone https://github.com/<你的用户名>/note220.git
cd note220
```

### 1. 安装 wrangler 并登录

```bash
npm install -g wrangler
wrangler login      # 浏览器弹出 Cloudflare 登录页，登你的账号
```

### 2. 创建 KV 命名空间

```bash
wrangler kv namespace create MESSAGES
```

输出形如 `id = "2a483d7164fa4dcc899adf1348cf9930"`。**把这个 id 复制下来**，下一步要用。

### 3. 改 wrangler.toml（两处）

打开 `wrangler.toml`，改这两行：

```toml
name = "note220"                              # 改成你想要的项目名（建议保持 note220，和 Pages 项目名一致）
...
[[kv_namespaces]]
binding = "MESSAGES"
id = "2a483d7164fa4dcc899adf1348cf9930"       # ← 换成你第 2 步拿到的 id
```

改完 commit & push：

```bash
git add wrangler.toml
git commit -m "chore: 填入自己的 KV id"
git push
```

### 4. 在 Cloudflare 创建 Pages 项目（⚠️ 这一步最容易走错）

> **关键坑**：Cloudflare 新版 Dashboard 把入口合并到「Create application」，会默认带进 **Workers Builds 向导**——不要走那个！Workers Builds 自动生成的 API token 默认不带 `Pages:Edit` 权限，部署会报 `Authentication error [code: 10000]`。**必须走 Pages 经典的 Connect to Git 流程**。

正确路径：

1. Cloudflare Dashboard → 左侧 **Workers & Pages**
2. 顶部点 **Create** 按钮
3. 弹窗里**选「Pages」标签**（不是 Workers！）
4. 点 **Connect to Git**
5. 选你 fork 的 GitHub 仓库（首次会要授权 GitHub）
6. 点 **Begin setup**，逐字段填：

| 字段 | 填什么 |
|---|---|
| **Project name** | `note220`（和 wrangler.toml 的 name 保持一致） |
| **Production branch** | `main`（你 repo 的主分支） |
| **Framework preset** | `None` |
| **Build command** | **留空**（纯静态 + Functions，无构建步骤） |
| **Build output directory** | `public` |

7. **不要在这里加 Environment variables**——见下一步为什么
8. 点 **Save and Deploy**

部署会自动跑起来（约 30 秒）。完成后你会拿到一个 `https://note220.pages.dev` 之类的域名，**此时访问会显示令牌输入页，但输什么都会报错**——因为 ROOM_TOKEN 还没设。继续下一步。

### 5. 设置寝室令牌（⚠️ 第二个坑）

> **关键坑**：你的 repo 里有 `wrangler.toml`（含 `pages_build_output_dir`），这时 **toml 是项目配置的唯一事实来源，Dashboard 向导里填的环境变量会被 toml 屏蔽，实际不传进 Functions**。所以 ROOM_TOKEN 必须用 CLI 写成 secret（secret 不受 toml 屏蔽）。

```bash
npx wrangler pages secret put ROOM_TOKEN --project-name note220
# 提示 "Enter a secret value:" 时输入寝室令牌（建议 6-8 位，如 dorm4-220），回车
# 看到 "✨ Success! Uploaded secret ROOM_TOKEN" 就成了
```

**令牌强度建议**：别用 `220` 这种 3 位纯数字，公网上几秒就能 brute force 完。用 `dorm4-220`、`note-220` 这种 6-8 位混合字符串。

### 6. 触发重新部署（让 secret 生效）

> **关键坑**：Pages secrets 是部署时注入到运行环境的，**写入后必须重新部署一次才生效**。光写 secret 不重新部署，访问还是 500。

任选一种触发：

- **Dashboard**：note220 项目 → Deployments → 最近一次部署右侧「⋯」→ **Retry deployment**
- **或本地**：随便改点东西 `git push`（自动触发新部署）

部署完成后（状态变绿），刷新域名输令牌，**能进留言板就成了**。

---

## 常见报错排查

### `Authentication error [code: 10000]`

**原因**：你走的是 Workers Builds 向导，自动生成的 API token 缺 `Pages:Edit` 权限。

**解法**：删掉那个项目，按上面「第 4 步」走 **Pages → Connect to Git** 老流程。

### 服务器未配置 ROOM_TOKEN（HTTP 500）

**原因**：ROOM_TOKEN 没设，或设了但没重新部署。

**解法**：按「第 5 步」用 CLI 写 secret，然后按「第 6 步」Retry deployment。

### 令牌不对，再试（HTTP 401）

**原因**：ROOM_TOKEN 设了但值和你输的不匹配。

**解法**：重新跑 `npx wrangler pages secret put ROOM_TOKEN --project-name note220`，输入正确值，再 Retry deployment。

### 部署成功但页面 404 / 旧版本

**原因**：CDN 缓存。等 1-2 分钟，或硬刷新（Ctrl+F5）。

---

## 日常更新

部署已经连了 GitHub，以后改代码只要：

```bash
git add .
git commit -m "..."
git push
```

Cloudflare 自动拉代码重新部署，约 30 秒生效。

---

## 本地开发

```bash
npm install
wrangler pages dev ./public --kv MESSAGES --var ROOM_TOKEN:devtoken
```

打开 http://localhost:8788，令牌输 `devtoken` 即可。改代码会热重载。

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

- **改令牌**：重新跑 `wrangler pages secret put ROOM_TOKEN --project-name note220` + Retry deployment
- **想让令牌每次访问都要重输**：改 `functions/api/auth.js` 里的 `Max-Age`（现在是 1 年）
- **想分多个主题页**：多创建几个 KV key（`messages:shopping`、`messages:talk` 等）+ 前端加 URL 路由
- **想显示作者真名（不匿名）**：把 `user_hash` 改成 localStorage 里存的自定义昵称
- **想加 Markdown**：前端加 markdown-it 渲染（注意渲染顺序：先 escape 再 markdown 再 linkify，防 XSS）
- **想升级 SQL 查询**（按时间/作者筛选）：迁 KV 到 D1
