# OpenCodex Desktop App 执行计划

Unit: `desktop/`
Opened: 2026-08-29
Reviewed: 2026-08-29
Working branch: `app/desktop`（下游产品分支）
Sync base: `abbzbb/opencodex` `dev` @ `c3da277bc`（v2.36.0；上游为 `lidge-jun/opencodex`）

分支约定：`app/desktop` 作为下游产品分支存在，并通过 fork 的 `dev` 镜像运行 PR 门禁。若把通用改动回送上游，必须拆成独立 PR 并按上游策略以 `dev` 为目标；桌面打包与发布不得改写上游 npm `release.yml` 的契约。

## 1. 结论与完成定义

**方案可行，但边界必须比“WebView + sidecar”更严格。** Desktop App 是现有 Bun 代理的原生外壳，不重写代理、GUI、凭证平面或服务管理器。

```text
用户启动 OpenCodex App
  -> Tauri 壳取得单实例锁
  -> 短生命周期 Bun bridge 复用现有 liveness/service/start 逻辑
  -> 等待身份校验通过的 /readyz
  -> 返回唯一 loopback origin
  -> 原生顶层 WebView 打开代理提供的现有 dashboard
```

首个可发布 Desktop 版本（跨第 0-3 期）只有同时满足以下条件才算完成；第 1 期的“功能 MVP”不单独满足发布定义：

1. 干净机器不预装 Node、Bun 或 npm 全局 `ocx`，安装 App 后可启动代理并打开 dashboard。
2. 冷启动、热启动和连续双击都只有一个壳实例、一个代理实例。
3. dashboard 的 session bootstrap、CSRF 写操作和五分钟 session 续期全部可用。
4. WebView 只允许本 App 的本地加载页和 bridge 返回的精确 loopback origin；外部 URL 交给系统浏览器。
5. 关窗口只隐藏；显式退出经现有 `ocx stop` 语义停止 service/代理并还原 Codex。停止失败时不得假装退出成功。
6. App 不读取、缓存、注入或记录 dashboard session、管理 token、API key、OAuth token。
7. 三平台安装产物来自目标平台构建，捆绑运行时依赖闭包完整，且通过安装后 smoke test。

每一期的停止条件：该期门禁全部通过，或者记录一个不依赖修改认证/协议栈的明确 blocker。失败时不得为迁就桌面壳而放宽现有安全边界。

## 2. 产品边界与非目标

产品定义：

- OpenCodex App 是本机代理的桌面外壳，不是第二个 Codex。
- 窗口展示代理自己提供的 `gui/` dashboard。
- 后台仍是现有 Bun 代理：数据面 `/v1/*`，管理面 `/api/*`。
- `src/service.ts` 仍是唯一的开机自启和崩溃重启监督者；壳不是第二个 supervisor。
- App 可以连接同一 `OPENCODEX_HOME` 下由 npm 安装启动的现有代理，但不得悄悄迁移或更新该安装。

| 不做的方案 | 原因 |
|---|---|
| 把 `gui/` 做成 `file://` 独立 SPA | GUI session 绑定 loopback origin + CSRF；`file://` 不能承载该契约 |
| iframe 嵌仪表盘 | `X-Frame-Options: DENY` + `CSP frame-ancestors 'none'` |
| 把代理迁进 Tauri/Electron 主进程 | 会拆开现有凭证、生命周期、注入和还原边界 |
| 第一期 `bun compile` 单文件 sidecar | `import.meta.dir`、动态 `import()`、原生依赖和资源定位尚未形成闭包 |
| 壳自造 launchd/systemd/schtasks | 与 `src/service.ts` 双监督，PID、重启和 restore 会竞态 |
| 壳直接持有管理 token 或调用 `/api/stop` | 壳不是 dashboard session principal，不能复制管理凭证边界 |
| App 资源调用 npm `ocx update` | npm 全局替换与 App 安装树、service 绝对路径的所有权不同 |
| 移动端 App | 没有可注入的 Codex / Claude Code 桌面客户端 |
| 改 Lab 核心边界、凭证平面、内存预算 | 不属于桌面壳范围 |

## 3. 已验证的仓库事实

| 能力/约束 | 代码依据 | Desktop 结论 |
|---|---|---|
| GUI 与 session 注入 | `src/server/gui-static.ts`、`src/server/management-auth.ts` | 顶层打开 loopback HTTP；session 为内存态、精确 origin 绑定、TTL 5 分钟 |
| GUI session 自动续期 | `gui/src/api.ts` | 必须验证隐藏超过 5 分钟后的第一次写操作，不另造壳侧 token |
| 禁 iframe | `src/server/auth-cors.ts` `browserSecurityHeaders()` | 不放宽 XFO/CSP |
| GUI URL 选择 | `src/cli/dispatch.ts` `gui`、`probeHostname()` | 不硬编码 `127.0.0.1:10100`；bridge 返回 canonical origin |
| 代理身份 | `src/server/proxy-liveness.ts`、`src/config/process-state.ts` | 必须复用 `findLiveProxy`，不能只读 PID/端口或接受任意 2xx |
| 启动就绪 | `src/server/proxy-liveness.ts` `probeReadiness()` | `/healthz` 只证明存活；加载 GUI 前必须等严格 `/readyz` |
| 显式停止 | `src/cli/index.ts`、`POST /api/stop` | 托盘/Cmd+Q 走 CLI stop 语义，包含 service 停止、身份检查和 restore |
| OAuth 外开 | `src/server/management/oauth-account-routes.ts`、`src/lib/open-url.ts` | 登录 URL 已由代理在系统浏览器打开；WebView 不接管 OAuth |
| service 路径 | `src/service.ts` `ServiceInstallState` | service 固化 Bun/CLI 绝对路径，更新前必须定义稳定路径和 repair/rollback |
| npm 捆绑 Bun | `bin/ocx.mjs`、`src/lib/bun-runtime.ts` | `bin/ocx.mjs` 自身需要 Node；Desktop 不能把它当成无 Node 的启动入口 |
| 运行时资源 | `package.json`、`src/server/gui-static.ts` | 仅复制 `bun + src + gui/dist` 不够；还需 `package.json`、生产依赖和平台原生模块 |
| Windows tray | `src/tray/` | 它是操作入口，不是监督者；迁移需显式、可回滚，不能静默留下双图标 |

## 4. 目标架构

### 4.1 组件

```text
OpenCodex App (Tauri 2)
  |- Rust shell
  |    |- single-instance / tray / window lifecycle
  |    |- exact-origin navigation policy
  |    `- invokes fixed desktop bridge operations
  |
  |- bundled bootstrap payload (signed App resources)
  |    |- ocx-runtime-$TARGET_TRIPLE[.exe]   # Bun external binary
  |    |- desktop/runtime/install.ts         # packaged-resource staging bridge
  |    |- desktop/runtime/bootstrap.ts       # short-lived JSON bridge
  |    |- package.json
  |    |- src/
  |    |- gui/dist/
  |    |- assets/ required at runtime
  |    `- production node_modules/ including target-native packages
  |
  `- per-user stable runtime root
       |- versions/<app-version>/...
       |- current.json                       # atomic pointer, not a symlink contract
       `- previous version retained for rollback
```

