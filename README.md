# dsh-wechat-ilink

在**微信**里直接跟 **DeepSeek Harness (DSH)** 对话。

个人微信里会出现一个叫 **「微信ClawBot」** 的会话。你在里面发消息 → DSH 的**一个固定会话**处理 → 把最终回复发回微信。

- 不依赖企业微信、公众号、小程序
- 不需要公网服务器 / 内网穿透 / 域名
- 不需要挂微信客户端、不做协议 hook、不改个人号
- 走腾讯官方 **iLink Bot API**（微信 ClawBot 背后的协议）

[English](./README.en.md)

---

## 端到端验证记录（v0.5.0）

真实微信消息跑通完整链路的日志证据（账号与消息 id 已脱敏）：

```
05:54:44.350 INBOUND from=<user>@im.wechat id=<message-id> chars=2
05:54:44.364 created DSH agent for session wechat-clawbot
05:54:53.092 TURN DONE events=15 replyChars=110 empty=false
```

| 指标 | 值 | 说明 |
| --- | --- | --- |
| `INBOUND` | `chars=2` | 微信上行通 |
| `created` | 会话新建 | 带正确 cwd 的会话被创建 |
| 耗时 | **8.7 秒** | 真实模型往返（不是毫秒级的失败） |
| `replyChars` | **110** | 真实回复文本 |
| `empty` | **false** | 不再是空回复 |
| `TURN DONE` 之后无 error | — | 回复成功发出（失败会打 error 级日志） |

启动自检同时通过：

```
SELFTEST PASS ms=4202 events=15 replyChars=146
  reply="Self-test confirmed. Runtime context acknowledged: ..."
```

### 三次真实消息全部成功

| 时间 | 输入 | 结果 |
| --- | --- | --- |
| 05:54:44 | 文字 2 字 | `TURN DONE events=15 replyChars=110 empty=false` |
| 05:55:59 | 文字 3 字 | `TURN DONE events=8 replyChars=149 empty=false` |
| 05:57:51 | **图片 1 张** | `downloaded 1/1` → `attached 1 image(s)` → `TURN DONE events=133 replyChars=138 empty=false` |

图片那条链路（CDN 下载 → AES-128-ECB 解密 → 文件头识别 → `ctx.attachments` 落库 →
作为 `image` content block 交给模型）**已用真机验证**。

---

## 它是怎么工作的

```
你在微信里发消息
      │
      ▼
微信 ClawBot（个人微信 → 设置 → 插件）
      │  腾讯 iLink Bot API（长轮询 getupdates）
      ▼
本插件（DSH Host 侧）
      │  agent.followup(prompt)  →  await agent.whenIdle()
      ▼
DSH 会话「wechat-clawbot」（固定一个）
      │  取本回合最终 assistant 文本
      ▼
插件 sendmessage 回微信 ──► 你在微信里看到回复
```

关键设计（按你的要求）：

| 项 | 取值 |
| --- | --- |
| 回复方向 | 只做「微信 → DSH → 回微信」。在 DSH GUI 里打字**不会**推到微信 |
| 长回复 | 等 agent 整回合跑完，**一次性**发回最终文本 |
| 会话粒度 | 固定**一个** DSH 会话，所有微信消息都进它 |
| 运行前提 | 电脑和 DSH 一直开着（微信 ClawBot 的固有限制） |

---

## 一、准备工作

### 1. 确认微信版本和 ClawBot 插件

手机上打开微信：

```
微信 → 我 → 设置 → 插件 → 微信ClawBot
```

如果没看到，先升级微信到最新版。第一次打开可能会提示更新微信。

> 这一步只是确认入口存在，**先不要点开启**，等下面 DSH 侧装好再开。

### 2. 环境要求

| 组件 | 要求 |
| --- | --- |
| DSH | **0.2.0-rc.2** |
| Node.js | ≥ 22.13.0 |
| 操作系统 | Windows / macOS / Linux（保持开机） |

---

## 二、安装插件

### 发布方式

| 渠道 | 内容 |
| --- | --- |
| **npm** | **编译后的正式版** —— 含 `lib/`，拿来就能跑 |
| **GitHub** | **只有源码** —— 不含 `lib/`，供阅读与贡献 |

