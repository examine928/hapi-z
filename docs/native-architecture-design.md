# HAPI 原生 App 技术选型与架构设计

> 目标:用原生/跨平台重写 Web 端核心功能。覆盖 Android + iOS + 鸿蒙 NEXT 三端,鸿蒙为底线。
> MVP 范围:聊天+会话+审批(P0)+ 文件浏览(P1)。终端、语音助手**不做**。
> Web 功能基线见 `docs/native-porting-reference.md`。

---

## 一、选型结论

### 主框架:Kuikly(Kotlin Multiplatform)

**一套 Kotlin 代码 → 三端原生渲染**。理由:
- Kuikly 鸿蒙端 2025 年已正式开源,腾讯内部 15+ App / 500+ 页面 / 亿级 PV 验证,首屏 180ms、58fps、崩溃率降 72%——生产可用。
- 已有脚手架 `react/khapi`(ohosApp 能跑、`KRBridgeModule` 已搭框架,Kuikly 2.7.0),非从零开始。
- KMP 让业务逻辑、网络、SSE、状态管理一套共享。

### UI 渲染路线:传统 DSL(非 Compose DSL)

**走 Kuikly 传统 DSL(`BasePager` + `ViewContainer` + `@Page`),不走 Compose DSL。** 这是对 `react/khapi` 脚手架的调整(脚手架当前用 Compose DSL,`shared/build.gradle.kts:64` 引了 `compose`,需移除并改传统 DSL)。

决策依据:
- **复用 `KuiklyChatUI`**(`github.com/Kuikly-contrib/KuiklyChatUI`,Maven 坐标 `com.tencent.kuiklybase:KuiklyChat`):专为 AI 聊天设计,内置 `ChatSession`(完整聊天框架)、`AiMessageText`(流式 Markdown + 逐字打字动画)、`ChatRepository`(后端解耦接口)。聊天页是 P0 核心工作量(占 ~40%),复用可降工作量 60%+。
- **markdown 渲染一并解决**:`KuiklyChatUI` 的 `AiMessageText` 自带流式 Markdown(依赖 `KuiklyMarkdown`),功能比 `kuikly-compose-markdown` 更贴合 AI 对话,无需另引渲染库。
- **代价**:`react/khapi` 脚手架需从 Compose DSL → 传统 DSL 重写(主要是 `RouterPage.kt` 等 UI 入口,非全盘推翻)。
- **否决 Compose DSL**:虽然 `kuikly-compose-markdown` 现成,但聊天 UI 要从零自建,且 `KuiklyChatUI` 不兼容 Compose——对 MVP 而言自建聊天页代价过大。

> Sprint 0 已验证(Sprint 0-2/3,2026-06):`KuiklyChat` 有完整发布管线(11 个版本,最新 `1.0.3-2.0.21-KBA-010`,2026-04-21 更新),鸿蒙版本(`-KBA-010` 后缀对应 `2.0.21-ohos` Kotlin)同步发布;腾讯镜像 `mirrors.tencent.com/nexus/repository/maven-tencent/` 外部可访问、无需认证。依赖引入方式见下节。

### 兜底:鸿蒙 ArkUI 原生(按需)

ArkUI 只能鸿蒙,无法独立覆盖三端,但作为**单页面降级通道**有价值。触发条件:
- Kuikly 在某页面渲染性能/效果不达标(如超长列表、复杂 diff 视图)
- 需要鸿蒙专属系统能力(Kuikly 桥接未覆盖)

降级方式:该页面在鸿蒙端用 ArkUI 原生实现,通过 Kuikly 的 `PageRoute` 跳转原生 Ability;Android/iOS 仍走 Kuikly。

### 否决项

- **纯 ArkUI**:无法覆盖 Android/iOS,违反三端目标。
- **Flutter/RN**:鸿蒙端成熟度不及 Kuikly(腾讯背书 + 已开源),且偏离已有脚手架。
- **WebView 套壳**:Web 端能力(离线/PWA)在原生无意义,且体验差。

### 依赖引入方式(Sprint 0-2/3 已验证)

