# HAPI Web 端功能清单 — 原生/跨平台移植参考

> 用途：日后用原生（Android/iOS/鸿蒙）或跨平台框架（Kuikly/Flutter/RN）重写 Web 端时，对照本清单逐项实现。
> 所有接口契约、事件 schema、枚举均来自当前 Web 实现，行号引用以当前代码为准。

---

## 一、数据契约层（必须实现的接口与实时通道）

### 1. 认证

| 项 | 内容 |
|---|---|
| 登录端点 | `POST /api/auth`，body `{initData}` 或 `{accessToken}` → `{token, user}`。**不带 Bearer** |
| Telegram 绑定 | `POST /api/bind`，body `{initData, accessToken}` |
| Token 附加 | REST：`Authorization: Bearer <token>`；SSE：query `?token=` |
| Token 刷新 | JWT 自带 exp；提前 60s 定时刷新 + focus/visibility 触发；401 单飞刷新一次重试 |
| 持久化 | access token 存 `hapi_access_token::<baseUrl>`；JWT 不持久化 |

### 2. 实时通道

业务实时数据全走 SSE。（终端 Socket.IO 协议**不实现**，见下方说明）

**SSE 事件**（`/api/events?token=&visibility=&all=&sessionId=&machineId=`，schema 见 `shared/src/schemas.ts:323-388`）：

| 事件 | payload | 动作 |
|---|---|---|
| `heartbeat` | `{timestamp}` | 90s 无心跳→重连 |
| `connection-changed` | `{status, subscriptionId}` | 更新订阅 id |
| `toast` | `{title, body, sessionId, url}` | 弹 toast |
| `message-received` | `{sessionId, message}` | 写入消息窗口 |
| `messages-consumed` | `{sessionId, localIds, invokedAt}` | 标记已消费 |
| `message-cancelled` | `{sessionId, messageId, localId}` | 移除乐观消息 |
| `scheduled-matured` | `{sessionId}` | 失效会话列表 |
| `session-added/updated` | `{sessionId, data?, namespace}` | patch 会话缓存 |
| `session-removed` | `{sessionId}` | 删缓存 |
| `machine-updated` | `{machineId, data?}` | upsert 机器 |
| `session-ended` | `{sessionId, reason?}` | — |
| `messages-invalidated` | `{sessionId}` | 重拉消息 |

重连：指数退避 1s→30s + 抖动；后台看门狗跳过；失效批量合并 16ms。

**Socket.IO（`/terminal`）**：**不实现**。终端功能整体砍掉，相关 `terminal:create/write/resize/ready/output/exit/error` 事件全部不接入。

### 3. REST API 全清单（均需 Bearer，除 `/api/auth`、`/api/bind`）

**sessions**：`GET /api/sessions`、`GET /:id`（staleTime 30s）、`PATCH /:id {name}`、`DELETE /:id`、`POST /:id/resume {permissionMode?}`、`POST /:id/abort`、`POST /:id/archive`、`POST /:id/reopen`、`POST /:id/switch`、`POST /:id/permission-mode {mode}`、`POST /:id/collaboration-mode {mode}`、`POST /:id/model {model}`、`POST /:id/model-reasoning-effort`、`POST /:id/effort`、`POST /:id/service-tier`、`POST /:id/migrate-to-acp`、`GET /:id/export`

**messages**：`GET /:id/messages?beforeAt=&beforeSeq=&limit=`、`POST /:id/messages {text, localId?, attachments?, scheduledAt?}`、`DELETE /:id/messages/:messageId → {status:'cancelled'|'invoked'}`

**permissions**：`POST /:id/permissions/:requestId/approve {mode?, allowTools?, decision?, answers?}`、`POST /:id/permissions/:requestId/deny {decision?}`

**会话内文件/git**：`git-status`、`git-diff-numstat?staged=`、`git-diff-file?path=&staged=`、`files?query=&limit=`、`file?path=`、`directory?path=`、`POST upload {filename, content, mimeType}`、`POST upload/delete {path}`、`generated-images/:imageId`(Blob)、`slash-commands`、`skills`

