# HAPI Native App — 详细需求文档

> 用途:供 `/speckit-specify` 流程或人工编写 spec 时作为输入素材。内容按 speckit spec-template 结构组织,聚焦 WHAT/WHY(技术 HOW 见 `native-architecture-design.md`)。
> 配套:`.specify/memory/constitution.md`(v1.0.0)、`native-architecture-design.md`、`native-porting-reference.md`
> MVP 范围:聊天+会话+审批(P0)+ 文件浏览(P1)。语音助手、终端**不做**。

---

## 输入描述(喂给 /speckit-specify 的 prompt)

```
为 HAPI(AI 编码代理远程控制平台)构建 Android/iOS/鸿蒙 NEXT 三端原生客户端。
技术栈:Kuikly(KMP)传统 DSL + KuiklyChat 组件,基于 react/khapi 脚手架。
覆盖 Web 端核心功能:会话浏览、发送消息、权限审批、新建会话(P0);文件浏览、会话管理(P1)。
语音助手、终端功能不做。API 契约 1:1 复用 Web 端,不改 hub 后端。
详细需求见 /home/myron/Documents/android/hapi/docs/native-requirements.md。
```

---

## User Scenarios & Testing

### User Story 1 — 远程查看 AI 编码会话 (P1)

HAPI 用户在本地机器跑着 AI 编码代理(Claude/Codex/Gemini 等),离开电脑后用手机继续跟进会话。打开 App 登录,看到所有会话列表,点进某会话查看对话历史、AI 工具调用、最新产出。人不在电脑前也能完整掌握编码进度。

**Why this priority**:HAPI 核心价值主张(local-first + remote control)。无会话浏览能力 App 形同虚设。覆盖 Web `/sessions` + `/sessions/:id` 读路径。

**Independent Test**:登录后能否看到会话列表、点进任一会话看到完整消息流(含 AI 回复、工具调用卡片、流式输出)。单独交付即为可用 MVP。

**Acceptance Scenarios**:
1. **Given** 用户已配置 hub 并持有 access token,**When** 首次启动输入 hub 地址和 token,**Then** 登录成功进入会话列表,按 Active/Recent/Archived 分组
2. **Given** 会话列表页,**When** 点击任一会话,**Then** 进入聊天页看到历史消息流,AI 消息含 markdown 渲染,工具调用以卡片展示
3. **Given** 聊天页浏览中,**When** AI 在远端产生新消息(SSE 推送),**Then** 消息流实时追加,流式 markdown 逐字渲染
4. **Given** 会话消息量大,**When** 滚动到顶部,**Then** 自动加载更早历史(分页),滚动位置不跳变
5. **Given** 聊天页,**When** 网络断开,**Then** 顶部显示断线横幅;恢复后自动重连并补齐错过的消息

---

### User Story 2 — 远程发送指令并审批 AI 操作 (P1)

用户通过手机向 AI 代理发送新指令(纯文本),处理 AI 发起的权限请求(执行 bash、编辑文件等)。批准或拒绝,让 AI 在远端继续或停止。离开电脑也能驱动编码。

**Why this priority**:remote control 的写路径,与 Story 1 读路径共同构成闭环。无审批能力则只能看不能用。

**Independent Test**:能否发送消息并看到 AI 响应;AI 发起权限请求时能否批准/拒绝并看到 AI 据此继续或中止。

**Acceptance Scenarios**:
1. **Given** 聊天页,**When** 输入框输入文本点发送,**Then** 消息乐观追加到列表底部,状态从"发送中"变"已发送";失败则标记可重试
2. **Given** 聊天页,**When** AI 发起权限请求(SSE permission 事件),**Then** 底部弹出审批卡片,按钮组按 agent 类型显示不同选项
3. **Given** 审批卡片,**When** 点"批准",**Then** 请求提交卡片消失 AI 继续执行;**When** 点"拒绝",**Then** AI 停止该操作
4. **Given** AI 正在执行长任务,**When** 用户点"中止",**Then** 中止请求发出 AI 停止
5. **Given** 聊天页,**When** 切换权限模式(default→acceptEdits)或模型,**Then** 即时生效并反映在状态栏

