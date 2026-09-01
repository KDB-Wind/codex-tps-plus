# phase-six probe 实施与实验状态

## 结论

本阶段只交付 phase-six probe 和自动化验证，不占用产品 semver。产品与插件版本仍为
`0.5.0`，`v0.5.0` 标签不变；没有 sidecar/LIVE 状态栏、Stop Hook 改动或 alpha tag。

真实 E1/E2 TUI 实验在本次会话中保持 `pending`。当前会话不能安全地启动、接管或断开
其他正在运行的 Codex 会话，因此下面的协议测试是自动化证据，不是 E1/E2 实机通过。

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

本次自动化命令结果：`npm test` 81/81 通过；phase-six 专项测试 29/29 通过；
`npm run release:check` 通过且版本仍为 `0.5.0`；`npm run doctor -- --json` 通过（Node、
Codex CLI、已安装插件、manifest、Hook、凭据覆盖保护和 OTel 配置检查均为 OK）。

## 真实 E1 复现命令与人工步骤（pending）

以下命令必须只对人工确认拥有控制权的 daemon/thread 执行，不要填入其他 Codex 会话的
endpoint 或 thread：

```powershell
codex app-server daemon start
codex app-server daemon version --json

$endpoint = "ws://127.0.0.1:<owned-port>"
$threadId = "<owned-active-thread-id>"
$daemonVersion = "<exact daemon label from codex app-server daemon version --json>"
$run = Join-Path $env:TEMP ("codex-phase-six-" + [guid]::NewGuid().ToString("N"))
codex --remote $endpoint
node tools/observe-probe.mjs --endpoint $endpoint --out $run --thread-id $threadId `
  --schema-version v2 --daemon-version $daemonVersion --duration-ms 60000
Get-Content (Join-Path $run "probe-summary.json")
```

`InitializeResponse` 不提供 `schemaVersion`，所以 `--schema-version v2` 是操作员对已
审核 schema 的明确标注；`daemonVersion` 应填 daemon version JSON 中与 Initialize
`userAgent` 对应的精确标签。若标签不在探针的 tested daemon 集合中，结果会保留捕获但
将 `captureSuggested` 标为 `true`，不能把它当作已验证指标运行。

人工按顺序执行：普通纯文本轮、工具调用轮、一个受控审批轮；确认 TUI 输入和渲染正常，
并检查 summary 中 `serverRequests` 为空、`resume.excludeTurns` 为 `true`、thread ID
不变、没有额外 turn/fork/replay。若观察者收到审批、用户输入、工具调用或认证刷新请求，
探针必须立即退出；随后记录 TUI 是否被阻塞或接管，这种情形判 E1 失败。

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
- initialize 不宣告 `experimentalApi` 或非必要 capability；退订使用短超时且不改变
  观测结论。
- 输出目录独立于 `PLUGIN_DATA`/`TPS_PLUS_DATA_DIR/status`，summary 使用临时文件加原子
  rename；异常日志只写固定字段白名单。
