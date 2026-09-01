# phase-six probe 实施与实验状态

## 结论

本阶段只交付 phase-six probe 和自动化验证，不占用产品 semver。产品与插件版本仍为
`0.5.0`，`v0.5.0` 标签不变；没有 sidecar/LIVE 状态栏、Stop Hook 改动或 alpha tag。

真实 E1/E2 TUI 实验不宣称通过：本次对人工确认拥有的 loopback 服务完成了真实 E1
前置轮和受控审批轮，审批轮触发了 rev4.2 要求的 fail-closed 硬失败，因此 E1 结果为
`fail`；E2 未启动，仍为 `pending`。没有操作其他正在运行的 Codex 会话，也没有把模拟
测试或前置捕获写成实机通过。

## 实现内容

- `tools/observe-probe.mjs`：手动运行的 App Server 观察探针，支持 loopback WebSocket、
  Unix socket 和 stdio JSON-RPC 传输；输出目录非空时自动分配唯一 `run-*` 子目录。
- `tools/observe-probe-core.mjs`：出站方法白名单、server→client request fail-closed、
  required/metric-required/optional 分级、窗口状态机、断连失效、异常轮 partialUsage、
  有界内存和脱敏事件落盘；TTFT(client) 以首个可见 reasoning/answer delta 为锚点，
  并对已测试 daemon 版本做 capture 建议门禁。
- `tools/observe-probe-transport.mjs`：受限传输端点和 JSON-RPC 客户端；不会回答 server
  request；退订使用独立的短请求超时。
- `tools/observe-probe-e2.mjs`：独立 transcript 参考实现、`capturedAt` 时间锚、静态字段
  逐字段复算、随机交错性能分布/IQR/效应量。它不依赖生产 Stop 指标聚合实现。
- 事件流只保留方法、方向/分级、序号、时间、哈希后的 ID、Unicode 码点长度、UTF-8
  字节长度、匹配布尔值和缺口；delta 正文及正文内容摘要只在内存中比较，均不落盘。

## 自动化验证证据

测试覆盖以下可重复边界：

- 禁止 `turn/start` 等出站方法在发送前抛出非零协议违规；
- 审批 server request 立即 fail-closed、无回包且不泄露参数；
- 未测试 schema 仍捕获但不计算 LIVE/TTFT/usage；未知通知只计数；
- InitializeResponse 当前没有 `schemaVersion` 字段，因此 summary 明确记录
  `schemaVersionSource`、`schemaVersionObservedInInitialize`、`daemonVersionSource` 和
  `captureSuggested`；
  未知 daemon 不自动伪造实测通过，而是提示操作员切换到 capture-only 流程；
- 缺失 optional reasoning 不判 E1；缺失 required 或 metric-required 只使对应指标
  `unavailable`；
- `A😀中` 按 3 个 Unicode 码点、8 个 UTF-8 bytes 计算；
- TTFT(client) 在 reasoning delta 先于 assistant delta 时仍从第一条可见 delta 计时；
- 断连时 open 窗口立即失效，重连不恢复，断连期间中间 usage 不冒充最终 usage；
- abort 会打断重连退避；退订失败/超时不会拖满普通 RPC 超时；完成窗口的 usage
  scratch 数据按 cleanup 延迟释放；
- interrupted 轮只有在显式终态 usage 证据下才生成带状态的 `partialUsage`，不生成速率；
- summary 临时文件原子替换、事件数/总字节数/文件数有界，产物没有 delta 正文或内容
  摘要字段；
- E2 参考复算使用记录内 `capturedAt`，并覆盖重复 token 快照、工具调用、启动前快照、
  超长请求区间、无 turn_id 的完成记录；独立性断言确认其只依赖 `node:fs`，不导入生产
  聚合实现；
- loopback 端点校验、同步 JSON-RPC 响应、正常 runner 发送序列和 server request 路由。

本次自动化命令结果：`npm test` 82/82 通过；phase-six 专项测试 30/30 通过；
`npm run release:check` 通过且版本仍为 `0.5.0`；`npm run doctor -- --json` 通过（Node、
Codex CLI、已安装插件、manifest、Hook、凭据覆盖保护和 OTel 配置检查均为 OK）。

另行执行了隔离的 N1 进程级冒烟（假传输、未连接 daemon/TUI）：故意触发未处理拒绝后，
probe 返回 `exitCode=1`，summary.errors 含 `unhandled_rejection`，原始错误文本未落盘。

## 真实 E1 复现命令与人工步骤

以下命令必须只对人工确认拥有控制权的 daemon/thread 执行，不要填入其他 Codex 会话的
endpoint 或 thread：

```powershell
# Windows 不支持 daemon 生命周期命令。请在专用 PowerShell 中启动并保持运行：
$port = 48765 # 仅使用已确认由当前实验独占的 loopback 端口
codex app-server --listen "ws://127.0.0.1:$port"

# 在第二个专用 PowerShell 中启动 TUI：
$endpoint = "ws://127.0.0.1:$port"
codex --sandbox read-only --ask-for-approval on-request --remote $endpoint

# 在第三个专用 PowerShell 中运行探针：
$threadId = "<owned-active-thread-id>"
$daemonVersion = "codex-tui 0.149.1"
$run = Join-Path $env:TEMP ("codex-phase-six-" + [guid]::NewGuid().ToString("N"))
node tools/observe-probe.mjs --endpoint $endpoint --out $run --thread-id $threadId `
  --schema-version v2 --daemon-version $daemonVersion --duration-ms 60000