选择 **Tauri 2**。Electron 只在第 0 期探针证明 Tauri 无法满足 WebView、外链或 sidecar 生命周期时才重新评估；“实现起来不熟”不是切换理由。

### 4.2 Desktop bridge，而不是 Rust 重写核心逻辑

Rust 不重写 `findLiveProxy`、PID 身份、service 诊断、端口选择或 restore。`desktop/runtime/bootstrap.ts` 是短生命周期 bridge，直接复用现有 TypeScript 模块，并只输出无凭证 JSON：

```json
{
  "schemaVersion": 1,
  "requestId": "01J...",
  "ok": true,
  "operation": "bootstrap",
  "result": {
    "status": "ready",
    "origin": "http://localhost:10100",
    "pid": 1234,
    "version": "2.36.0",
    "owner": "desktop-direct",
    "allowedMutations": ["stop"]
  }
}
```

wire contract：

- bridge 以固定 argv 启动，只从 stdin 读取一个 UTF-8 JSON object；请求不得进入 argv、URL 或环境变量。请求是 discriminated object：`{ schemaVersion: 1, requestId, operation, payload }`。`requestId` 为最多 64 字节的 ASCII UUID/ULID；所有字段必填，缺失/未知字段、未知 operation、错误 payload 类型或不支持的版本均在任何副作用前返回 `protocol_mismatch`。
- `bootstrap`、`status`、`service-start`、`service-uninstall`、`legacy-tray-uninstall` 的 payload 固定为 `{}`；`stop` 为 `{ reason: "app-exit" | "update" | "uninstall" }`；`runtime-activate` 与 `service-repair` 为 `{ runtimeManifestId }`；`service-install` 为 `{ backend: "platform-default" | "windows-native", runtimeManifestId }`。`runtimeManifestId` 只能匹配已 stage 并通过 hash 校验的 manifest id，由 bridge 在 stable root 内解析，Rust 不能传绝对路径。
- Rust 每次只发送上述固定 request；bridge stdout 只能输出一个 UTF-8 JSON object 加换行，禁止进度行、ANSI 和多 envelope。
- 所有 response envelope 固定含 `schemaVersion: 1`、原样 `requestId`、`operation` 和 `ok`。成功增加 `result`；失败增加 `error: { code, message, retryable }`，且不得同时出现 `result`。
- error code 至少稳定定义 `protocol_mismatch`、`unsupported_operation`、`deadline_exceeded`、`service_not_startable`、`ownership_conflict`、`proxy_not_ready`、`stop_failed`、`restore_failed`、`runtime_integrity_failed`。
- bridge 自身 exit code：0=成功 envelope，1=操作失败 envelope，2=协议/参数错误。Rust 同时校验 exit code、schema、requestId 和 envelope；任一不一致视为 `bridge_protocol_error`。
- core CLI/函数的 stdout/stderr 必须重定向到有界捕获或 Desktop 日志；bridge stdout 不能透传 `ocx stop/service` 的人类文本。日志写入前沿用隐私过滤，最多保留 64 KiB/次，Rust 不从日志推断结果。
- bridge handler deadline：`status` 10 秒，`bootstrap`/`stop` 90 秒，runtime/service/tray mutation 120 秒。`runtime-activate` 在 abort 后最多再等 10 秒做 best-effort transaction cleanup，Rust process watchdog 为 135 秒，避免与 bridge deadline 同时竞速；cleanup 仍继承已 abort 的 signal，不保证当次 rollback/recovery 完成，未决 journal 由下一次 bootstrap 恢复。其他 operation 的 Rust watchdog 与各自 bridge deadline 相同。超时只终止短生命周期 bridge；不得直接 kill 已启动的代理。mutation 的 bridge failure envelope 与 Rust watchdog timeout 都视为 outcome unknown，统一先重读 candidate/previous pointer、从该 current 重新解析 bridge、用新 `status` 对账 owner/version/readiness 并再次比较 pointer，禁止盲目重放 activation。

封闭操作枚举：

- `bootstrap`：找现有代理。service 为 `installed+startable` 时启动/等待 service；为 `installed+not-startable` 或 ownership conflict 时返回稳定错误且禁止 direct；仅在 service 未安装时启动一次 App-owned direct proxy。最后等待 `findLiveProxy` + `probeReadiness` 对同一 PID/端口成功。
- `status`：返回当前身份、origin、版本、service 可用性和所有权，不返回路径外的敏感状态。证据冲突时仍返回成功 envelope，`result.owner` 为 `unknown/conflict` 并附 `allowedMutations: []`；`bootstrap` 和 mutation operation 遇到同一状态则返回 `ownership_conflict`。
- `stop`：调用与 CLI 共用的结构化 stop transaction，等待身份校验后的“代理不存在”，并返回 stop/restore/ownership 结果。
- `runtime-activate`：只对已证明且在 preflight `allowedMutations` 中显式声明该 capability 的 `desktop-direct` 开放。Rust 只传 staged manifest id；bridge 固定走 direct activation transaction，在锁内复验 owner/current/manifest/install-id，stop old、从候选绝对路径启动并复验 child records/`/readyz` 后 CAS 提交；失败从旧绝对路径恢复。`existing-external`、`desktop-service`、`unknown/conflict` 以及不声明 capability 的旧开发 generation 在任何 stop 前拒绝。本功能进入首个公开 Desktop 版本前没有公开兼容 generation；此前开发包不承诺原地升级。
- `service-install`、`service-start`、`service-repair`、`service-uninstall`：只接受上述预定义 payload；repair/uninstall 仅对已证明的 `desktop-service` 开放。
- `legacy-tray-uninstall`：只调用现有固定 tray uninstall，且只在用户已确认的第 2 期迁移事务中使用。

result union 同样封闭并拒绝未知字段：

| operation | `result` |
|---|---|
| `bootstrap` | `{ status: "ready", origin, pid, version, owner, service, allowedMutations }` |
| `status` | `{ status: "ready" | "pending" | "stopped" | "failed", origin: string | null, pid: number | null, version: string | null, owner, service, allowedMutations }` |
| `stop` | 下述 `StopTransactionResult`，不得降格为单一 boolean |
| `runtime-activate` | `{ changed, service, proxyStatus }`；不返回绝对路径、owner record 或 token |
| `service-*` | `{ changed, service, proxyStatus }`；不返回绝对路径或 token |
| `legacy-tray-uninstall` | `{ changed }` |