**模型发现**：session `codex-models/opencode-models(+reasoning-effort-options)/cursor-models/pi-{path}`；machine `/api/machines/:id/{codex,cursor,opencode}-models`

**machines**：`GET /api/machines`、`POST /:id/list-directory {path}`、`POST /:id/paths/exists {paths}`、`POST /:id/spawn {directory, agent?, model?, effort?, yolo?, sessionType?, worktreeName?}`

**share/push**：`GET /api/push/vapid-public-key`、`POST/DELETE /api/push/subscribe`、`POST /api/visibility`、`POST /api/codex/sync-session` 等（语音助手 `/api/voice/*` 端点**不实现**，整体移除）

---

## 二、页面与交互功能

### 路由树

| 路径 | 用途 |
|---|---|
| `/sessions` | 会话列表 |
| `/sessions/:id` | 聊天页（核心）；`?outline=true` 开大纲 |
| `/sessions/:id/files` | 文件浏览器 |
| `/sessions/:id/file?path=<base64>` | 文件查看器 |
| `/sessions/new` | 新建会话 |
| `/browse` | 浏览机器目录 |
| `/settings` | 设置 |
| `/share?id=` | 接收系统分享 |

### 1. 会话列表页

- 分组 Active/Recent/Archived，可选按机器分组
- 行字段：标题/路径、机器名、agent 图标、状态摘要、相对时间
- 搜索、仅活跃会话、摘要模式
- 行操作菜单：重命名/导出分享/归档/重开/删除(二次确认)/复制信息

### 2. 聊天页（核心）

- **消息流**：分页加载、自动滚底、重试失败、刷新；工具调用 ToolCard
- **大纲抽屉**：用户消息作大纲项，点击定位
- **输入区**：多行(Enter 可配)、附件(50MB/5MB 预览)、设置、模型选择、中止、切 remote、scratchlist 切换、定时发送（语音按钮、终端入口**不实现**）
- **状态栏**：连接状态点、**上下文用量(≤10% 琥珀/≤5% 红)**、权限模式标签、Codex reasoning effort/fast/goal
- **审批脚**：Claude `Allow/Allow for session/Allow all edits/Deny`；Codex/Gemini/Kimi/OpenCode/Cursor `Yes/Yes for session/Abort`
- **Scratchlist 抽屉**：草稿便签，编辑/删除/排序/复制/提升到 composer 或队列
- **排队消息条**：即时+定时，可取消

### 3. 新建会话页

机器选择、目录(手输+浏览+校验)、代理类型、会话类型(simple/worktree)、模型(默认 auto)、按 flavor 的 effort/variant、YOLO。支持 `?shareTransferId=` 预填。

### 4. 文件浏览器页

ripgrep 搜索；两 Tab：Changes(git 分支/staged+unstaged+/- 行数) / Directories(目录树)；刷新、错误横幅。

### 5. 文件查看页

文本 Shiki 高亮，图片预览，diff 视图；复制(≤1MB)、下载；路径 base64。

### 6. 终端页

**不实现**（整体砍掉）。

### 7. 设置页

Language；Display(主题/主题色/字号×2/预览数量/仅活跃/状态摘要)；Chat(Enter 行为/终端工具模式/颜色)；About。（Voice 区块**不实现**）

### 8. 分享页

预览 → 选已有会话(sessionStorage hand-off)或新建 → 丢弃删 IDB。

### 9. 浏览页

机器+workspaceRoots+面包屑；Win 路径兼容；"在此开始会话"。

---

## 三、枚举

### 权限模式（按 flavor）

| flavor | 可用模式 |
|---|---|
| claude | default, acceptEdits, auto, bypassPermissions, plan |
| codex | default, read-only, safe-yolo, yolo |
| gemini / kimi | default, read-only, safe-yolo, yolo |
| opencode | default, plan, yolo |
| cursor | default, plan, ask, debug, yolo |
| **pi** | **无运行时切换（恒自动批准）** |

Codex 另有 collaboration mode `default/plan`。

### 模型