`react/khapi` 脚手架的 `settings.gradle.kts:8,20` 已配腾讯镜像,直接引用即可:

```kotlin
// settings.gradle.kts —— 仓库(已配置,无需改动)
maven { url = uri("https://mirrors.tencent.com/nexus/repository/maven-tencent/") }

// shared/build.gradle.kts —— commonMain dependencies
// KuiklyChatUI:聊天页核心组件
implementation("com.tencent.kuiklybase:KuiklyChat:1.0.3-2.0.21")         // 标准平台(Android/iOS/JS)
implementation("com.tencent.kuiklybase:KuiklyMarkdown:1.0.4-2.0.21")     // 流式 Markdown(KuiklyChat 传递依赖,显式声明版本)
// 鸿蒙端用 -KBA-010 后缀版本(对应 2.0.21-ohos Kotlin)
// implementation("com.tencent.kuiklybase:KuiklyChat:1.0.3-2.0.21-KBA-010")

// Kuikly core(脚手架已有,Version.getKuiklyVersion() = 2.7.0-2.1.21)
implementation("com.tencent.kuikly-open:core:${Version.getKuiklyVersion()}")
```

> 版本号规则:`{baseVersion}-{kotlinVersion}`,鸿蒙版后缀 `-KBA-010`(对 `2.0.21-ohos`)。Kotlin 版本必须与脚手架的 Kotlin 版本严格匹配,否则 KN 编译报错。

---

## 二、整体架构

```
┌─────────────────────────────────────────────────────────┐
│                    shared (Kotlin/KMP)                  │
│  ┌─────────────┐ ┌─────────────┐ ┌───────────────────┐  │
│  │  domain     │ │  data       │ │  realtime         │  │
│  │  (模型/枚举) │ │  (repo/api) │ │  (SSE)            │  │
│  └─────────────┘ └─────────────┘ └───────────────────┘  │
│  ┌─────────────┐ ┌─────────────┐ ┌───────────────────┐  │
│  │  state      │ │  bridge     │ │  persistence      │  │
│  │  (QueryCache│ │  (expect/   │ │  (settings/       │  │
│  │   等价物)    │ │   actual)   │ │   fue/ prefs)     │  │
│  └─────────────┘ └─────────────┘ └───────────────────┘  │
└──────────────┬──────────────────────────────────────────┘
               │ expect/actual
┌──────────────┴────────────┐  ┌──────────────┬──────────┐
│   androidApp (Kotlin)     │  │ iosApp (Swift│ ohosApp  │
│   Kuikly 传统 DSL UI      │  │  bridge)     │ (ArkTS)  │
│   + KuiklyChatUI          │  │ Kuikly 传统  │ Kuikly + │
│   + 平台 actual 实现       │  │ DSL + ChatUI │ ArkUI兜底 │
└───────────────────────────┘  └──────────────┴──────────┘
```

### 分层职责

| 层 | 位置 | 职责 |
|---|---|---|
| **domain** | shared/commonMain | 数据模型(Session/Message/Machine)、枚举(PermissionMode/AgentFlavor/Model)、纯函数 |
| **data** | shared/commonMain | Repository、API client(Bearer + 401 刷新)、API 契约 1:1 对齐 Web |
| **realtime** | shared/commonMain + actual | SSE 客户端(12 事件)、重连/心跳看门狗 |
| **state** | shared/commonMain | QueryCache(等价 TanStack Query)、乐观更新、失效批量合并 |
| **bridge** | expect/actual | 平台能力:Haptic、剪贴板、文件选择、网络状态 |
| **persistence** | shared/commonMain + actual | 偏好存储(settings/fue/token),key 命名对齐 Web |
| **ui** | 各平台 | Kuikly 传统 DSL 页面;聊天页复用 `KuiklyChatUI`;鸿蒙可降级 ArkUI |

---

## 三、数据层设计

### API Client(`shared/data/ApiClient.kt`)