`owner` 固定为 `existing-external | desktop-direct | desktop-service | unknown/conflict`；`service` 固定为 `{ installed, startable, stateCode }`；`allowedMutations` 只能从本节 operation 枚举取值。

Rust 不得获得“任意 CLI argv”操作。新增固定操作必须更新 schema、capability、正反向测试和本节。

现有 `src/cli/index.ts` 有顶层 dispatch，`handleStop()` 又把语义渲染为 console/exit code，因此 bridge 禁止 import 它或反向解析文本。第 0 期必须把 stop orchestration 抽到无顶层副作用的 `src/cli/stop-transaction.ts`（名称可随最近模式调整，但职责不可变）：

- `runStopTransaction()` 返回 discriminated result；成功至少含 `{ ok: true, code: "stopped", serviceStopped, proxyStopped, proxyAbsent: true, restoreStatus, grokStatus }`，其中 restore/grok status 是封闭的 `restored | not-needed | failed`。
- 失败 code 至少精确区分 `ownership_conflict`、`stop_failed`、`restore_failed`，并携带 `proxyAbsent`、`retryable` 和脱敏 message。restore 失败即使代理已停也保持 `ok: false`。
- CLI `handleStop()` 只调用 transaction 并负责当前人类文本和 exit code；bridge 调用同一 transaction 并映射 v1 envelope。两者不得各自复制 service/PID/orphan/restore 决策。
- transaction result 不含 token、用户配置内容或可复用凭证；ownership/restore/stop 三类 focused tests 先锁定现有行为。

bridge 必须使用结构化 stdout；代理日志走现有日志文件或受限 stderr，不允许 Rust 解析人类日志来判断成功。

Tauri `externalBin` 只承载短生命周期 bridge。长期代理必须由现有 CLI 以 detached 方式启动，或由 `src/service.ts` 管理；不能把长期代理保留为 `tauri-plugin-shell` 跟踪的 child，因为壳退出/崩溃时插件清理 child 会绕过 graceful stop/restore。

bridge 启动 Bun 时把 `cwd` 固定到校验过的 stable runtime root，并保证该树不含 `.env`。Desktop 不伪造 `OCX_NODE_LAUNCH_CONTEXT` 或其 proof：直接 Bun 启动继续接受仓库现有的 fail-closed ambient Anthropic 语义。若未来必须获得 Node launcher 的环境兼容性，应单独评估捆绑真实 Node runtime 或经过安全审查的等价 launcher，不能仅设置环境标记冒充证明。

### 4.3 运行时依赖闭包与稳定路径

构建阶段为每个 target 生成 manifest（版本、target triple、相对路径、SHA-256、可执行位），只打包生产依赖。不能把开发机整个 `node_modules` 原样复制进产物。

第一次启动先从已签名 App 资源将运行时部署到 per-user app data 的临时目录，校验 manifest 后原子改名并写 `current.json`。App 后续只从该稳定树启动代理；这样 service 不会引用 macOS DMG、Linux AppImage 临时挂载点或会被原地覆盖的资源路径。

约束：

1. target-native 包必须由对应目标平台/架构构建和 smoke，不允许用主机构建结果冒充目标产物。
2. 缺文件、hash 不符、可执行位错误或 native module 不匹配时，在任何 config/service 变更前失败。
3. `ServiceInstallState.bunPath/cliPath` 必须位于 Desktop stable runtime root，才能标记为 `desktop-service`。
4. 启动中的 App-owned 代理迁移时，新版本通过 `/readyz` 后才切换 `current.json`；无代理时可在完整离线 integrity smoke 后提交。至少保留上一完整版本。
5. 清理旧版本前确认没有 service state、运行 PID 或 rollback pointer 引用它。
6. 生成第三方许可证清单；打包来源和版本由 lockfile 固定。

### 4.4 Origin、导航与权限

- MVP 自动 dashboard session 只支持配置本身为 `localhost`、`127.0.0.1`、`::1`（含现有规范化等价形式）的主 listener。`0.0.0.0`/`::` 即使可经 `probeHostname()` 从 loopback 访问，`isApiAuthRequired()` 仍会阻止 GUI session 签发，因此 Desktop 必须拒绝 attach 并给出改回 loopback 的诊断；具体 LAN hostname 同样拒绝。不得注入或代填 admin token 绕过。
- 主窗口只允许 App 本地加载页（若使用）和 bridge 返回的精确 `scheme + host + port`。代理重启改变端口后，必须重新 bootstrap 再更新 allowlist。
- `http://` 或 `https://` 的非 dashboard 导航在 WebView 内拒绝，并通过受限 opener 交给系统浏览器；未知 scheme 默认拒绝。
- GUI 前端不获得通用 shell、filesystem 或 process 权限。sidecar 调用由 Rust 持有，参数为固定枚举；即使引入 `tauri-plugin-shell`，也不给 dashboard JS `shell:allow-execute/spawn`。
- Tauri capability、updater 公钥和 deep-link scheme 均为显式 allowlist；任何 token 都不得进入 argv、URL、日志或 crash report。

### 4.5 生命周期真值表

| 事件 | 所有者 | 必须结果 |
|---|---|---|
| 冷启动，无 service/代理 | bridge | 启动一次 desktop-direct，等 `/readyz`，再创建/显示窗口 |
| 冷启动，service installed + startable | bridge + `src/service.ts` | 启动/等待 service，不再 spawn direct child |
| 冷启动，service installed + not-startable/conflict | bridge | fail closed，显示 repair/uninstall/同 home 诊断；禁止 direct fallback |
| 已有任意 OpenCodex 代理 | bridge | 连接现有 canonical origin，不启动第二份 |
| 第二次启动 App | single-instance | 把 argv/deep link 交给首实例并聚焦窗口 |
| 关窗口 | Rust shell | 隐藏到托盘；代理继续运行 |
| 托盘退出 / Cmd+Q | bridge stop | 先 stop + restore + 验证 absent，再退出；失败则保持壳存活并显示可操作错误 |
| dashboard 自己执行 Stop | 代理 + Rust shell | 连接断开后显示“已停止”，提供重新启动或退出，不循环自动拉起 |
| desktop-direct 崩溃 | Rust shell | 显示失败与“重试”；不做无限重启循环 |
| service child 崩溃 | `src/service.ts` | 壳只等待 supervisor 的替代实例并重新 bootstrap |
| 壳被强杀/崩溃 | OS | 不向代理发送隐式 stop；下次启动只重新连接 |
| 系统关机/注销 | OS + 现有生命周期 | 不建立第二套 restore；代理现有信号/service 语义保持权威 |

“显式退出”是用户对当前活动代理的停止命令：即使 App 最初连接的是 `existing-external`，也可以调用现有 `ocx stop`，但必须服从相同 home/identity/ownership 拒绝并在失败时保持壳存活。这个权限不扩展到更新、迁移或删除 external 安装树。