---

### User Story 3 — 发起新的编码会话 (P1)

用户在手机上从零发起新会话:选机器、工作目录、AI 代理、模型、是否 YOLO(全自动)。无需回电脑就能启动新编码任务。

**Why this priority**:无新建会话能力每次都要回电脑,削弱 remote 价值。与 Story 1/2 构成完整生命周期。

**Independent Test**:能否通过表单创建新会话并进入其聊天页。

**Acceptance Scenarios**:
1. **Given** 会话列表页,**When** 点"新建会话",**Then** 进入表单(机器选择、目录、agent、模型、effort、YOLO)
2. **Given** 新建表单,**When** 选机器输入目录,**When** 目录不存在,**Then** simple 模式提示确认创建 / worktree 模式报错
3. **Given** 填好表单,**When** 点创建,**Then** 会话创建成功自动跳转聊天页
4. **Given** 选了某 agent(如 codex),**When** 模型选项加载,**Then** 仅显示该 agent 支持的模型和权限模式

---

### User Story 4 — 浏览工作目录与文件改动 (P2)

用户在手机查看某会话工作目录的文件结构、git 改动(staged/unstaged)、搜索文件、查看文件内容与 diff。远程核对 AI 改动是否正确。

**Why this priority**:P2 — AFK 场景核对 AI 改动的关键补充,但核心闭环(Story 1-3)优先。

**Independent Test**:能否打开文件浏览器看到 git 改动列表,点开某文件看到 diff。

**Acceptance Scenarios**:
1. **Given** 某会话聊天页,**When** 切到"文件"视图,**Then** 看到 git 分支、staged/unstaged 改动文件列表,每文件显示 +/- 行数
2. **Given** 文件浏览器,**When** 搜索框输入关键词,**Then** 返回匹配文件路径和命中行(ripgrep)
3. **Given** 文件浏览器,**When** 点开某文件,**Then** 显示文件内容(语法高亮)或 diff 视图(增删行)
4. **Given** 文件浏览器,**When** 切到"目录"tab,**Then** 显示目录树可逐级展开,点文件打开

---

### User Story 5 — 管理会话 (P2)

用户整理会话列表:重命名、归档、删除、导出分享。

**Why this priority**:P2 — 会话多了需整理,不阻塞核心使用。

**Independent Test**:能否长按某会话弹出菜单执行重命名/归档/删除。

**Acceptance Scenarios**:
1. **Given** 会话列表,**When** 长按某会话,**Then** 弹出操作菜单(重命名/导出/归档/删除/复制信息)
2. **Given** 操作菜单,**When** 选删除,**Then** 二次确认后删除列表移除该项
3. **Given** 操作菜单,**When** 选归档,**Then** 移入 Archived;**When** 选重开,**Then** 移回 Active

---

### Edge Cases

- **登录态过期**:JWT 过期时自动刷新一次重试;刷新仍失败回登录页,不卡死
- **SSE 长时间断连**:网络恢复后补齐错过消息,不丢不重复;指数退避重连避免雪崩
- **会话被远端删除**:正浏览的会话被删,收到 session-removed 后退出聊天页并提示
- **超大消息历史**:数千条消息流畅滚动,不 OOM 不卡顿;分页+虚拟列表
- **权限请求超时**:审批卡片若远端已超时,收到状态后更新为已过期,禁用按钮
- **多 agent 差异**:不同 agent(claude/codex/gemini/kimi/opencode/cursor/pi)权限模式、模型、审批按钮必须正确区分
- **乐观更新冲突**:发送后若 SSE 返回权威消息与乐观行不一致,以权威数据为准平滑替换
- **后台/前台切换**:切后台 SSE 看门狗暂停,回前台立即检查并按需重连