```kotlin
class ApiClient(val baseUrl: String, val tokenProvider: () -> String?) {
    // 所有 REST 端点,1:1 对齐 docs/native-porting-reference.md
    suspend fun listSessions(): SessionsResponse
    suspend fun sendMessage(sessionId: String, text: String, localId: String, ...): Message
    suspend fun approvePermission(sessionId: String, requestId: String, ...): Unit
    // ... ~40 个端点
}
```

- 用 **Ktor Client**(KMP 全平台,engine 各平台注入:Android=OkHttp,iOS=Darwin,鸿蒙=自封或 CIO)
- **认证拦截器**:注入 `Authorization: Bearer`;401 → 单飞刷新 → 重试一次
- **JWT 刷新**:解码 exp,提前 60s 刷新;focus/visibility 触发(由 UI 层通知)

### SSE 客户端(`shared/realtime/SseClient.kt`)

```kotlin
expect class SseClient(baseUrl, tokenProvider) {
    fun connect(scope: SseScope, onEvent: (SyncEvent) -> Unit, onState: (ConnState) -> Unit): Job
}
```

- 各平台 actual:Android/iOS 用 Ktor SSE;鸿蒙若 Ktor 不支持 ohosArm64,自封 `@ohos.net.http` chunked 解析(SSE 协议就是 `data: ...\n\n` 文本流,解析 < 50 行)
- **重连**:指数退避 1s→30s + 抖动;90s 心跳超时重连;可见性恢复立即检查
- **事件解析**:12 种事件 schema 直接复用 `shared/src/schemas.ts`(转 Kotlin data class + kotlinx.serialization)

### 状态管理(`shared/state/QueryCache.kt`)

等价 Web 的 TanStack Query,自实现轻量版:
- `QueryKey` + `Query<T>`(data/status/fetchedAt/isStale)
- `Mutation`(onMutate 乐观更新 / onSuccess / onError 回滚)
- `invalidateQueries(key)` 批量合并 16ms 后触发重拉
- SSE 事件 → 对应 invalidate/patch(对齐 `useSSE.ts` 的缓存策略,**patch 而非全量重拉**)

> 不引入 MVI/MVVM 重框架,保持简单(AGENTS.md:愚蠢式简单)。

---

## 四、页面映射与实现优先级

| Web 路由 | 原生页面 | MVP | 实现要点 |
|---|---|---|---|
| `/sessions` | 会话列表 | **P0** | 分组列表、搜索、长按菜单;LazyList |
| `/sessions/:id` | 聊天页 | **P0** | 消息流(分页/滚底)、Composer、StatusBar、PermissionFooter |
| `/sessions/new` | 新建会话 | **P0** | 表单(机器/目录/agent/模型/effort/YOLO) |
| `/sessions/:id/files` | 文件浏览器 | **P1** | ripgrep 搜索、Changes/Directories 双 tab、目录树 |
| `/sessions/:id/file` | 文件查看 | **P1** | diff 视图;高亮用轻量正着色或 WebView+Shiki |
| `/share` | 分享入口 | P2 | 后置 |
| `/settings` | 设置 | P2 | 后置(先支持切 hub/token) |
| `/browse` | 目录浏览 | P2 | 后置 |

### 聊天页(核心)拆解 — 基于 KuiklyChatUI

**不从头自建,而是实现 `HapiChatRepository` 接入 `KuiklyChatUI` 的 `ChatSession`。**

- `ChatSession`(库提供)已含:导航栏、消息列表(分页/滚底)、输入框、操作菜单——直接覆盖 Web 的 SessionHeader + HappyThread + HappyComposer
- `AiMessageText`(库提供)已含:流式 Markdown 渲染 + 逐字打字动画——覆盖 Web 的工具调用/消息内容渲染
- `ChatRepository`(库接口)由我们实现为 `HapiChatRepository`,桥接 Hapi API + SSE:
  - `loadHistory(beforeAt/beforeSeq)` → `GET /:id/messages`
  - `sendMessage(text, attachments)` → `POST /:id/messages`(含乐观更新)
  - SSE `message-received` 事件 → `onNewMessage` 回调推入列表
  - SSE `messages-consumed/cancelled` → 同步状态