**普通用户请走 npm。** GitHub 上的源码树没有编译产物，直接装会遇到构建问题（见下方说明）。

### 用户：一条命令

```powershell
dsh plugin --profile desktop add dsh-wechat-ilink
```

不用手工编辑任何配置文件，装完**重启 DSH**。

这条命令内部做三件事：

1. 用 **pnpm** 从 npm 下载并安装；
2. **自动把包名写进 `dsh.profile.bundles`** —— 官方 CLI 的行为（`activateNewBundles`，默认开启），所以不需要你手工编辑 `package.json`；
3. 检查版本兼容性。

> 已实测确认：装完后 `dsh.profile.bundles` 自动多出 `dsh-wechat-ilink`，
> 且 `dsh --profile desktop --dump-config` 的合成树里能看到插件的条目。
>
> **前置条件**：Desktop 的 profile 必须先初始化过 —— 打开一次 DeepSeek Harness
> Desktop，然后**完全退出**（不是最小化），再执行上面的命令。

### 开发者：从源码

```powershell
git clone <仓库地址> dsh-wechat-ilink
cd dsh-wechat-ilink
npm install        # prepare 会自动编译出 lib/
npm test           # 138 个离线测试

# 以「本地目录」形式装进 profile（改代码后重新 npm run build 即可生效）
dsh plugin --profile desktop add "link:$PWD"
```

> **为什么不能直接从 GitHub 装？** pnpm 默认禁止依赖运行构建脚本，而这个仓库
> 按设计不含 `lib/`（`.gitignore` 排除），必须靠 `prepare` 编译。pnpm 会打印需要
> 放行的 key，加到 `$DSH_PROFILE_DIR\pnpm-workspace.yaml` 的 `allowBuilds` 下即可 ——
> 但除非你在改代码，否则没必要绕这一圈，直接用 npm 的正式版。

---

## 三、扫码绑定微信（首次必须做）

**这一步是必须的**：插件需要一个 `bot_token` 才能收发微信消息。

```powershell
dsh-wechat-ilink login
```

如果你是从源码跑的、或者没装 bin 快捷方式，用等价的长命令：

```powershell
node lib/cli.js login
```

终端会打印一个二维码：

```
正在向微信申请登录二维码…

请用手机微信扫描下面的二维码（微信 → 扫一扫）：

  ███████████████████████████
  █ ▄▄▄▄▄ █▀ █▀▀▄ █▄▀▄ ▄▄▄▄▄ █
  ...
  ███████████████████████████

等待扫码确认…
```

用手机微信「扫一扫」→ 在手机上点确认。

成功后：

```
✅ 绑定成功！
   账号   xxxxxxxx@im.bot
   微信   xxxxxxxx@im.wechat
   凭据   %USERPROFILE%\.dsh\clawbot
```

凭据保存在 `%DSH_HOME%\clawbot\`（默认 `%USERPROFILE%\.dsh\clawbot\`），文件权限 0600。

其他命令：

```powershell
dsh-wechat-ilink status   # 查看绑定状态
dsh-wechat-ilink logs     # 查看运行日志
dsh-wechat-ilink logout   # 解绑
```

---

## 用微信远程指挥 DSH 里的另一个会话

默认情况下微信消息都进 `wechat-clawbot` 这个会话。但你可能在 DSH 里**某个会话正干着活**，
想在外面用手机看看进度、下指令 —— 这时可以**把微信临时接到那个会话上**，完事再退回来。

在微信里直接发这些命令（它们**不会**被转发给 agent）：

| 命令 | 作用 |
| --- | --- |
| `/list` | 列出**正在运行**的会话 |
| `/list all` | 列出全部会话（含已停止的，标 ○） |
| `/use <编号>` | 接入某个会话，编号来自最近一次 `/list`；也支持 id 前缀 |
| `/back` | 退回微信自己的会话 |
| `/where` | 看当前接的是哪个会话 |
| `/help` | 帮助 |

### 列表里显示什么、不显示什么

**默认只显示「正在运行」的会话** —— 你要的是远程指挥**正在干活的那个**，
一屏已停止的旧会话只是噪音。它们被汇总成一行：

```
另有 4 个已停止的会话，发 /list all 查看。
```

另外永久**过滤掉**三类（它们只写进日志，不出现在微信消息里）：

- **已归档的会话**（读 `ctx.workspaceRegistry.archivedSessionIds`）
- **子代理会话**（`header.origin === 'subagent'`，内部临时会话）
- 插件自己的两类：**通道自己的会话**（`wechat-clawbot`）和**启动自检会话**
  （`wechat-clawbot-selftest`）

最后一行永远是**当前接入的目标**，所以你不会忘记自己在哪：

```
当前：wechat-clawbot（微信自己的会话）
```

> ⚠️ **重要**：DSH 有一条 `archived-session-gate` —— **归档的会话会被拒绝执行任何步骤**
> （`agent/pre-step` 返回 `reject`，回合以 `blocked` 结束，**不会调用模型**，也就没有任何输出）。
> 所以**千万不要把微信自己的会话（默认 `wechat-clawbot`）归档**，否则微信这边会直接罢工。
> 插件现在会提前检测并明确告诉你，而不是回一句空话。

### 典型流程

```
你：/list
clawbot：
  正在运行的会话：

  1. ● 开发微信 clawbot 插件对话 dsh
     /use 1  ·  0def7dc3

  另有 4 个已停止的会话，发 /list all 查看。
  当前：wechat-clawbot（微信自己的会话）
