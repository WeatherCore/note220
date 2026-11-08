<div align="center">

# 📮 note220 · 快传板

**免登录的跨设备传输板 —— 陌生电脑 ↔ 手机之间传文字、代码、图片，朋友之间快速递东西，不用登录 QQ/微信**

*No login. No install. Just a link.*

![JavaScript](https://img.shields.io/badge/JavaScript-ES2022-F7DF1E?style=flat-square&logo=javascript&logoColor=black)
![Cloudflare Pages](https://img.shields.io/badge/Cloudflare-Pages-F38020?style=flat-square&logo=cloudflare&logoColor=white)
![Cloudflare KV](https://img.shields.io/badge/Cloudflare-KV-F38020?style=flat-square&logo=cloudflare&logoColor=white)
![Zero Framework](https://img.shields.io/badge/Framework-None-1C1917?style=flat-square)
![License](https://img.shields.io/badge/License-MIT-1C1917?style=flat-square)

[快速开始](#-快速开始) · [架构总览](#-架构总览) · [功能全景](#-功能全景) · [深入细节](#-深入细节) · [部署](#-部署上线-cloudflare)

</div>

---

## 这是什么

> **不注册、不装 App、不扫码 —— 一个共知令牌进门，一条链接递东西。**

在别人的电脑上想给自己发段代码？想给朋友递个文件链接又不想加微信？note220 就是干这个的：部署在 Cloudflare Pages + KV 上的自用快传板，**无账号系统，门口令牌放行**。固定房间名当常驻留言板用，随机房间名做一次性传输管道（origin：note.ms 替代品）。

三个文件就是整个后端（`auth.js` / `messages.js` / `img.js`），前端是零框架单文件 HTML，全部状态活在 URL hash 和 KV 里 —— fork 下来 10 分钟就能有自己的一个。

**四大设计支柱：**

| 支柱 | 做法 | 落点 |
|---|---|---|
| 🔑 **令牌门口制** | 无账号，令牌换 32 位随机会话；cookie 不存令牌原文，KV 存 `sha256(令牌)` 指纹，改令牌 = 全会话失效；按 IP 防爆破（10 次失败/10 分钟） | `functions/api/auth.js` |
| 🔗 **链接即房间** | URL 带 `#r=房间名` 即独立消息流，发链接 = 分享房间；服务端正则白名单防野 key | `functions/api/messages.js` |
| ⚡ **秒进** | `<head>` 里预取首屏数据、GET 走边缘缓存（10s，POST 主动失效）、字体自托管 swap 异步加载 —— 国内不再被 Google Fonts 白屏卡死 | `public/index.html` + `functions/api/messages.js` |
| 🔥 **不留底** | 房间 3 天没人发言整间焚毁（活跃续期）；图片 30 天自然过期；「退出」即刻吊销会话，短会话（陌生电脑）图片响应不落浏览器磁盘 | `wrangler.toml` KV TTL + `functions/api/img.js` |

## 🏗️ 架构总览

```mermaid
flowchart TB
    subgraph B["浏览器 · 零框架单页（public/index.html）"]
        UI["令牌门 / 留言板 / 上传进度 / Lightbox / 轮询"]
    end
    subgraph CF["Cloudflare Pages"]
        S["静态资源：HTML + 自托管字体 + _headers 缓存策略"]
        F["Functions：auth.js · messages.js · img.js"]
        C["边缘缓存 caches.default"]
    end
    subgraph KV["KV 命名空间 MESSAGES"]
        K1[("messages:房间名<br/>50 条 · 4MB · 3 天滑动焚毁")]
        K2[("session:sid<br/>指纹 + 会话类别")]
        K3[("rlauth:IP<br/>防爆破失败计数")]
        K4[("img:32位hex<br/>图片本体 · 30 天")]
    end
    B -- "① POST /api/auth：令牌 → sid 会话" --> F
    B -- "② GET /api/messages（先查边缘缓存，30s 轮询）" --> C
    B -- "③ POST /api/img：图片本体 → id（XHR 进度条）" --> F
    C -- "未命中（10s TTL）回源" --> F
    F -- "读写四类 key" --> KV
    S --- B
```

## ✨ 功能全景

- 🔗 **多房间** — URL 带 `#r=房间名` 即独立房间，点房间名换房/开新房（面板里带最近 8 个房间的点即跳）；固定名当留言板，随机名做一次性管道
- 🔑 **免登录会话** — 输一次令牌拿 32 位 sid；默认 30 分钟过期（陌生电脑友好），勾「记住我」1 年免输，随时「退出」吊销；按 IP 防爆破，10 分钟内 10 次输错直接拦下
- 🖼 **图片消息** — 插图按钮或 Ctrl/⌘+V 直接粘贴截图；**原图直传**（不压缩、不重编码，EXIF 方向由浏览器解码路径自动摆正，jpeg/png/webp/gif/avif，单图 ≤20MB）；**上传实时进度条 + 可取消**；服务端魔数嗅探；列表自适应展示（手机竖拍占约半屏高，长图/全景自动转裁切卡 + 角标）+ 点击全屏 Lightbox + 原图下载
- 🗑 **消息撤回** — 每条消息一键删除，全员可删（房间共用，confirm 防误触）；带图消息连图片本体一起清；服务端同步失效边缘缓存
- 🔥 **焚毁此房间** — 顶栏红色「焚毁」按钮，单次确认后整间清空（含全部图片本体），不用手动删 50 条
- 📄 **大代码片段** — 单条上限 10 万字符（约一个完整源文件）；超 6 行或 2000 字自动折叠，预览露前 6 行，展开时才注入全文 DOM（防卡顿），「复制」一键拿走全文
- ⚡ **秒进体验** — 首屏请求提前到 `<head>` 并行发起；GET 结果边缘缓存 10 秒、发消息后主动失效；IBM Plex Sans + JetBrains Mono 自托管，`font-display: swap` 渲染零阻塞
- 🔄 **活页面** — 页面可见时 30 秒轮询 + 回前台立即刷新；列表没变化不重绘，打字不被打断；后台到达的新消息进标签页标题角标 `(3) note220`，切回前台清零
- ✍️ **草稿不丢** — 输入内容按房间自动存 localStorage：发消息撞上会话过期、删消息、改名字，任何重绘后草稿都还在
- 🪪 **昵称身份** — 首次访问随机分名，点名字可改（内联面板），接收方认得出是谁发的
- 🧰 **顺手细节** — 相对时间、Ctrl+Enter 快速发送、URL 自动链接、最新在顶 + 输入框在顶、亮色 Swiss 界面（stone 暖灰 + 深墨黑 CTA，触控目标与对比度过 a11y 基线；toast/内联错误带 `role="alert"`/`aria-live`，Lightbox 有焦点圈定）

## 🧱 技术栈

| 层 | 选型 | 说明 |
|---|---|---|
| 前端 | 原生 HTML/CSS/JS 单文件 | 无框架、无构建、无运行时依赖 |
| 字体 | IBM Plex Sans ×5 + JetBrains Mono ×3 | Google Fonts latin 子集 woff2 自托管 |
| 后端 | Cloudflare Pages Functions | 3 个 API 文件，按文件路径即路由 |
| 存储 | Cloudflare KV | 消息 / 会话 / 防爆破计数 / 图片 四类 key |
| 缓存 | `caches.default` 边缘缓存 + `_headers` | 动态 10s 短缓存，静态 1 年 immutable，图片按会话类别分流 |

## 📁 项目结构

```
note220/
├── public/
│   ├── index.html        # 前端单页：令牌门 + 留言板 + 上传进度 + 全部 JS（~1500 行）
│   ├── fonts.css         # 自托管字体声明表（font-display:swap，异步加载不阻塞渲染）
│   ├── fonts/            # 8 个 woff2（IBM Plex Sans ×5 + JetBrains Mono ×3，latin 子集）
│   └── _headers          # 静态缓存策略：字体 1 年 immutable，fonts.css 1 天
├── functions/api/
│   ├── auth.js           # POST/DELETE /api/auth — 令牌换随机会话、退出吊销、IP 防爆破
│   ├── messages.js       # GET/POST/DELETE /api/messages — 按房间读写 KV + 边缘缓存 + 焚毁整间
│   └── img.js            # POST/GET /api/img — 图片上传与读取（魔数嗅探 + 会话分流缓存）
├── wrangler.toml         # Cloudflare 配置（KV 绑定 + 部署输出目录）
├── package.json          # dev / deploy 脚本
└── README.md
```

---

## 🚀 快速开始

### 本地开发（1 分钟跑起来）

```bash
npm install
npm run dev
```

打开 http://localhost:8788 ，令牌输 `devtoken` 即可。改代码自动热重载（`dev` 脚本 = `wrangler pages dev ./public --kv MESSAGES -b ROOM_TOKEN=devtoken`）。

### 部署上线（Cloudflare）

> 把项目从 fork 到上线、每步的坑都标好了，完整流程见下方 [部署上线（Cloudflare）](#-部署上线-cloudflare) 章节，约 10 分钟。日常更新只需 `git push`，Cloudflare 自动重新部署。

## 📖 深入细节

### 图片消息链路（核心机制）

图片本体**绝不写进消息 JSON** —— 否则进房间一次要拉十几 MB，「秒进」直接报废。消息里只挂百字节级元数据，本体走独立通道：

```mermaid
sequenceDiagram
    autonumber
    participant U as 发送方浏览器
    participant F as Functions /api
    participant KV as KV
    participant R as 接收方浏览器
    U->>U: 选图/粘贴 → 原图直传（不压缩，仅解码校验 + 读 w/h）
    U->>F: POST /api/img（XHR，上传进度条实时显示，可取消）
    F->>F: 魔数嗅探文件头（不信 Content-Type）
    F->>KV: put img:<id>（30 天 TTL，metadata 存 mime/size）
    F-->>U: { id, mime, size }
    U->>F: POST /api/messages（text + { img:id, mime, w, h }）
    F->>KV: unshift 进 messages:<房间>，并失效该房间边缘缓存
    R->>F: GET /api/messages
    F-->>R: 消息列表（含图片元数据，w/h 提前占位防跳版）
    R->>F: GET /api/img?id=xxx（loading=lazy 滚到哪加载到哪）
    F-->>R: 图片本体（长会话 immutable 长缓存 / 短会话 no-store 不落盘）
```

### 数据结构（KV 四类 key）

| key | value | TTL |
|---|---|---|
| `messages:<房间名>` | JSON 数组（最新在前）：`[{id, text, name, color, ts, img?, mime?, w?, h?}, …]`，单条 ≤10 万字符、每房间 50 条、总长 ≤4MB | 3 天滑动 |
| `session:<sid>` | `{"fp": sha256(ROOM_TOKEN), "short": bool}`（**不存令牌原文**；short 区分短/长会话，供图片缓存分流） | 30 分钟 / 1 年 |
| `rlauth:<IP>` | 失败次数（字符串数字），认证失败 +1，成功不计数 | 10 分钟 |
| `img:<32位hex>` | 图片本体 ArrayBuffer + metadata `{mime, size, ts}` | 30 天 |

```json
[
  {
    "id": "a3f9b1c2...",
    "text": "npm install 半天卡住的同学看这个 config：…",
    "name": "老王",
    "color": "hsl(123, 65%, 55%)",
    "ts": 1697000000,
    "img": "9f8e7d6c5b4a3210fedcba9876543210",
    "mime": "image/webp",
    "w": 1280,
    "h": 720
  }
]
```

新留言 `unshift` 到数组头，`slice(0, 50)` 滚动裁剪；超 4MB 时从最旧的开始丢。被裁出 50 条窗口的消息，其图片 key 会自然过期，无需手动清理。

### API

| 方法 | 路径 | 鉴权 | 作用 |
|------|------|------|------|
| GET | `/` | — | 静态前端 |
| POST | `/api/auth` | — | 校验令牌，签发随机 sid，body `{token, remember}`（默认 30 分钟 / 记住我 1 年）；同 IP 10 分钟内 10 次失败后回 429 |
| DELETE | `/api/auth` | — | 退出：吊销当前会话 + 清 cookie |
| GET | `/api/messages?room=xxx` | cookie | 返回 `{room, messages[]}`（边缘缓存 10s，浏览器侧 no-store） |
| POST | `/api/messages` | cookie | 追加一条，body `{room, text, name, color, img?, mime?, w?, h?}`（color 服务端锁死 `hsl(h,s%,l%)` 格式） |
| DELETE | `/api/messages?room=xxx&id=yyy` | cookie | 撤回指定消息（全员可删），带图消息顺带清图片本体 |
| DELETE | `/api/messages?room=xxx&all=1` | cookie | **焚毁整间**：删房间 key + 清列表里全部图片本体 + 失效边缘缓存 |
| POST | `/api/img` | cookie | 上传图片二进制（≤20MB，jpeg/png/webp/gif/avif），返回 `{id, mime, size}` |
| GET | `/api/img?id=xxx[&dl=1]` | cookie | 取图；`dl=1` 带 attachment 头触发下载；长会话 1 年 immutable，短会话 no-store |

### 性能设计（为什么它能「秒进」）

- **首屏**：首屏数据请求在 `<head>` 里发起，与样式/字体/HTML 解析完全并行，省掉「下载完 HTML 才开始请求 API」的一整个来回
- **字体**：`media` 交换技巧异步加载 + `font-display: swap` —— 先用系统字体立刻出内容；不再请求 fonts.googleapis.com（国内重灾区，整页白屏的最大元凶）
- **读路径**：GET 结果写边缘缓存（本节点直接回，不打 KV），TTL 仅 10 秒；缓存查询放在 `checkAuth` **之后**，未登录请求绝不回数据；发给浏览器的响应始终 `no-store`，防止「发完消息重拉列表看不到新留言」
- **写路径**：POST 成功后立刻 `caches.default.delete` 失效该房间缓存，刷新即见新数据
- **图片**：元数据（百字节）与本体分离；本体 id 即指纹、内容永不变化；**缓存按会话类别分流**——长会话 immutable 进边缘+浏览器，短会话 no-store 两边都不落（陌生电脑看完即走，退出后磁盘不留图）
- **轮询**：页面可见时 30s 一次静默拉取，比对新消息 id 集合，无变化不重绘；边缘缓存让轮询基本打不进 KV
- **长文**：渲染时只渲染预览，展开时才把全文 escape + linkify 注入 DOM —— 折叠判断行数优先（>6 行）+ 字符兜底（>2000 字，拦压缩 JS/base64 这种一整行没换行的）

### 安全边界

- **会话与令牌分离**（为陌生电脑设计）：cookie 只存 32 位随机 sid，**不存令牌原文**；KV 会话掺 `sha256(令牌)` 指纹，改令牌 = 全部旧会话自动失效；「退出」即刻吊销单会话
- **防爆破**：按 `CF-Connecting-IP` 记认证失败次数，10 分钟窗口内 10 次失败即 429；只在失败时写 KV（成功不计数），KV 写失败一律放行（fail-open，不把自己锁在门外）。认真加固请叠加 Cloudflare WAF 速率限制（见下方可选加固）
- **短会话不留痕**：没勾「记住我」= 陌生电脑，图片响应 `no-store` 且不进边缘缓存——退出/过期后本机浏览器磁盘不留任何图，吊销会话才真正吊销了可见性
- cookie 为 `HttpOnly`（JS 读不到，防 XSS 偷）+ `Secure` + `SameSite=Lax`（防基本 CSRF）；陌生电脑默认 30 分钟过期
- 房间名服务端正则白名单（1-32 位字母/数字/`-`/`_`），图片 id 同样 32 位 hex 白名单校验，防写出野 key
- **color 字段服务端锁死** `hsl(数字, 数字%, 数字%)` 格式——它会被原样拼进 `style` 属性，裸收任意字符串等于开放 CSS 注入
- 图片上传**魔数嗅探文件头**，且必须与声明的 Content-Type 一致 —— 不信客户端自报的类型
- 用户文本服务端截断（单条 10 万字符、每房间总长 4MB），输出前端先 HTML escape 再做 URL 自动链接，防 XSS
- 服务器端常量时间比较令牌，防时序攻击（寝室场景其实用不到，养成习惯）
- **诚实声明的软肋**（自用系统取舍）：
  - 房间是软隔离 —— 拿到令牌的人可以访问任意房间名，随机房间名只是「不猜就看不见」
  - 身份可伪造 —— 昵称纯客户端自报、无认证，别在这里传救命级别的东西
  - 图片按 id 寻址 —— id 是 32 位随机 hex 猜不出来，但拿到消息就能拿到 id，与房间同一信任级别
  - `/api/auth` 的 IP 防爆破挡的是低打扰慢速攻击（KV 计数有成本、攻击者可换 IP）；并发发消息存在后写覆盖丢消息窗口（KV 最终一致）；消息接口无速率限制

### 可选加固：Cloudflare WAF 速率限制（零代码，更硬）

代码里的防爆破是「fork 即得」的兜底。如果你认真在用，建议在 Dashboard 再叠一条 WAF 规则，它跑在边缘最前面、不消耗你的 KV 写额度：

1. Cloudflare Dashboard → 你的域名（或 Workers 子域所在域）→ **安全性 → WAF → 速率限制规则**
2. 新建规则：匹配 `http.request.uri.path eq "/api/auth"`（免费版可用主机名级匹配；付费版可细到路径），阈值建议 **30 次/分钟**，动作 **Block**
3. 保存即生效，无需改代码

> 免费版 WAF 速率限制只有 1 条规则的额度，建议留给 `/api/auth`——它是全站唯一不做会话校验就吃请求体的端点。

## 🛠️ 配置与调参

### 环境变量 / 绑定

| 名称 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `ROOM_TOKEN` | Pages Secret | ✅ | 进门令牌，用 CLI 写入（见部署第 5 步） |
| `MESSAGES` | KV 绑定 | ✅ | `wrangler.toml` 里的 `kv_namespaces`，存全部数据 |

### 常量速查表（想改行为改这里）

| 常量 | 位置 | 默认值 | 含义 |
|---|---|---|---|
| `SESSION_SHORT` | `functions/api/auth.js` | 30 分钟 | 陌生电脑会话寿命 |
| `SESSION_REMEMBER` | `functions/api/auth.js` | 1 年 | 「记住我」会话寿命 |
| `RL_WINDOW` / `RL_MAX` | `functions/api/auth.js` | 10 分钟 / 10 次 | 防爆破窗口与失败上限 |
| `ROOM_TTL` | `functions/api/messages.js` | 3 天 | 房间自动焚毁（滑动） |
| `MAX` | `functions/api/messages.js` | 50 | 每房间保留条数 |
| `MAX_TEXT` | `functions/api/messages.js` | 100 000 | 单条文本字符上限 |
| `TOTAL_LIMIT` | `functions/api/messages.js` | 4MB | 单房间总长护栏 |
| `EDGE_TTL` | `functions/api/messages.js` | 10 秒 | GET 边缘缓存时长 |
| `MAX_BYTES` | `functions/api/img.js` | 20MB | 单图上传上限（原图直传；KV 单值上限 25MB，留了余量） |
| `IMG_TTL` | `functions/api/img.js` | 30 天 | 图片自动过期 |
| `30000`（轮询间隔） | `public/index.html` | 30 秒 | 页面可见时的静默刷新频率 |

其他想改的：**改令牌** → 重新跑部署第 5 步的 secret 命令 + Retry deployment（全部旧会话自动失效，所有设备重输）；**要加 Markdown** → 前端加 markdown-it（注意顺序：先 escape 再 markdown 再 linkify，防 XSS）；**被 4MB 全量拉取拖慢** → 改两段式加载（列表只回 500 字预览 + 单条详情接口）；**消灭并发丢消息** → 迁 D1，append 型 INSERT 顺带解决。

## 🚢 部署上线 Cloudflare

下面是 fork 到能用的最短路径，**每一步都标了坑**，照着走就行。

### 0. Fork & Clone

在 GitHub 上 fork 本仓库，然后：

```bash
git clone https://github.com/<你的用户名>/note220.git
cd note220
```

### 1. 安装 wrangler 并登录

```bash
npm install -g wrangler
wrangler login      # 浏览器弹出 Cloudflare 登录页
```

### 2. 创建 KV 命名空间

```bash
wrangler kv namespace create MESSAGES
```

输出形如 `id = "2a483d71..."`，**复制这个 id**。

### 3. 改 wrangler.toml

```toml
name = "note220"                              # 项目名（建议保持，与 Pages 项目名一致）
[[kv_namespaces]]
binding = "MESSAGES"
id = "2a483d7164fa4dcc899adf1348cf9930"       # ← 换成第 2 步拿到的 id
```

改完 commit & push。

### 4. 创建 Pages 项目（⚠️ 最容易走错的一步）

> **关键坑**：新版 Dashboard 把入口合并到「Create application」，会默认带进 **Workers Builds 向导** —— 不要走那个！它的自动 API token 缺 `Pages:Edit` 权限，部署会报 `Authentication error [code: 10000]`。**必须走 Pages 经典的 Connect to Git 流程**。

正确路径：

1. Cloudflare Dashboard → 左侧 **Workers & Pages**
2. 顶部点 **Create** 按钮
3. 弹窗里**选「Pages」标签**（不是 Workers！）
4. 点 **Connect to Git**
5. 选你 fork 的 GitHub 仓库（首次会要授权 GitHub）
6. 点 **Begin setup**，逐字段填：

| 字段                       | 填什么                                         |
| -------------------------- | ---------------------------------------------- |
| **Project name**           | `note220`（和 wrangler.toml 的 name 保持一致） |
| **Production branch**      | `main`（你 repo 的主分支）                     |
| **Framework preset**       | `None`                                         |
| **Build command**          | **留空**（纯静态 + Functions，无构建步骤）     |
| **Build output directory** | `public`                                       |

7. **不要在这里加 Environment variables**——见下一步为什么
8. 点 **Save and Deploy**

部署会自动跑起来（约 30 秒）。完成后你会拿到一个 `https://note220.pages.dev` 之类的域名，**此时访问会显示令牌输入页，但输什么都会报错**——因为 ROOM_TOKEN 还没设。继续下一步。

### 5. 设置进门令牌（⚠️ 第二个坑）

> **关键坑**：repo 里有 `wrangler.toml`（含 `pages_build_output_dir`）时，**toml 是项目配置的唯一事实来源，Dashboard 向导里填的变量会被 toml 屏蔽，传不进 Functions**。所以 `ROOM_TOKEN` 必须用 CLI 写成 secret（secret 不受 toml 屏蔽）：

```bash
npx wrangler pages secret put ROOM_TOKEN --project-name note220
# 提示时输入令牌，看到 "✨ Success!" 即可
```

**令牌强度建议**：别用 `220` 这种 3 位纯数字，公网几秒就能 brute force。用 `dorm4-220`、`note-220` 这种 6-8 位混合串。现在有了 IP 防爆破（10 次/10 分钟），慢速爆破的成本已经高了很多，但令牌强度依然是第一道防线。

### 6. 触发重新部署（让 secret 生效）

> **关键坑**：Pages secret 是部署时注入的，**写完必须重新部署一次才生效**，否则访问还是 500。

任选一种触发：

- **Dashboard**：note220 项目 → Deployments → 最近一次部署右侧「⋯」→ **Retry deployment**
- **或本地**：随便改点东西 `git push`（自动触发新部署）

状态变绿后刷新域名输令牌，**能进留言板就成了**。

<details>
<summary><b>🔧 常见报错排查（点击展开）</b></summary>

| 报错 | 原因 | 解法 |
|---|---|---|
| `Authentication error [code: 10000]` | 走了 Workers Builds 向导，token 缺 `Pages:Edit` | 删项目，按第 4 步走 Pages → Connect to Git |
| HTTP 500（进不去） | `ROOM_TOKEN` 没设，或设了没重新部署 | 第 5 步写 secret + 第 6 步 Retry |
| HTTP 401（令牌不对） | 输入与 secret 不匹配 | 重跑第 5 步命令，输入正确值再 Retry |
| HTTP 429（尝试太频繁） | 同 IP 10 分钟内认证失败满 10 次 | 等 10 分钟窗口滑过，或换网络确认不是自己手滑 |
| 部署成功但 404 / 旧版 | CDN 缓存 | 等 1-2 分钟或 Ctrl+F5 |

</details>

## 🗺️ Roadmap

- [x] 多房间 / 免登录会话 / 自动焚毁 / 大代码片段折叠
- [x] 🖼 图片消息：粘贴上传、原图直传、懒加载、全屏预览、原图下载、上传进度条
- [x] ⚡ 秒进三件套：`<head>` 预取 + 边缘缓存 + 自托管字体
- [x] 亮色 Swiss 视觉重写（stone 色板 + Plex/Mono，过 a11y 基线）
- [x] 🗑 消息撤回（全员可删，带图连本体一起清）
- [x] 🔥 焚毁此房间（一键整间清空，含图片本体）
- [x] 🔑 IP 防爆破 + 短会话图片不落盘 + color 服务端校验
- [x] 🔄 活页面（30s 轮询 + 标题未读角标）+ 草稿不丢
- [ ] Markdown 渲染（先 escape 再 markdown 再 linkify）
- [ ] 两段式加载：列表只回预览 + 单条详情接口按需拉全文
- [ ] KV 迁 D1：append 写顺带消灭并发丢消息窗口

---

<div align="center">

**自用小工具，随手造的 —— 觉得有用就拿去 fork。**

 MIT License © 2026 [Weather-Report](./LICENSE)

⭐ 觉得不错点个 Star · 🐛 撞见坑欢迎提 Issue

</div>