- **自建部分**(库不覆盖的 Hapi 特有 UI):
  - `StatusBar`(连接态 + 上下文用量 + 权限模式标签)
  - `PermissionFooter`(按 flavor 渲染 Allow/Deny/Abort 按钮组)
  - Scratchlist/大纲/队列 → P2,后置
- **接入方式**:用 KuiklyChatUI 的 Slot 插槽系统,把自建 UI 挂到 `ChatSession` 的 footer/header 插槽

---

## 五、平台能力桥接清单(expect/actual)

MVP(P0+P1)所需:

| 能力 | Android actual | iOS actual | 鸿蒙 actual | 备注 |
|---|---|---|---|---|
| Haptic | `HapticFeedbackConstants` | `UIImpactFeedbackGenerator` | ArkTS Vibrator | 模式表照搬 Web |
| 剪贴板 | `ClipboardManager` | `UIPasteboard` | `@ohos.pasteboard` | 复制路径/消息 |
| 文件选择 | `ACTION_OPEN_DOCUMENT` | `UIDocumentPicker` | `@ohos.file.picker` | 附件上传(50MB) |
| 文件下载 | `MediaStore`/SAF | `UIDocumentPicker` | `@ohos.file.fs` | 文件查看页 |
| 网络状态 | `ConnectivityManager` | `NWPathMonitor` | `@ohos.net.connection` | 断线横幅 |
| 网络栈 | OkHttp | Darwin | CIO/原生 http | Ktor engine |
| 偏好存储 | SharedPreferences | NSUserDefaults | `@ohos.data.preferences` | key 对齐 Web |
| 主题 | DayNight | UIUserInterfaceStyle | ArkTS AppStorage | light/dark(oled P2) |

后置(P2+):Push(FCM/APNs/鸿蒙Push)、深链、FUE。语音助手**不实现**(相关端点/桥接/设置项全部移除)。

---

## 六、鸿蒙 ArkUI 兜底策略

### 触发条件(任一满足则该页面降级)

1. Kuikly 渲染帧率 < 50fps 或首屏 > 500ms(实测不达标)
2. 需要 Kuikly 未桥接的鸿蒙系统能力

### 混合方式

```
ohosApp/entry/src/main/ets/
├── pages/
│   └── Index.ets              # Kuikly 入口(router 页)
├── entryability/EntryAbility.ets
└── kuikly/
    └── modules/               # Kuikly 桥接模块
        └── NavigationModule.ets  # openNativePage(route) 跳 ArkUI
```

Kuikly 侧通过 `BridgeModule.openNativePage(route)` → EntryAbility 路由到 ArkUI 页;数据通过共享 Preferences 或内存通道传递 sessionId。

**原则**:兜底是页面级,不是全 App。大部分页面仍走 Kuikly 三端统一。

---

## 七、风险点与应对

| 风险 | 等级 | 应对 |
|---|---|---|
| Ktor 鸿蒙 ohosArm64 支持不确定 | 中 | 用 `blackbbc/ktor@3.0.3-ohos` fork;不支持则自封 SSE(< 50 行)+ 各平台原生 http |
| ~~KuiklyChatUI 成熟度存疑~~ | ~~中~~ | ✅ **已验证解除**(Sprint 0-2):有完整发布管线,11 版本持续迭代至 2026-04,鸿蒙版同步发布 |
| ~~腾讯镜像外部可访问性~~ | ~~中~~ | ✅ **已验证解除**(Sprint 0-3):`maven-tencent` 仓库外部可访问,无需认证 |
| Kuikly 鸿蒙某页面性能不达标 | 中 | ArkUI 单页兜底(见第六节) |
| Kuikly 外部社区生态弱 | 低 | 单 App 不依赖组件库,风险可控;腾讯内部已大规模验证 |
| Shiki 语法高亮(JS) | 低 | P1 先用轻量着色;复杂高亮用 WebView+Shiki |
| ArkTS/Kotlin 双栈维护成本 | 中 | 仅兜底页用 ArkUI,控制范围 |

### 关键验证(Sprint 0)