```

> 被过滤掉的会话（已归档 / 子代理 / 插件自己的）**只写进日志，不占微信消息**。
> 想看过滤详情：`node lib/cli.js logs`，日志级别调到 `debug`。

```
你：/use 1
clawbot：已接入：session-0def7dc3-...
         标题：开发微信 clawbot 插件对话 dsh
         （正在运行，你的消息会直接进入它）

你：现在进展到哪了？            ← 这条会进到那个会话里
clawbot：<那个会话的 agent 的回复>

你：/back
clawbot：已退出 session-0def7dc3-...
         现在回到：wechat-clawbot
```

> `/use <编号>` 里的编号来自**最近一次** `/list`。
> 如果你先发 `/list`（只有运行中的）再发 `/list all`，编号会按后者重排。

### 它是怎么做到的

`ctx.agents.get(sessionId)` 能拿到**正在运行的活 agent**，插件对它调用
`followup()` 就能把微信消息注入那个会话 —— 效果等同于你在 DSH 界面里打字。

- **不会打断它**：消息进的是"下一个回合"的队列，正在跑的那一步不受影响
- **DSH 界面里看得见**：你发的指令和 agent 的回复都会出现在那个会话里
- **双向隔离**：每个会话有自己的回合队列，微信这边的等待不会和界面操作打架
- **接入状态会持久化**：DSH 重启后仍然接着那个会话，启动日志里会明确写出来
- **`/back` 不会关掉对方的会话**：插件只销毁自己创建的 agent

---

## 四、启动并使用

1. 重启 DSH（或在 DSH 里重新加载插件）。
2. 手机上打开微信 → 设置 → 插件 → 开启 **微信ClawBot**。
3. 微信聊天列表会出现 **「微信ClawBot」** 会话。
4. 直接在里面发消息，例如：

```
帮我看一下 Downloads 里最新的 PDF 是什么
```

5. 微信会显示「对方正在输入…」，DSH 跑完后把结果发回来。

### 对应的 DSH 会话

所有微信消息都进同一个 session：

```
wechat-clawbot
```

在 DSH GUI 的会话列表里能看到它，可以看完整对话记录。

---

## 五、配置项

编辑 `$env:DSH_PROFILE_DIR\cordis.patch.yml`，找到 `id: wechat-clawbot` 那一段。

```yaml
- id: wechat-clawbot
  name: 'dsh-wechat-ilink'
  config:
    enabled: true