claude: auto + sonnet[1m]/opus[1m]/fable[1m]
gemini: auto + 3.1-pro/3-flash/2.5-pro/2.5-flash/2.5-flash-lite
codex/kimi: 仅 auto
cursor/opencode/pi: 动态发现
effort: Codex `default/low/medium/high/xhigh/max`；Claude `auto + levels`

### 会话模式

- **local vs remote**（运行位置，可中途切换；remote 模式指会话运行在远程机器）
- **simple vs worktree**（普通目录 vs git worktree，与 local/remote 正交）

---

## 四、平台能力映射（Web → 原生）

### 必须实现的原生等价能力

| 能力 | Web | 原生等价 |
|---|---|---|
| 离线缓存 | Service Worker precache + NetworkFirst | 资源打包 + HTTP 缓存层 |
| **Push 通知** | VAPID + PushManager + SW | **FCM/APNs——payload schema 复用，端点上报需改** |
| Haptic | Telegram HapticFeedback / `navigator.vibrate` | `HapticFeedbackConstants` / `UIImpactFeedbackGenerator` |
| WebSocket | 原生 WS | OkHttp / `URLSessionWebSocketTask`（**不实现**，仅终端用，已砍） |
| 文件选择/上传 | `<input file>` + 拖拽 + FileReader base64 | `ACTION_OPEN_DOCUMENT` / `UIDocumentPicker`（50MB/5MB） |
| **接收系统分享** | Web Share Target + SW + IDB 中转 | **Android `<intent-filter SEND>` / iOS Share Extension（无需 IDB）** |
| 网络状态 | `navigator.onLine` | `ConnectivityManager` / `NWPathMonitor` |
| 剪贴板 | `navigator.clipboard` + execCommand fallback | `ClipboardManager` / `UIPasteboard` |
| 主题 | localStorage + prefers-color-scheme + Telegram colorScheme | DayNight / `UIUserInterfaceStyle`（light/dark/oled） |
| 字体缩放 | CSS 变量 | Android `fontScale` / iOS Dynamic Type |
| i18n | i18n-context（en/zh-CN） | strings.xml / Localizable.strings |
| 持久化偏好 | localStorage/sessionStorage/IndexedDB | SharedPreferences / NSUserDefaults |
| FUE 引导 | `hapi.fue.v1.*` + portal popover | 浮层 + 锚点 measurement（状态机照搬） |
| 视口/键盘 | visualViewport + CSS 变量 | `WindowInsets` / `keyboardLayoutGuide` |
| 深链/启动参数 | Telegram start_param / URL query | App Link / Universal Link + Intent extras |
| 终端渲染 | xterm.js | **不实现**（终端功能砍掉） |

### Web 专属（原生不需要）

1. PWA manifest / beforeinstallprompt / iOS Add-to-Home-Screen 引导
2. Service Worker 全部能力
3. `navigator.vibrate` fallback、IndexedDB share 中转、execCommand 剪贴板 fallback
4. viewport meta / `--app-viewport-height` hack / iOS PWA 状态栏
5. `display-mode: standalone` / 浏览器缩放禁用

### 原生应补齐的 Web 端缺口

1. **`navigator.share` 分享出去方向未实现**（全仓 0 处）— 原生首版就做 `ACTION_SEND`+FileProvider / `UIActivityViewController`
2. maskable 图标未声明（原生自带自适应图标）

### 持久化 key 命名空间

`hapi_access_token::<baseUrl>` / `hapi-appearance` / `hapi-font-scale` / `hapi-lang` / `hapi.fue.v1.<featureId>` /（Web 专）`pwa_install_dismissed` /（Web 专）`hapi.share.pendingTransferId` /（Web 专）IDB `hapi-share-transfers`（语音相关 `hapi-voice-*` key 不实现）

---

## 五、原生实现优先级建议

1. **P0 核心**：认证 + SSE + REST client + 聊天页（消息流/发送/审批） + 会话列表/新建
2. **P1 重要**：文件浏览/查看 + Push 通知 + 权限/模型完整矩阵（终端**不实现**）
3. **P2 增强**：分享双向 + Scratchlist + 大纲 + 定时发送（语音助手**不实现**）
4. **P3 锦上添花**：FUE 引导 + 完整设置项 + 主题/oled + 浏览页 + 导出