## 5. 目录、分支和所有权

```text
desktop/
  PLAN.md
  README.md
  package.json / lockfile        # 仅桌面前端/构建需要时
  runtime/                       # Bun bridge 与 manifest 生成逻辑
  src-tauri/                     # Rust 壳、Tauri 配置、capabilities、icons
  scripts/                       # 运行时 staging、target/manifest 校验
  tests/                         # bridge、生命周期和打包契约测试

.github/workflows/
  desktop-ci.yml                 # GitHub 只读取根 .github/workflows
  desktop-release.yml            # 独立于 npm release
```

规则：

1. 新桌面代码默认进 `desktop/`；通用 runtime 改动必须小、默认关闭并有 focused regression test。
2. 不在 `desktop/.github/` 放“workflow 片段”；可执行 workflow 必须位于仓库根 `.github/workflows/`，并按安全边界接受显式审查。
3. 核心不变量不动：Lab 不进入 `router` / `lifecycle` / `responses/core`；`/api` 与 `/v1` 凭证分离；stop 必须还原 Codex。
4. 任何 App-owned service/autostart/tray 变更必须记录所有权和 rollback 信息；不能把“同一个配置目录”当成“同一个安装所有者”。
5. 安全预披露材料只进 `.tmp/` 或临时目录，不进本计划或 `devlog/`。

## 6. 必须先钉死的决策

### 6.1 Desktop distribution marker

第一期不预设 `OCX_APP_SHELL=1` 能解决问题。只有探针证明需要 core seam 时，新增一个单一、测试覆盖的 distribution marker，其职责最多包括：

- 抑制 App-owned 非交互代理的 npm 更新提示；
- 让 dashboard update API 明确报告“由 Desktop updater 管理”，拒绝 npm 自更新；
- 由 Desktop 安装的 service 继承该 marker。

该 marker 不能改变认证、session、路由、stop/restore 或 Lab 激活，也不能作为安全身份凭证。外部 npm 代理没有 marker，App 连接它时不得改写其更新渠道。

### 6.2 所有权模型

状态至少区分：

- `existing-external`：由 npm/其他启动方式管理；App 只连接，更新器不动它。
- `desktop-direct`：由 Desktop stable runtime 启动，无 service；必须通过下述持久 owner record 证明。
- `desktop-service`：service state 的绝对 Bun/CLI 路径和 Desktop manifest 均证明归 Desktop 所有。
- `unknown/conflict`：证据不足或路径/环境不匹配；Desktop 的迁移、更新、repair、uninstall 均 fail closed，显示现有修复命令。用户显式 `stop` 仍可调用现有 CLI，但只能由 CLI 自身的 home/PID/ownership 检查决定是否执行。

不得仅根据 PID、端口、`OCX_SERVICE=1` 或文件存在来推断 Desktop 所有权。

`desktop-direct` 所有权需要一个 core seam：代理在成功 bind 后，以两个原子文件发布 mode-protected `runtime-port.json` 和 `desktop-direct-owner.json`，并在二者都落盘前保持 `/readyz` 为 pending。owner record 至少包含 schema、Desktop install id、runtime manifest id/version、绝对 Bun/CLI 路径、PID、随机 launch nonce 的摘要和创建时间；runtime record 写入相同 owner id。不得把 nonce/路径暴露到 `/healthz`。

启动前，bridge 在 `OPENCODEX_HOME` 下创建 owner-only、一次性 launch descriptor（install id、manifest id、预期 Bun/CLI 绝对路径、随机 nonce），并只把 descriptor 路径传给目标 child；child 校验目录权限、manifest/path/nonce 后消费它。代理 child 是 runtime/owner records 的唯一写入者和正常清理者；bridge/Rust 在 ready 前后都不得创建、覆盖或“修复”这两个记录。

bridge 只有在以下证据全部一致时才认定 `desktop-direct`：PID 通过现有完整身份校验；runtime PID/port/owner id 与 owner record 一致；实际进程 Bun/CLI 路径落在 manifest 校验过的 stable runtime；install id 与当前 Desktop 安装一致。正常退出按 PID/owner snapshot 删除记录；崩溃后的活进程仍可复认，死 PID 的记录只能比较后清理。任何一项不一致都分类为 `unknown/conflict`，不得删除 runtime 树。

## 7. 分期执行

### 第 0 期：风险探针与冻结契约

目标：先关闭高风险假设并落地 shared core 前置条件，再写产品壳主路径。

工作项：

1. 写 `desktop/README.md` 短版，包含生命周期真值表、所有权、数据目录和已知限制。
2. **探针 A：WebView**
   - 用最小 Tauri 2 顶层窗口打开 bridge 返回的动态 loopback origin。
   - 验证 session bootstrap、真实 CSRF 写操作、hash 路由、OAuth 系统浏览器、外部导航阻断。
   - 隐藏窗口超过 5 分钟，再执行一次写操作，证明 GUI 自己完成 session 续期。
3. **探针 B：打包闭包**
   - 在不使用系统 Node/Bun/npm/global ocx 的环境，从 packaged resources 部署 stable runtime 并启动 `src/cli/index.ts start`。
   - 覆盖动态 import、`gui/dist`、`package.json` 版本读取、生产依赖和至少一个 target-native 模块加载。
   - 校验 `runtime-port.json`、PID 身份、`/healthz`、`/readyz` 与 `findLiveProxy` 一致。
4. **探针 C：service 与更新路径**
   - service install state 只能引用 stable runtime；移动/删除 App 原始安装位置后，策略仍明确（继续工作或可诊断失败）。
   - 演练新 runtime staging、service stop/repair/start、失败回退上一版本，不碰用户 `~/.opencodex/` 凭证和 `$CODEX_HOME` journal。
   - 演练 surviving desktop-direct 的持久复认、新旧 runtime 切换、失败后从旧绝对路径重启，以及 conflict 时禁止删除。
5. **探针 D：单实例与竞态**
   - 并发启动两个 App，第二个只聚焦首实例。
   - App 启动与外部 `ocx start` 竞态时，最终只接受一个身份校验通过的代理；不因端口漂移连接错误实例。

跨 CLI 的 start transaction lock 是 MVP 的确定前置项，不是探针后的可选修复。必须在 core `handleStart` 子进程中增加 `OPENCODEX_HOME` 下的跨进程锁：实际子进程取得锁后重新执行 owner discovery，只有仍无 winner 才 bind；锁持有到 PID/runtime/可选 desktop owner records 发布完成后释放。失败者取得锁后发现 winner，按调用语义返回 existing/duplicate，不再选临时端口。