```

> ⚠️ 注意：`config` 是**整体替换**、不是深合并。要保留的键必须全部重写一遍。

| 键 | 默认值 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总开关 |
| `sessionId` | `wechat-clawbot` | 固定的 DSH 会话 id |
| `cwd` | 继承默认 | 会话的工作目录 |
| `provider` / `model` | 继承 DSH 默认 | 给微信会话单独钉一个模型 |
| `reasoningEffort` | 继承默认 | 推理强度 |
| `allowedUserIds` | `[]` | 额外允许的微信用户 id；**空 = 只允许扫码绑定的人** |
| `typing` | `true` | 是否显示「正在输入…」 |
| `typingKeepaliveMs` | `5000` | 长任务时保活间隔 |
| `maxMessageChars` | `2000` | 单条微信消息最大字数，超出自动分片 |
| `acceptImages` | `true` | 是否接收图片 |
| `turnTimeoutMs` | `300000` | 单回合超时（5 分钟） |
| `logLevel` | `info` | `silent` / `error` / `info` / `debug` |

### 给微信会话单独指定模型

```yaml
- id: wechat-clawbot
  name: 'dsh-wechat-ilink'
  config:
    enabled: true
    sessionId: 'wechat-clawbot'
    provider: deepseek-account
    model: deepseek-flash
    logLevel: info