Get-Content (Join-Path $run "probe-summary.json")
```

`InitializeResponse` 不提供 `schemaVersion`，所以 `--schema-version v2` 是操作员对已
审核 schema 的明确标注；`daemonVersion` 应填 daemon version JSON 中与 Initialize
`userAgent` 对应的精确标签。若标签不在探针的 tested daemon 集合中，结果会保留捕获但
将 `captureSuggested` 标为 `true`，不能把它当作已验证指标运行。

Windows 当前不支持 `app-server daemon` 生命周期子命令；本阶段实机使用人工确认拥有的
loopback 前台服务：`codex app-server --listen ws://127.0.0.1:<owned-port>`。当前 CLI 的
Initialize 返回值为复合 `userAgent`，探针只提取稳定的 `codex-tui 0.149.1` 版本标签，
不把客户端名、系统版本或架构写入 daemon 版本判定。由于 `thread/resume` 的
`excludeTurns` 字段要求实验 API capability，探针 initialize 只声明最小的
`capabilities.experimentalApi=true`，不因此获得 observer/read-only 语义，也不改变发送白名单。

人工按顺序执行：普通纯文本轮、工具调用轮、一个受控审批轮；确认 TUI 输入和渲染正常，
并检查 summary 中 `serverRequests` 为空、`resume.excludeTurns` 为 `true`、thread ID
不变、没有额外 turn/fork/replay。若观察者收到审批、用户输入、工具调用或认证刷新请求，
探针必须立即退出；随后记录 TUI 是否继续可用，这种情形判 E1 失败。

## 本次真实 E1 记录（2026-09-01，失败）

实验使用人工确认拥有的 `ws://127.0.0.1:48765` 前台 app-server、显式
`--sandbox read-only --ask-for-approval on-request` 的 TUI，以及
`codex-tui 0.149.1`。普通纯文本轮和工具调用轮已被独立探针运行捕获；这些前置捕获
没有审批请求，不能单独构成 E1 通过。

受控审批轮使用了只写入临时目录的无害命令。探针运行目录 basename 为：
`codex-phase-six-real-e1-approval-only-f85bef629b624046a11f2bff4d7cfe3e`（实际位置为
当前用户的 `$env:TEMP`，不在仓库中）。
探针终端结果为 `exitCode=1`、`e1Status=fail`；summary 的关键记录为：

```json
{
  "serverRequest": {
    "method": "item/commandExecution/requestApproval",
    "kind": "approval",
    "requestIdPresent": true,
    "decision": "fail_closed_no_response"
  },
  "connection": {
    "windowInvalidationReason": "e1_failure",
    "reconnected": false
  }
}
```

探针没有回答 server request，也没有把命令参数写入产物；用户在真实 TUI 权限卡片上
选择了 `No ... (Esc)`，随后确认卡片消失且 approval marker 文件不存在。因此该结果是
真实的 E1 失败证据，不是权限卡片缺失或模拟通过。协议定性为 App Server 没有被动
订阅者角色，审批请求会扇出给订阅客户端；不将其描述为 `thread/resume` 接管控制。
按照 rev4.2 的判定边界，本阶段不再启动 E2；`e2.status` 保持 `pending`，没有真实
E2 数值或性能结论。

断连/重连场景使用独立新目录：

```powershell
$run = Join-Path $env:TEMP ("codex-phase-six-reconnect-" + [guid]::NewGuid().ToString("N"))
node tools/observe-probe.mjs --endpoint $endpoint --out $run --thread-id $threadId `
  --schema-version v2 --daemon-version $daemonVersion `
  --disconnect-after-ms 5000 --reconnect-attempts 1 --duration-ms 30000
```

人工核对断连时 open turn 为 `unavailable`，没有 LIVE/TTFT/会话吞吐，重连后不恢复该窗口，
并确认 TUI 正在运行的 turn 未异常。

## 真实 E2 复现步骤（pending）

在同一次受控运行中保存同步 Stop 的脱敏记录及其对应 transcript，使用记录内
`capturedAt` 作为参考 `nowMs`；逐字段比较 `outputTokens`、`reasoningTokens`、请求时长、
估算请求计数、token 事件/重复事件和工具调用计数。TTFT 不参加同步比较，待同轮异步回填后
再比较回填记录；缺失回填保持 `unavailable`。

跨运行只比较 threadId 不变、无额外 turn、无 fork、无 replay、TUI 正常和 unsubscribe
干净等确定性协议不变量。observer 开启/关闭要随机交错采样；5 轮只能冒烟，15–20 轮以上
才可报告中位数、IQR 和效应量的性能观察，不能宣称数学意义上的“零扰动”。

## 安全与降级边界

- 未测试 `schemaVersion` 为 capture-only；InitializeResponse 没有该字段，必须保留
  操作员 schema 标签来源；未知 daemon 额外设置 `captureSuggested=true`。
- `currentTime/read` 不预设豁免，收到后记录并 fail-closed。
- `cleanupTimeoutMs` 只回收内存，不推断 turn 完成。
- `interrupted`/`failed`/无终态窗口不进入完成轮或会话速率聚合；partialUsage 只能用于
  token 消耗诊断。
- 用户主动 abort/信号可正常收尾；`uncaughtException`/`unhandledRejection` 会记录脱敏
  错误并以 exit code 1 结束，不会被当作成功。
- initialize 只宣告 `capabilities.experimentalApi=true`（当前服务端对
  `thread/resume.excludeTurns` 的必要协商项），不宣告其他 capability；这不赋予 observer
  角色或控制权限。退订使用短超时且不改变观测结论。
- 输出目录独立于 `PLUGIN_DATA`/`TPS_PLUS_DATA_DIR/status`，summary 使用临时文件加原子
  rename；异常日志只写固定字段白名单。