父级 `ensure` 和 Desktop bridge 不持该锁再等待 child，避免父子死锁；它们可以并发 spawn，由实际 `handleStart` 串行决胜。锁使用唯一 owner token、存活检查和 compare-before-reclaim，覆盖 `ocx start`、ensure/service/Desktop 的共同启动路径。第 0 期先添加多进程失败回归，再实现锁；focused race test 和 shared runtime 全量测试通过后，探针 D 才能验收。只给 Desktop bridge 加私有锁不能解决与外部 CLI 的竞态。

证据写入 `desktop/probes/`，只保存命令、版本、脱敏日志、截图和结论；不保存 token、请求体、账号标识或用户路径快照。

门禁：任一探针失败，先修壳、资源或 bridge；禁止通过放宽 management auth、CORS、XFO/CSP、PID identity 或 stop ownership 来过关。

### 第 1 期：功能 MVP 窗口与托盘

当前进度（2026-09-01）：Probe A 的可自动化增量已落地，但仍不关闭探针。壳在 setup 中创建唯一 `main` WebView。导航信任是带 identity 的 dashboard attachment（canonical origin + pid + owner + version），仅在 `status=ready` 且 loopback 校验通过后提交。status 对账、attach/shell、以及显式 Quit 整笔事务由 transition mutex 串行：Quit worker 在 `default_bridge_spec` 之前取锁，并持有到 stop 与 Exit/StayVisible；Tray Status 也只在持锁后解析 spec。epoch/CAS 丢弃过期 ready 回滚与乱序 stopped/ready；stale commit 从已持有的 ledger 同步 policy，不再二次加锁。Tray Open / single-instance 只走 `status`：同一 identity 只展示，ready 替换才重新 attach，stopped/failed 撤销信任；dashboard Stop 后不 `bootstrap`。离开已 attach 的 dashboard 时先 hide，再 revoke，再导航到当前平台的 canonical local URL（Unix `tauri://localhost/`，Windows/Android 默认 `http://tauri.localhost/`，不启用 `use_https_scheme`；非默认 port 拒绝，HTTP `:80` 由 url::Url 规范化掉）；最终 attach/reveal/show 在 phase→session→navigation 锁序下要求 `QuitPhase::Running`；PageLoad 不持 transition。`WebviewWindow::eval` 只算 dispatch；local `__ocxApplyAndAckShell` 写入并校验 DOM 后 `ack_shell_render`（canonical URL + epoch + marker + 本次 attempt CAS）才 Shell/show。成功 eval 才武装一个 delayed timer；eval 失败保留 attempt，只入队 immediate 后台 handoff，PageLoad 不在回调里 hide/navigate。Reload CAS 进入 `ReloadingShell { epoch, generation }`（不可 dispatch），先 hide 再 navigate 到 `?ocx-reload=<generation>`（query，不是 fragment：WebView2 fragment-only Navigate 不触发 navigation/Finished）；分类用 `url.query()` 与 `ocx-reload=<Uuid::hyphenated().to_string()>` 逐字节比较，不用 `query_pairs`；PageLoad 只用 `payload.url()` 分类，匹配 generation 才回到 `PendingShell` 并 arm 下一次 eval。window 缺失 / navigate dispatch Err / load watchdog 到期则对该 generation exact-CAS GiveUp 并保持隐藏。`WebView::navigate` Ok 只算 dispatch，不声称物理加载成功。物理诊断渲染仍 OPEN。默认 `LoadingShell`：无诊断的第一次 canonical Finished 把 surface 标为 `Shell` 但不 show，之后的失败走 `eval_now`；eval 失败则 hide、把诊断留在 `PendingShell` 并 canonical reload。第一次 Finished 前的失败仍只排队、保持隐藏。Open/Status/bootstrap 持锁后仅 `QuitPhase::Running` 才解析 bridge。HTTP 探针 JSON 字段为 `hashRouteUrlSameOrigin`（URL 构造，不是 Rust WebView 导航）。`decoySymlinkCoverage` 为 `covered` 或 `unsupported`。PageLoad 在 Finished+canonical 之后按 phase→session 锁序 blocking 持有合并后的 shell session（不持 transition，不用 try_lock，避免 canonical navigate 同步 Finished 重入死锁或丢掉唯一 Finished）；`plan_canonical_finished` 不因 dispatch 消费 pending，只派发 eval，不 show。show 只在 `ack_shell_render` 对 canonical URL + epoch + marker + 当前 attempt + Running 的 CAS 成功后发生。`ReloadingShell` 上 begin_ack/ack 拒绝。CAS miss / 非 Running / 过期 generation 为 Ignore，不操作窗口。inactive 的 tauri/http/https 形态、asset protocol、凭据与 attach 后的 app-local 均拒绝。Probe A 父进程使用 stdlib 加上 desktop 合同/`runtime/origin`（不 import `src/`）安装隔离 env 再 spawn child；child 在 import 前武装 `OCX_TEST_HOME_GUARD`，把 `OCX_REAL_HOME` 指到沙箱外 decoy，并断言 `src/codex/paths` 的模块加载常量和 `getConfigDir`/admin path 都在 sandbox 内。`webviewEvidence=false` 且 `hideRenewalEvidence=false`。物理顶层 WebView、隐藏 6 分钟后的第一次写操作、以及从 WebView 点击 OAuth 后的系统浏览器仍 OPEN。