```

---

## 六、安全默认值

- **默认只允许你自己**：只有扫码绑定的那个微信号能驱动 agent。其他人发消息会被忽略。
- **token 不落日志**：日志里只打印 `abcd***yz` 形式的前后缀。
- **凭据本地存储**：`~/.dsh/clawbot/`，权限 0600。
- **回复必须带 `context_token`**：这是 iLink 的会话路由锚点，插件不会伪造，也不会把回复发错会话。

---

## 七、支持的消息类型

| 类型 | 支持 | 说明 |
| --- | --- | --- |
| 文字 | ✅ | 直接作为 prompt |
| 图片 | ✅ | 按协议下载 + AES 解密，落库为 DSH 图片附件；需要模型支持视觉输入 |
| 引用消息 | ✅ | 被引用的内容会作为 `[引用] …` 附上 |
| 语音 | ⚠️ | 只用微信自带的转写文本；没有转写会提示改用文字 |
| 文件 / 视频 | ❌ | 会明确告知未处理，不会静默丢弃 |

图片依赖 DSH 的 `ctx.attachments` 服务。如果图片保存被拒绝（例如超出大小限制），
该回合仍会正常进行，并把失败原因作为一条可见的文字说明附上，而不是整轮失败。

---

## 八、故障排查

### 微信里发了消息没反应

1. 确认电脑没休眠、DSH 在运行。
2. 看 DSH 日志里有没有 `wechat-clawbot` 的输出。
3. 确认微信侧 ClawBot 插件是开启状态。

### 提示 token 过期 / 会话失效（errcode -14）

微信侧登录态失效了。重新扫码：

```powershell
dsh-wechat-ilink login      # 或：node lib/cli.js login
```

插件检测到 `-14` 会自动暂停轮询并清空游标，重新绑定后自动恢复。

### `BridgeUnavailableError: could not resolve createUserMessage`

**已在 0.1.0 修复。** 如果你看到这条，说明装的是修复前的版本 —— 重新
`npm run build` 然后重启 DSH。

原因：DSH 的 `@deepseek-ai/dsh-llm` 打包在应用内部，而插件是以 `link:` 装进 profile 的，
裸 `import` 会按**插件自己的** `node_modules` 解析，必然 `ERR_MODULE_NOT_FOUND`。
第一方插件能用裸 import，只因为它们本身就在 DSH 的模块图里。

修复方式：插件内置一个等价的消息工厂。DSH 的 `createUserMessage` 实现就是
`deepFreeze(structuredClone({ ...input, role: 'user', id: randomUUID() }))`，
且 `brandString` 是恒等函数（brand 只存在于编译期），所以本地实现与官方**行为完全一致** ——
这一点已用 asar 里提取出的真实 `createUserMessage` 逐字段比对验证。
如果哪天该包变得可解析，插件会自动改用官方那个。

### 微信里收到「(模型没有返回文本内容)」

**已在 0.1.2 修复。** 如果你看到这条，说明装的是修复前的版本 ——
重新 `npm run build` 然后重启 DSH。

原因是一个**竞态**：`agent.whenIdle()` 等的是循环当前的 `activityDone` promise。
当 agent 在调用 `followup()` 的那一刻**本来就空闲**时，这个 promise 是上一轮
已经 resolve 的那个，于是 `whenIdle()` **立刻返回** —— 而本轮的
`assistant/message` 还没写进日志，读出来就是空的。

修复方式：不再依赖裸的 `whenIdle()`，改为等待**本回合的持久化完成信号** ——
即 `boundary` 之后出现的 `turn/end` 事件。`whenIdle()` 降级为辅助信号，
用来兜住「回合结束但没有 `turn/end`」的情况，并配有超时上界，保证不会挂死。

顺带把文本提取对齐到 DSH 官方规则（`@deepseek-ai/dsh-subagent/assistant-output`）：
选**最后一条 content 非空**的 assistant 消息，再退回累计的流式文本 ——
注意是「content 非空」而不是「文本非空」。已用 asar 里提取出的真实
`finalAssistantOutput` 逐例比对验证。

### `SessionAlreadyExistsError: session "wechat-clawbot" already exists`

**已在 0.1.3 修复。** 如果你看到这条，说明装的是修复前的版本 ——
重新 `npm run build` 然后重启 DSH。

原因：固定会话 id（`wechat-clawbot`）是**持久化的**，第一次跑完就写进了
DSH 的会话存储。第二次启动时插件又调 `ctx.agents.create()`，而
`create` 针对一个已存在的持久化身份必然抛 `SessionAlreadyExistsError`
（这个类来自 `@deepseek-ai/dsh-session-persistence`）。
我原来的兜底只重查了 `agents.get()`（内存里的活 agent），而重启后内存是空的，
所以兜不住 —— 直接把错误抛给了你。

修复方式（对齐第一方 `dsh-headless` 的三段式）：

1. `agents.get(id)` 有活 agent → 直接复用；
2. 用 `ctx.sessionQuery.observeSession(id)` 探测持久化存储里是否已有该会话
   → 有则 `agents.resume({ resumeSessionId })`，**保留历史**；
3. 都没有 → `agents.create()`。

同时把 `SessionAlreadyExistsError` 按 **name**（不是 class 实例）兜住：
探测服务不可用时先 create，捕获到该错误就改走 resume，覆盖「探测和创建之间
会话刚被建立」的竞态。按 name 判断是因为那个异常类所在的包，插件同样 import 不到。

### `cannot get property "sessionQuery" without inject`

**已在 0.1.4 修复。** 如果你看到这条，说明装的是修复前的版本 ——
重新 `npm run build` 然后重启 DSH。

原因：Cordis 的 context 是个 **Proxy**，属性读取会走服务解析器 ——
**没在 `inject` 里声明的服务，用 `ctx.xxx` 访问会直接抛错**。我上一步引入
`sessionQuery` 探测时用了 `ctx.sessionQuery`，但 `inject` 里没加它。

修复方式：

- `agents` / `sessions` / `sessionQuery` 加入 `inject`（必需依赖）；
- `attachments` 属于**真正可选**的服务，改为通过 `ctx.get('attachments')`
  读取（`ctx.get()` 对不存在的服务返回 `undefined`，不抛错），因此不放进 `inject`，
  这样缺少附件服务的环境下插件仍能正常加载。

> 注意：`ctx.get('x')` 才是可选服务的正确读法；`ctx.x` 只对 `inject` 声明过的服务安全。

### 自检报 `SELFTEST FAIL (turn error)`，或微信里收到空回复

**已在 0.5.0 修复。** 真正的病根是**一组**系统提示词变量没被赋值 ——
DSH 从 agent 对象上取它们，而插件创建 agent 时没有提供：

```js
// dsh-agent-loop/lib/index.js:1564-1566
ctx.systemPrompt.variable("provider", (context) => context.agent?.options.provider);
ctx.systemPrompt.variable("model",    (context) => context.agent?.options.model);
ctx.systemPrompt.variable("cwd",      (context) => context.agent?.session.header.cwd);
```

而 persona 前缀/后缀里引用了它们（`dsh-web-app`）：

```
You are a coding agent powered by the {{model}} model. ...
... {{cwd}} ...
```

**任何一个没值都会让提示词组装直接抛错**，而这个错发生在**任何模型请求之前** ——
于是回合当场结束、零模型调用、回复为空。GUI 不会踩到，因为它总会带上模型和 cwd。

| 变量 | 来源 | 插件原来 | 修复 |
| --- | --- | --- | --- |
| `{{model}}` / `{{provider}}` | `agent.options.*` | 没传 `agentOptions` ❌ | 取 `ctx.agentDefaultModel.currentSelection()` |
| `{{cwd}}` | `agent.session.header.cwd` | 没传 `meta.cwd` ❌ | 取 `ctx.workspaceRegistry.list()[0].path` |

**`{{cwd}}` 这个特别坑**：`header.cwd` 在会话**创建时**就固定了，`resume` **无法补**。
所以修复前创建的两个会话是**永久损坏**的 —— 必须让它们被重新创建。
插件现在会在恢复时检测并给出明确报错，而不是一直返回空回复。

> 0.4.0 只修了 `{{model}}`（第一个暴露出来的），0.5.0 补齐了 `{{cwd}}`。

**证据链**（你机器上的真实数据）：

1. 会话被放在 `~/.dsh/sessions/**_no-cwd**/wechat-clawbot` —— 目录名本身就是
   "header 里没有 cwd" 的铁证；
2. 解压 `session.v4.jsonl.zstd`（**7 个 zstd frame** 拼接，只读第一个 frame 会漏掉全部事件）
   看到 `turn/end reason={"kind":"error", "error":{"message":
   "prompt variable \"{{cwd}}\" has no value ..."}}`。

排查提示：`turn/end` 的 `reason.kind === 'error'` 后面就是 DSH 的原始原因；
`sessionStats.llmMs: 0` 表示根本没走到模型调用。

### （历史）0.4.0 的错误诊断记录

0.4.0 针对的是同一族问题的**第一个**变量 `{{model}}`，方向正确但不完整；
更早的 0.3.0 还误判为"空 turn 抢跑"。两段记录都保留在下面，说明当时是怎么一步步收敛的。

**0.4.0：`{{model}}`**

DSH 的系统提示词里有 `You are a coding agent powered by the {{model}} model.`
（来自 `dsh-web-app` 的 persona 前缀），而这个变量的值来自：

```js
// dsh-agent-loop/lib/index.js:1565
ctx.systemPrompt.variable("model", (context) => context.agent?.options.model);
```

**关键是 `agent.options.model`。** 我的插件创建 agent 时**没有传 `agentOptions`**，
于是 `options.model` 是 `undefined` → `{{model}}` 没有值 → **提示词组装直接抛错**：

```
prompt variable "{{model}}" has no value for this assembly
  (section "deployment:persona-prefix")