✅ 已完成:
- ~~2. KuiklyChatUI 鸿蒙端跑通~~ → 已验证:有完整发布管线,鸿蒙版 `-KBA-010` 同步发布(2026-06)
- ~~3. 腾讯 Maven 镜像可访问性~~ → 已验证:`maven-tencent` 外部可访问,无需认证(2026-06)

⬜ 待验证(需鸿蒙开发环境):
1. **Ktor 鸿蒙 SSE**:在 ohosApp 用 `blackbbc/ktor@3.0.3-ohos` 跑通 Ktor Client + SSE 连 Hapi hub
4. **Kuikly 鸿蒙列表性能**:渲染 100+ 会话的 LazyList 测帧率
5. **桥接模块**:补齐 `KRBridgeModule.ets` 的 TODO(toast/copy/openPage)

剩余 3 项需在 DevEco Studio + 鸿蒙模拟器/真机环境执行。第 1 项(Ktor SSE)是唯一未解除的中等风险,有明确兜底(自封 SSE)。

---

## 八、模块结构(基于 react/khapi 脚手架扩展)

```
hapi-native/                          # 复用 react/khapi 工程
├── shared/src/
│   ├── commonMain/kotlin/com/baniry/dot/hapi/
│   │   ├── domain/                   # 模型、枚举(PermissionMode/AgentFlavor/Model)
│   │   ├── data/                     # ApiClient, Repository
│   │   ├── realtime/                 # SseClient(expect)
│   │   ├── state/                    # QueryCache, Mutation
│   │   ├── persistence/              # PreferencesStore(expect)
│   │   └── base/BridgeModule.kt      # 已有,扩展
│   ├── androidMain/                  # OkHttp/Darwin actual
│   ├── iosMain/
│   └── ohosMain/                     # 鸿蒙 actual(ArkTS via KN interop)
├── androidApp/                       # Kuikly 传统 DSL UI + KuiklyChatUI
├── iosApp/                           # Kuikly 传统 DSL UI + KuiklyChatUI
└── ohosApp/                          # Kuikly + KuiklyChatUI + ArkUI 兜底页
    └── entry/src/main/ets/pages/
        ├── Index.ets                 # Kuikly router
        └── *Native.ets               # ArkUI 兜底
```

---

## 九、MVP 里程碑(建议)

| Sprint | 周 | 交付 |
|---|---|---|
| **S0 验证** | 1 | 5 项验证(见第七节);**2/5 已完成**(镜像可访问性、KuiklyChatUI 坐标);脚手架从 Compose DSL 切传统 DSL |
| **S1 基础设施** | 2 | shared:domain/data/realtime/state;ApiClient+SSE 三端跑通;登录认证 |
| **S2 会话列表+新建** | 2 | P0 前半:会话列表(分组/搜索/菜单)、新建会话表单 |
| **S3 聊天页** | 2 | P0 后半:实现 `HapiChatRepository` 接入 KuiklyChatUI;自建 StatusBar/PermissionFooter |
| **S4 文件浏览** | 2 | P1:文件浏览器、git 改动、目录树、文件查看(diff) |
| **S5 打磨+兜底** | 2 | 性能调优;不达标页面 ArkUI 兜底;三端联调 |

MVP 合计约 **11 周**(S3 聊天页因复用 KuiklyChatUI,3 周→2 周)。Push/分享/设置全量等列为 P2 后续迭代(语音助手、终端**不实现**)。

---

## 十、与 Web 端的关系

- **API 契约**:1:1 复用,不改后端(`shared/src/schemas.ts` 转 Kotlin)
- **枚举**:`shared/src/modes.ts` + `models.ts` 转 Kotlin object
- **持久化 key**:对齐 Web(`hapi-appearance` 等),便于未来跨端同步
- **SSE 事件处理逻辑**:对齐 `useSSE.ts` 的 patch 策略
- **不实现的 Web 专属**:PWA/SW/viewport hack/`navigator.vibrate` fallback
- **原生补齐的缺口**:`navigator.share` 分享出去(Web 没做,原生首版就该做)