---

## Requirements

### Functional Requirements

**认证与会话连接**
- **FR-001**: App MUST 支持 access token 登录(输入 hub 地址+token),通过 `POST /api/auth` 换 JWT
- **FR-002**: App MUST 自动管理 JWT 生命周期(提前刷新、401 单飞重试),用户无感
- **FR-003**: App MUST 通过 SSE(`/api/events`)订阅实时事件,支持 12 种事件解析
- **FR-004**: App MUST 实现 SSE 重连(指数退避+心跳看门狗+可见性恢复检查),断线显示横幅

**会话浏览(P0)**
- **FR-005**: App MUST 展示会话列表,按 Active/Recent/Archived 分组,含标题/机器/agent 图标/状态摘要/时间
- **FR-006**: App MUST 支持会话列表搜索过滤
- **FR-007**: App MUST 展示单个会话完整消息流,含 AI 消息 markdown 渲染、工具调用卡片、流式输出
- **FR-008**: App MUST 支持消息历史分页加载(滚顶加载更早),不破坏滚动位置
- **FR-009**: App MUST 通过 SSE 实时追加新消息,流式 markdown 逐字渲染

**发送与审批(P0)**
- **FR-010**: App MUST 支持发送文本消息,含乐观更新(立即追加)和失败重试
- **FR-011**: App MUST 处理 AI 权限请求,按 agent 类型显示对应审批按钮组(claude: Allow/Allow for session/Allow all edits/Deny;codex/gemini/kimi/opencode/cursor: Yes/Yes for session/Abort)
- **FR-012**: App MUST 支持批准/拒绝权限请求,提交后 AI 据此继续或停止
- **FR-013**: App MUST 支持中止运行中的会话(`POST /:id/abort`)
- **FR-014**: App MUST 支持切换权限模式和模型,即时生效反映在状态栏

**新建会话(P0)**
- **FR-015**: App MUST 提供新建会话表单(机器/目录/agent/会话类型 simple/worktree/模型/effort/YOLO)
- **FR-016**: App MUST 按 agent 类型动态显示支持的模型和权限模式(对齐 `shared/src/modes.ts` 矩阵)
- **FR-017**: App MUST 校验目录存在性(simple 不存在提示创建;worktree 不存在报错)

**文件浏览(P1)**
- **FR-018**: App MUST 展示会话工作目录 git 改动(staged/unstaged+/- 行数)和目录树
- **FR-019**: App MUST 支持 ripgrep 文件内容搜索
- **FR-020**: App MUST 展示文件内容(语法高亮)和 diff 视图

**会话管理(P1)**
- **FR-021**: App MUST 支持会话重命名、归档、重开、删除(二次确认)、导出、复制信息

**状态展示**
- **FR-022**: App MUST 在状态栏展示连接状态、上下文用量(剩余≤10% 琥珀/≤5% 红)、当前权限模式标签
- **FR-023**: App MUST 展示 Codex 专属状态(reasoning effort/fast/goal/collaboration mode)

**跨平台一致性**
- **FR-024**: App MUST 在 Android/iOS/鸿蒙 NEXT 三端行为一致(复用 shared Kotlin)
- **FR-025**: App MUST 在鸿蒙端可用——若 Kuikly 某页不达标该页降级 ArkUI 兜底,不影响其它平台

### Key Entities

- **Session**:会话。id、标题、机器、agent flavor、权限模式、模型、状态、最近消息摘要、上下文用量。分 local/remote 运行位置可切换
- **Message**:消息。id、角色(user/assistant/tool)、内容(markdown)、工具调用、时间戳、发送状态(sent/queued/failed)、附件
- **Machine**:机器。id、名称、在线状态、workspaceRoots
- **PermissionRequest**:权限请求。requestId、工具名、参数、agent flavor(决定按钮组)、状态(pending/approved/denied/expired)
- **AgentFlavor**:agent 类型枚举(claude/codex/gemini/kimi/opencode/cursor/pi),各类型有可用权限模式和模型子集
- **PermissionMode**:权限模式(default/acceptEdits/auto/bypassPermissions/plan/read-only/safe-yolo/yolo/ask/debug),按 agent 可用集合不同
- **FileChange**:文件改动。路径、staged/unstaged 状态、增删行数