```

这个错发生在**任何模型请求之前**，所以回合当场结束、没有模型调用、回复为空。

GUI 不会踩到，因为它**总会带上模型选择**；程序化创建 agent 必须自己做同样的事。

**证据**（从你机器上的会话日志解出来的真实事件，
`~/.dsh/sessions/_no-cwd/wechat-clawbot-selftest/session.v4.jsonl.zstd`，7 个 zstd frame）：

```
seq=3  agent/inbox/spliced  {inserted:[{text:"Self-test..."}]}   ← 我的消息进了收件箱
seq=5  agent/inbox/spliced  {removedCount:1}                     ← 被取走（确实轮到了）
seq=6  step/start
seq=8  turn/end  reason={"kind":"error","error":{"message":
       "prompt variable \"{{model}}\" has no value ..."}}        ← 真凶
```

**修复**：创建/恢复 agent 时一定会带上 provider + model ——
优先用插件配置，没配就取 DSH 的默认选型：

```js
ctx.agentDefaultModel.currentSelection()   // → { provider, model, reasoningEffort }
```

另外两处配套修复：

1. **完成判定改用 `agent/inbox/spliced`**（收件箱事件）而不是 `user/message`。
   因为组装失败时 `user/message` 根本不会被写入，而 splice 和 `turn/end` 会 ——
   原来的判定会误报「prompt 从未被接纳」。
2. **`turn/end` 的 reason 现在会被记录并回传**。这个错误一直躺在日志里，
   只是没人读它。现在自检和微信回复都会直接说明原因。

> 排查提示：`sessionStats.llmMs: 0` 是「根本没调用模型」的铁证；
> `turn/end` 的 `reason.kind === 'error'` 后面就是真正的原因。

### （历史）0.3.0 的空 turn 判定问题

0.3.0 曾把病根误判为「空 turn 抢跑」，并改成等待 `user/message`。
方向对了一半（确实要等确证），但**判据选错了** —— 见上一节。
下面保留这段记录，说明当时是怎么误判的。

DSH 的 agent 循环在驱动被唤醒时会立刻开一个 turn，如果此刻收件箱是空的，
就马上把它关掉：

```js
// dsh-agent-loop/lib/index.js
if (phase.step === 0 && decision.messages.length === 0) {
  turnEnds = { kind: 'completed' }
  return false          // 没有 step、没有模型调用
}
```

我原来的实现等的是「**任意一个** `turn/end`」，于是常常在这个**空 turn** 上就返回了 ——
而此时你的 prompt 还排在**下一个** turn 里没被处理。结果是：回合「跑完了」，
日志里什么都没有，回复为空。

证据来自 your 自己机器上的 `~/.dsh/storages/session_projcache/sessions/wechat-clawbot-selftest.json`：

```json
"turnOutline": { "turns": [{ "turn": 1, "prompt": "", "response": "" }] }
"titleInput":  { "count": 0, ... }                       ← 一条用户消息都没有
"sessionStats": { "turns": 1, "steps": 1, "llmMs": 0 }   ← 根本没有模型调用
```

修复方式：不再等「任意 turn/end」，而是等**持久化的确证** ——

1. 等一条 `user/message` 事件，其 `id` **等于我发出去的那条消息的 id**
   （证明它真的被收件箱取走并写进了日志）；
2. 再等它之后的 `turn/end`。

这样空 turn 会被正确跳过。

同时修了自检的**假通过**：以前只看「没抛异常」就报 PASS，所以
`SELFTEST PASS ... replyChars=0` 也能通过。现在**空回复一律报 FAIL** 并说明原因。

> 排查提示：`sessionStats.llmMs: 0` 是「根本没调用模型」的铁证。

### 想确认绑定是否还在

```powershell
dsh-wechat-ilink status
```

### 看运行日志（排查问题的第一站）

插件会把**所有**运行记录写到一个持久化文件里 —— 因为插件跑在 DSH 进程内部，
它的 stderr 在外面看不到，没有日志就只能靠猜：

```powershell
dsh-wechat-ilink logs 200
```

日志文件：`%DSH_HOME%\clawbot\channel.log`（默认 `%USERPROFILE%\.dsh\clawbot\channel.log`）。

关键行：

| 日志行 | 含义 |
| --- | --- |
| `=== wechat-clawbot v0.2.0 loaded ... ===` | 插件已加载，以及加载的版本号 |
| `using the bound account ...` | 已经读到微信凭据 |
| `channel listener started` | 长轮询已经开始 |
| `INBOUND from=... id=... chars=...` | **收到微信消息**（这一步到了说明上行通） |
| `created/resumed DSH agent for session ...` | DSH 会话就绪 |
| `TURN DONE events=... replyChars=...` | agent 跑完了 |
| `SELFTEST PASS` / `SELFTEST FAIL` | 见下 |
| `turn failed: ...` | 失败，**带完整堆栈** |

### 启动自检（`selfTestOnStart`）

插件的 `cordis.patch.yml` 里默认开了：

```yaml
selfTestOnStart: true
selfTestDelayMs: 5000
```

DSH 每次启动 5 秒后，插件会用**另一个会话**（`wechat-clawbot-selftest`，
不会污染你真实的微信对话）跑一个合成回合，然后把结果写进日志：

```
SELFTEST start session=wechat-clawbot-selftest
SELFTEST PASS ms=1234 events=4 replyChars=12 reply="..."
```

失败时写 `SELFTEST FAIL (agent path)` 并附完整堆栈。

**它的价值**：微信那一侧本来就已验证过（你收到过插件的回复），
真正没验证过的是「DSH agent 这一段」。有了自检，重启 DSH 后不用等你发消息，
就能立刻知道 agent 链路是通还是不通。

代价是每次启动多一次模型调用。**确认没问题后可以改成 `false`**：

```yaml
selfTestOnStart: false
```

### 完全卸载

```powershell
cd $env:DSH_PROFILE_DIR
pnpm remove dsh-wechat-ilink
```

再从 `package.json` 的 `dsh.profile.bundles` 里删掉 `dsh-wechat-ilink`。

---

## 九、已知限制

1. **只在电脑和 DSH 开机时在线**。这是微信 ClawBot 的设计，不是插件的问题。
2. **一个 DSH 安装只绑一个微信号**。
3. **不支持在 DSH GUI 里打字推到微信**。iLink 要求回复带 `context_token`，而它只随入站消息下发，协议层没有可靠的主动推送。
4. **不支持群聊**。
5. **同一条消息可能被微信重复投递**，插件按 `message_id` 去重，不会重复执行。

---

## 十、开发

```powershell
npm install
npm run build       # TypeScript → lib/
npm test            # 138 个离线测试，不联网
```

测试全部离线：`fetch` 被替换成进程内的假 iLink 服务器，覆盖协议头、长轮询超时、`-14` 会话过期、CDN AES-128-ECB 加解密（含两种 `aes_key` 编码）、图片格式识别、二维码登录状态机、消息归一化、分片、凭据存储、日志脱敏与轮转、会话桥接（含 `{{model}}` / `{{cwd}}` 回归与 blocked 识别）、会话控制命令、图片内容块、CLI。

```
src/
  index.ts            插件入口（Cordis: name / inject / Config / apply）
  schema.ts           Config 校验（Standard Schema，schemastery 可选）
  config.ts           配置解析与默认值
  bridge.ts           微信会话 ↔ DSH 会话桥接（建/恢复 agent、回合边界）
  control.ts          /list /use /back /where /help 会话控制
  channel.ts          长轮询主循环、去重、退避、游标
  outbound.ts         回复发送、分片、typing
  log.ts              日志、token 脱敏、文件轮转
  cli.ts              login / status / logs / logout
  ilink/
    transport.ts      iLink HTTP 客户端（请求头、长轮询、错误码）
    login.ts          二维码登录状态机
    accounts.ts       凭据与游标持久化
    cdn.ts            CDN 上传下载 + AES-128-ECB
    message.ts        入站归一化、出站分片
    types.ts          协议类型