当前进度（2026-08-31）：Tauri 工程、共享 start/stop/owner seam、v1 bridge、窗口/托盘/single-instance 骨架、target-native runtime payload builder，以及 packaged resource 到 per-user stable runtime 的首次启动接线已落地。builder 在目标主机用 Bun `--production --frozen-lockfile --ignore-scripts` 生成闭包，只保留匹配 target 的 Bun/keyring 原生包，最后写入并复验 manifest；release `build.rs` 在没有真实 payload 时拒绝继续。App 启动先通过独立固定 argv 的 `desktop/runtime/install.ts` 校验并部署资源：无 `current` 时原子发布，同版本仅在规范化 manifest 完全一致时复用，已有不同 `current` 时只 stage 候选而不提前切换。已有 current 时，Rust 先从旧 generation bootstrap/reconcile，避免未恢复 journal 阻断 staging；若新候选与 current 不同、owner 为 `desktop-direct` 且旧 generation 声明 `runtime-activate` capability，Rust 从旧 bridge 发固定请求。事务成功后精确复验 `current=new/previous=old`，重新解析新 bridge 并再次 bootstrap。external/service 候选保持 staged，不走 direct stop；bridge timeout envelope 与 Rust watchdog timeout 统一先检查 candidate/previous post-image，从该 current 重新解析 bridge 并核对 owner/version/readiness，再双读 pointer，绝不重放 activation。中断遗留的临时 staging 树由下一次成功持锁的部署清理；版本树保留到具备 service/PID 所有权证据的更新事务。Linux x64 `.deb` 已通过解包资源布局探针和真实 `dpkg` 安装后 Probe B（`desktop-direct` + 严格 `/readyz` + structured stop + `dpkg -r`）。探针 C 的确定性事务基础与 production bridge 接线已落地（owner-only checksum journal、activation.lock、verified stable 解析、精确 service 路径、stop → install/repair/direct activate → start → 严格 ready → 完整 `current.json` CAS、partial cleanup、三代 B/A rollback、post-image finalize/rollback、successor/PID fail-closed、`canRespawn` 规范 absence window）；证据见 `desktop/probes/probe-c-service-runtime-transaction.md`。真实子进程 two-generation desktop-direct 探针已接线（`desktop/scripts/probe-desktop-direct-two-generation.ts`，证据 `desktop/probes/probe-c-desktop-direct-two-generation.md`）：filesystem owner/runtime records、survivor 同 PID 复认、`runtime-activate` 在 child records + 严格 `/readyz` 之后才提交 current=new/previous=old、失败候选以 manifest-valid ready-failed CLI 先启动再让生产操作失败，只停候选并从旧绝对路径重启、冲突所有权 fail-closed 且不删 generation。该证据是 packaged payload 上叠加当前 `desktop/runtime`+`src` 的 live-process 证据，不是两份不可变 packaged Desktop release；真实 Tauri 旧/新包证据仍 OPEN。live ready-failed rollback 与 Linux runtime-layout `.deb` systemd user-service smoke 已在 GitHub Actions `desktop-linux-systemd-probe.yml` job `linux-deb-systemd` 于 commit `898e4bebf6bf61ec90e1c54e9df74be04d38a028` 记为通过（run [33387507384](https://github.com/abbzbb/opencodex/actions/runs/33387507384)，2m43s；two-generation 在 `dpkg` 之前用 `OCX_PROBE_RUNTIME_ROOT`；systemd 为 runtime-layout `.deb`，非 Tauri GUI 包）。本机 live rollback 不记成功。macOS/Windows 物理 smoke 未做。探针 C 仍 OPEN。service-path 与 global-stop 的 shared-lock 竞态仍为 WATCH。尚未完成的是物理 WebView/6 分钟 hide-reopen 写操作、signing/updater，以及其他平台与 service/update/deep-link 后续期。session/CSRF/hash 路由/new-window 拒绝的自动化合同见 `desktop/probes/probe-a-webview-session-navigation.md`。

工作项：

1. 创建 Tauri 2 工程并固定 Rust/Tauri/plugin/Bun 版本和 lockfile。
2. 按 target triple 生成 `ocx-runtime-$TARGET_TRIPLE[.exe]`；打包脚本校验 triple、架构、hash 和 Unix executable bit。
3. 实现 manifest 校验、stable runtime staging、`current.json` 和一代 rollback 保留；App bundle 内源文件必须用 Tauri `BaseDirectory::Resource`/resource resolver 定位，不手拼安装路径，并用真实 packaged artifact 测试布局。
4. 落地 core start transaction lock、`desktop-direct-owner` 两文件发布/清理 seam，以及共享结构化 stop transaction；先有并发、stale-record、ownership/stop/restore 回归，再接 bridge。
5. 实现 v1 JSON bridge 的 request/response schema、`bootstrap/status/stop`、deadline、稳定错误码、日志隔离与错误 envelope；Rust 不解析 CLI 文本日志。
6. 主窗口在 `/readyz` 成功后才创建或显示；启动超时/failed 状态显示原生错误和日志位置。
7. 第一阶段即实现三平台 tray：打开、状态、退出；关窗口隐藏，Cmd+Q/托盘退出共享同一 stop transaction。
8. 第一阶段即实现 single-instance，避免双壳引起启动竞态。
9. 实现精确 origin navigation allowlist 和系统浏览器 handoff；前端不暴露 shell capability，并以 capability 负向测试证明 dashboard JS 不能执行未列入的 binary/argv、filesystem 或 updater IPC。
10. 代理意外退出后显示 stopped/error 状态；只有用户操作才重新启动 desktop-direct。

验收：

- 无全局运行时的干净机完成 provider 配置和一条 `POST /v1/responses`。
- 冷启动、热启动、20 次连续双击均无第二代理/第二托盘。
- 隐藏 6 分钟后重新打开，第一次管理写操作成功。
- 外部链接在系统浏览器打开；任意非 allowlist 导航不能留在 WebView。
- wildcard/LAN bind 返回受支持的稳定诊断，不加载无 session dashboard。
- 托盘退出和 Cmd+Q 都确认代理 absent 且 Codex 已还原；模拟 ownership mismatch/restore failure 时 App 留在屏幕并报告失败。
- dashboard Stop 后 App 不立即重启代理。
- 壳崩溃后重新启动，仍能用 owner/runtime/PID/manifest 证据复认 surviving desktop-direct；篡改任一记录则 fail closed。

### 第 2 期：service、旧托盘迁移与深度链接

工作项：

1. 开机自启只走现有 `ocx service install/start/repair`，并且仅在用户显式开启后执行；App 安装本身不静默注册 service。
2. service 使用 Desktop stable runtime 的绝对路径；更新时只 repair `desktop-service`，不碰 `existing-external`。
3. Windows 检测已有 `ocx tray`。迁移前展示明确选择；只有用户确认后才调用现有 tray uninstall，并在失败时保持旧状态，不产生双托盘。
4. 启用 bridge 的固定 `service-*` 和 `legacy-tray-uninstall` 操作；任何未列入 schema 的 argv 在调用前拒绝。
5. 注册 `opencodex://` 深度链接并严格解析 allowlist 路由；未知 host/path/参数拒绝。
6. Tauri 中 `single-instance` 必须最先注册，并启用 deep-link 集成后再注册 deep-link plugin；Windows/Linux 的第二进程 argv 转发和 macOS 静态 scheme 分别测试。
7. Linux AppImage 移动会破坏绝对 deep-link 注册。便携 AppImage 不承诺 service/deep-link/autoupdate；完整功能以 `.deb` 为准，除非安装后探针证明可修复注册。

验收：

- 重启机器后代理只由 service 拉起；打开 App 只连接并显示窗口。
- service 崩溃替换实例后，App 重新 bootstrap 到新身份，不自行 spawn direct child。
- Windows 任务管理器和通知区只有一个 OpenCodex 操作入口。
- `ocx stop`、App 显式退出、service stop/uninstall 均按现有语义还原 Codex。
- 冷/热状态下深链都落到允许的 hash route；恶意/未知 URL 被拒绝且不进入 WebView。

### 第 3 期：安装器、签名与更新

首发支持矩阵：

| 平台 | 首发产物 | 架构 | 功能说明 |
|---|---|---|---|
| macOS | `.dmg` | arm64、x86_64 分开构建 | 内部分发可暂用未公证包；公开分发必须签名/公证 |
| Windows | NSIS | x64 | 公开分发必须代码签名；MSIX/arm64 后续单独评估 |
| Linux | `.deb` | x86_64 | 完整 service/deep-link；首发手工包更新，不宣称 Tauri 自动更新 |
| Linux portable | AppImage | x86_64 | 可选；默认无 service/deep-link/autoupdate 承诺 |

发布与更新规则：

1. 新增独立 `desktop-release.yml`，不复用或改写 npm release。所有 workflow 改动需显式安全审查，第三方 actions 固定不可变 ref。
2. 目标平台原生构建；发布 manifest 记录 app version、runtime version、target、SHA-256 和下载 URL。
3. Tauri updater 签名是强制门禁，不能由 macOS/Windows 代码签名替代。设置 `bundle.createUpdaterArtifacts: true`；私钥只从发布环境的 `TAURI_SIGNING_PRIVATE_KEY` 注入、禁止写入 `.env`，公钥内容进入配置，更新 endpoint 必须 HTTPS。每个平台 manifest 必须包含 payload URL 和对应 `.sig` 的文本内容，而不是签名文件路径。
4. 发布匹配的 updater payload 和 `.sig`：macOS `.app.tar.gz + .sig`、Windows NSIS installer + `.sig`。Tauri 的 Linux updater 只消费 `.AppImage + .sig`，不能更新 `.deb`；因此 `.deb` 首发走签名包的手工更新。只有 AppImage 稳定安装路径、移动后重注册和故障注入都通过时，才为该 profile 发布 AppImage updater manifest。
5. updater 只替换 App；运行中的旧代理位于独立 stable runtime，因此更新 App 时不原地覆盖其 package tree。新 App 首次启动先将新 runtime stage 到明确版本路径并校验，但在 owner-specific transaction 成功前不改 `current.json`。
6. `desktop-service` 更新事务：记录旧 service state/current -> graceful stop -> repair 到新版本绝对路径 -> start -> 校验新 PID/version `/readyz` -> 提交 current。失败则 stop candidate -> repair 回旧绝对路径 -> start old -> 校验 old ready；恢复也失败时保留两代树和诊断，禁止清理。
7. `desktop-direct` 更新事务：验证 owner record -> graceful stop old -> 为新版本生成一次性 descriptor 并从新版本绝对路径启动 direct -> child 发布新 runtime/owner records -> bridge 校验该快照及新 PID/version `/readyz` -> 只提交 `current.json`。失败则 stop candidate -> 为旧版本生成新 descriptor 并从旧绝对路径重启 -> 校验 old child 自己发布的 records 和 `/readyz` -> 只恢复旧 current；任一步 ownership 不确定都禁止删除旧树。
8. 无代理时只部署并提交校验过的新 current；`existing-external` 运行时可部署 Desktop runtime，但不停止、不替换、不声称更新 external 代理；`unknown/conflict` 中止迁移。
9. 上述 rollback 只覆盖 runtime、direct owner 和 service state，不等于回滚已被 Tauri updater 替换的 App 本体。Tauri updater 没有在本计划中被假定为 App A/B rollback。只有额外的 App 本体恢复机制（外部 bootstrapper/安装器事务）完成故障注入后才启用自动更新；此前只发布签名安装器和手工更新。
10. App-owned runtime 的 npm self-update 路径必须明确禁用/报告 Desktop 管理；连接 external npm runtime 时，App updater 不声称已更新该代理。
11. 卸载器在用户确认后按 owner 分支：证明为 `desktop-service` 时 stop + uninstall；证明为 `desktop-direct` 时 stop + 验证 absent；`existing-external` 不停止也不删除；`unknown/conflict` 中止删除并给诊断。只有不存在引用 App-owned runtime 的 PID/service/rollback pointer 后才删 runtime。默认保留 `~/.opencodex/` 配置、凭证、日志和用户数据。

启用自动更新的额外门禁：签名错误、下载中断、磁盘满、进程被杀、service repair 失败、desktop-direct 新旧切换失败、首次新版本 `/readyz` 失败、runtime rollback 失败和 App 本体恢复失败均有自动化或可重复故障注入证据。达不到时只发布签名安装器和手工更新说明，不启用自动更新 UI。

### 第 4 期：可选产品化

- 首次启动向导复用已有 Startup 管理 API，不在壳里复制 provider/credential 表单。
- 原生状态菜单只显示无凭证状态：运行/停止、端口、版本；模型与账号健康继续由 dashboard 管理。
- 单开里程碑评估 `bun compile`，先形成动态 import、native module 和资源定位清单。
- 评估更多架构和 portable Linux 的完整支持。

非目标仍是：原生控件重写 GUI、移动端、第二套代理实现。

## 8. 风险登记

| 风险 | 严重度 | 预防/门禁 |
|---|---|---|
| `/healthz` 早于 Codex 同步完成 | 高 | 加载前必须严格 `/readyz`，PID/port 一致 |
| Rust 重写 liveness/stop 后漂移 | 高 | 短生命周期 Bun bridge 直接复用现有模块 |
| service 引用易失 App/AppImage 路径 | 高 | stable runtime + absolute-path ownership + repair/rollback probe |
| 生产依赖/native module 漏包 | 高 | target manifest + 干净机 packaged smoke |
| App updater 与 npm updater 抢所有权 | 高 | distribution marker + external/desktop owner 分离 |
| 托盘退出 stop 失败但壳先退出 | 高 | stop transaction 成功并验证 absent 后才退出 |
| 任意导航留在高权限 WebView | 高 | exact-origin `on_navigation` + constrained opener，默认拒绝 |
| 双实例/外部 start 竞态 | 高 | single-instance + core start transaction lock + winner identity/readiness recheck |
| surviving direct 无法证明安装所有权 | 高 | protected owner/runtime 双记录 + PID/cmdline/manifest/install-id 联合校验 |
| wildcard/LAN bind 无 GUI session | 高 | MVP 明确拒绝 attach，不注入 admin token |
| Windows 旧 tray 与 App tray 并存 | 中 | 显式迁移、失败回滚、安装时不静默修改 |
| GUI session 5 分钟后失效 | 中 | 6 分钟 hide/reopen 写操作验收，复用现有自动续期 |
| Tauri updater 被误当成自动回滚 | 中高 | 故障注入门禁；未证明前仅手工签名更新 |
| macOS/Windows 未签名分发受阻 | 中 | 内测与公开发布门禁分开，公开发布必须 OS 签名 |

## 9. 验证矩阵

### 9.1 自动化门禁

```bash
# Desktop Rust/Tauri（具体命令在工程创建后固化到 desktop/README.md）
cargo fmt --check --manifest-path desktop/src-tauri/Cargo.toml
cargo clippy --manifest-path desktop/src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path desktop/src-tauri/Cargo.toml

# Desktop bridge / manifest / ownership focused tests。根 bunfig 只发现 tests/，
# 因此通过独立脚本显式重设 root，并继续经 scripts/test.ts 获取隔离 home 与机器测试锁。
bun run typecheck:desktop
bun run test:desktop

# 若修改 src/ 通用 seam
bun test tests/<受影响>.test.ts
bun run typecheck
bun run privacy:scan

# 若修改 shared server/service/update/lifecycle 行为
bun run test
```

不改 `gui/` 时不重复跑 GUI 全量；若修改 Startup/update 展示，按 `gui/AGENTS.md` 跑 focused test、lint、doctor 和 build。非平凡 PR 标记 review-ready 前仍按仓库规则执行全量 typecheck/test。

`desktop/tests` 至少覆盖：每个 request payload 的接受/拒绝、未知字段/版本/operation、bridge success/error schema、错误 requestId/schema/exit code、stdout 污染、deadline；status conflict 的成功诊断与 mutation conflict 的失败；service absent/startable/not-startable/conflict 四态；owner/runtime/PID/path/manifest 任一不匹配；stale owner compare-before-clean；direct/service 更新成功与 rollback。core focused tests 至少覆盖结构化 stop 的 `ownership_conflict`/`stop_failed`/`restore_failed`，CLI 与 bridge 映射同一 transaction；多个真实子进程同时 `start`/`ensure`、锁 owner 崩溃回收、winner 发布前失败；desktop owner 两文件部分写入时 `/readyz` 不得 ready；bridge 在 ready 后不能写 owner record。由于 start lock、stop transaction 和 process-state 是 shared runtime，落地它们的 PR 必须跑全量 `bun run test`。

### 9.2 每个平台的安装后 smoke

Linux x64 已有两个 Debian 探针：

- [`phase1-linux-deb-resource-layout.md`](./probes/phase1-linux-deb-resource-layout.md)
  从真实 release `.deb` 解包，验证 Tauri 资源相对路径、双份 runtime 哈希、stable
  首次发布/复用、stable bridge `status` 和 target-native keyring 加载。它不执行
  `dpkg`、不启动代理或 WebView。
- [`phase1-linux-deb-postinstall.md`](./probes/phase1-linux-deb-postinstall.md)
  在 digest-pinned Debian 13 容器中 `dpkg -i` 真实 `.deb`，以 uid 10001 / 零
  capability / `--network none` 启动 `/usr/bin/opencodex-desktop`，证明
  `resource_dir()` → stable runtime、`desktop-direct` 所有权、PID/runtime-port/
  `findLiveProxy` 一致、`/healthz` 与严格 `/readyz`、structured stop 后独立
  absent，然后 `dpkg -r`。探针直接断言无 Codex CLI，核对完整 `current.json`
  身份（id/version/target/relPath 且 previous=null），并在卸载后独立确认
  资源 runtime 路径已消失且包不再 installed。成功 stdout 只有一条 JSON。
  它不是 WebView、session、CSRF 或导航证据。
- [`probe-a-webview-session-navigation.md`](./probes/probe-a-webview-session-navigation.md)
  live loopback HTTP session bootstrap、CSRF 写、`/opencodex-session` 续期文档、
  wildcard 不签发 session，以及 Rust exact-origin / new-window deny。不是物理
  WebView，也不是隐藏 6 分钟后的写操作。

1. 干净用户，无 Node/Bun/npm/global ocx。
2. 安装并冷启动，确认 `/readyz` 后才显示 dashboard。
3. 配置测试 provider，执行一条 Responses 请求。
4. 热启动、并发双击、关窗/重开、隐藏 6 分钟后写操作。
5. OAuth 系统浏览器与回调；普通外链系统浏览器；恶意导航拒绝。
6. 托盘退出、Cmd+Q、dashboard Stop、代理崩溃、壳崩溃。
7. service install/start/crash-restart/stop/uninstall；Codex restore 前后 diff。
8. 外部 npm 代理已运行时只连接，不迁移、不更新。
9. surviving desktop-direct 的 App 重启复认、旧 -> 新 runtime 切换、失败后旧 runtime 恢复。
10. 安装旧版 -> 签名更新 -> service repair -> 新版 ready；再做每个更新故障注入。
11. 卸载分别覆盖 desktop-service、desktop-direct、existing-external、conflict；无悬空 App-owned service/process，外部代理和用户配置/凭证仍在。

所有 smoke 记录 App/runtime/Tauri/WebView 版本和 exit code；日志必须先脱敏，禁止记录请求体、key、token、邮箱或账号 id。

## 10. 开工清单

```text
0. desktop/README.md：生命周期、所有权、数据目录、限制
1. Probe A：顶层 WebView + session/CSRF/renewal/navigation（HTTP session/CSRF + new-window 合同已落地；物理 WebView 与 6 分钟 hide/reopen 仍缺）
2. Probe B：target runtime closure + clean-machine launch + /readyz（Linux x64 `.deb` 已通过安装后探针；WebView 仍缺）
3. Probe C：stable runtime + service absolute path + rollback
4. Probe D：single-instance + concurrent external start
5. Tauri MVP：bridge、窗口、三平台 tray、stop transaction
6. service / legacy tray / deep-link
7. signed installers
8. updater fault-injection gate；未通过则保持手工更新
```

## 11. 决策记录

- 目的：在下游分支把 OpenCodex 做成可双击的 Desktop App，同时保留与上游代理/CLI 的同步能力。
- 选择：Tauri 2 壳 + 现有 Bun 代理 + 顶层 loopback dashboard + 短生命周期 Bun bridge。
- 关键修订：用 `/readyz` 取代 `/healthz` 作为显示门禁；壳退出只走 CLI stop；运行时采用 target manifest 和稳定版本树；所有权区分 external/direct/service；single-instance、导航白名单和三平台 tray 前移到 MVP；自动更新必须先通过签名与 rollback 故障注入。
- 代价：安装包较大；Desktop 需要 Rust/Tauri 发布链；service/update 多一个 stable runtime 迁移事务。
- 收益：不复制认证、路由或生命周期逻辑；不要求终端用户安装 Node/Bun；App 与 npm 安装不会互相覆盖；失败可诊断且不牺牲现有安全边界。

## 12. 外部实现依据

以下链接只约束 Tauri 壳实现；OpenCodex 行为仍以本仓库代码和 `structure/` 为准。

- Tauri 2 sidecar：<https://v2.tauri.app/develop/sidecar/>
- Tauri 2 resources：<https://v2.tauri.app/develop/resources/>
- Tauri 2 single-instance：<https://v2.tauri.app/plugin/single-instance/>
- Tauri 2 deep linking：<https://v2.tauri.app/plugin/deep-linking/>
- Tauri 2 opener：<https://v2.tauri.app/plugin/opener/>
- Tauri 2 updater：<https://v2.tauri.app/plugin/updater/>
- Tauri plugin navigation lifecycle：<https://v2.tauri.app/develop/plugins/#on_navigation>