### 权限模式矩阵(按 agent 类型)

| agent | 可用权限模式 |
|---|---|
| claude | default, acceptEdits, auto, bypassPermissions, plan |
| codex | default, read-only, safe-yolo, yolo |
| gemini / kimi | default, read-only, safe-yolo, yolo |
| opencode | default, plan, yolo |
| cursor | default, plan, ask, debug, yolo |
| pi | 无运行时切换(恒自动批准) |

Codex 另有 collaboration mode `default/plan`。

### 模型清单

- claude: auto + sonnet[1m]/opus[1m]/fable[1m]
- gemini: auto + 3.1-pro/3-flash/2.5-pro/2.5-flash/2.5-flash-lite
- codex/kimi: 仅 auto
- cursor/opencode/pi: 动态发现
- effort: Codex `default/low/medium/high/xhigh/max`;Claude `auto + levels`

---

## Success Criteria

### Measurable Outcomes

- **SC-001**: 用户能在 30 秒内完成登录并看到会话列表
- **SC-002**: AI 产生新消息后,App 在 2 秒内开始显示(SSE 端到端延迟)
- **SC-003**: 1000 条消息的会话,滚动浏览帧率不低于 50fps,不卡顿不 OOM
- **SC-004**: 三端核心流程行为一致,同一会话表现相同
- **SC-005**: 用户能在 3 次点击内完成"审批一个权限请求"
- **SC-006**: 网络断开恢复后,App 在 5 秒内自动重连并补齐错过的消息,无丢失无重复
- **SC-007**: 鸿蒙端首屏渲染(会话列表)在 1 秒内完成
- **SC-008**: 离线时(已缓存数据)用户仍能浏览已加载的会话历史,不显示空白

---

## Assumptions

- **后端不变**:HAPI hub 后端保持现有 REST/SSE 契约,不为原生端改接口(宪法原则 II)
- **技术栈已定**:Kuikly(KMP)+ 传统 DSL + KuiklyChat 已写入宪法,不再讨论选型(宪法原则 III)
- **目标用户**:已有 HAPI hub 实例的用户,自行配置 hub 地址和 token;不做新手引导
- **网络环境**:用户多数时间有稳定网络,弱网做基本容错(断线横幅+重连)但不专门优化
- **MVP 范围**:仅含聊天+会话+审批(P0)+ 文件浏览(P1)。语音、终端、Push、系统分享、设置全量、Scratchlist、大纲、定时发送均为 P2+,本期不做
- **三端优先级均等**:鸿蒙非二等公民,三端同时交付(宪法原则 I);鸿蒙某页 Kuikly 不达标接受 ArkUI 单页降级
- **复用现有脚手架**:`react/khapi`(Kuikly 2.7.0,ohosApp 可跑)为基础扩展,非从零
- **依赖可达**:腾讯 Maven 镜像外部可访问(已验证),KuiklyChat 鸿蒙版同步发布(已验证)

---

## Sprint 0 待验证(开发前必做,需 DevEco 环境)

> 以下不属 spec 范畴,是实现前置条件,记录在此供新会话知晓。

1. **Ktor 鸿蒙 SSE**:ohosApp 用 `blackbbc/ktor@3.0.3-ohos` 跑通 Ktor Client + SSE 连 Hapi hub
2. **Kuikly 鸿蒙列表性能**:渲染 100+ 会话 LazyList 测帧率
3. **桥接模块**:补齐 `KRBridgeModule.ets` 的 TODO(toast/copy/openPage)

✅ 已验证:腾讯镜像可达、KuiklyChat 坐标与鸿蒙版本。