test/
  protocol.test.mjs   协议层
  bridge.test.mjs     DSH 桥接（含 cwd / blocked / 图片回归）
  control.test.mjs    会话控制命令
  image.test.mjs      图片链路
  log.test.mjs        日志与脱敏
  cli.test.mjs        CLI
  helpers.mjs         假 iLink 服务器

cordis.patch.yml      bundle 层：把插件 insert 进 profile 的条目列表
CHANGELOG.md          版本变更记录
NOTICE                第三方协议参考声明
LICENSE               MIT
```

### 关于「验证」

`test/` 里的测试全部离线，**它们证明不了插件在真实 DSH 上能跑** ——
这个项目里 8 个 bug 中有 5 个是在测试全绿的情况下被真实 DSH 打出来的
（`{{model}}`、`{{cwd}}`、`inject`、回合边界、`blocked`）。

真正的验证是**启动自检**：它跑一个真实的合成回合，走完整的
provider / model / cwd 提示词组装和模型调用，把结果写进
`%DSH_HOME%\clawbot\channel.log`。DSH 升级后第一件事就看这个。

```
SELFTEST PASS ms=4202 events=15 replyChars=146
SELFTEST FAIL (turn error) ... reason={"kind":"error","error":{...}}
```

### 可移植性

源码里**没有任何绝对路径**，也没有任何开发机的痕迹。安装只依赖 `git clone` +
`npm install`（`prepare` 会自动构建）。状态目录由 `DSH_HOME` 决定，
没有 `DSH_HOME` 时回退到 `USERPROFILE` / `HOME`。

已用「换路径 + 换 `DSH_HOME` 的干净克隆」实测：安装、构建、138 个测试、
真实 Cordis 加载全部通过。

---

## License

MIT。
协议实现参考腾讯 MIT 许可的 `@tencent-weixin/openclaw-weixin`，见 [NOTICE](./NOTICE)。
