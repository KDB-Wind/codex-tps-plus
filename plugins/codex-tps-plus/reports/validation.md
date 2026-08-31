# Codex TPS Plus：第一阶段数据可行性验证

> 历史说明：本文记录 v0.1.1 的第一阶段结论。v0.2 已在不误标 TPS 的前提下实现
> 端到端整轮吞吐与会话加权吞吐；见 [第二阶段实现说明](phase-two.md)。
> v0.3 已用结构化 OTLP protobuf 解码替换 ASCII 启发式，并增加包含 TTFT 的请求区间
> 吞吐；见 [第三阶段实现说明](phase-three.md)。下文“当前检查”均指当时的 v0.1.1。

更新时间：2026-08-30

## 结论

第一阶段已完成。针对 Codex CLI 0.149.1 的实机验证得到以下结论：

- 交互式 TUI 会执行插件生命周期 hook；已观察到 `SessionStart`、`UserPromptSubmit`、`PreToolUse`、`PostToolUse`、`Stop` 和 `SessionEnd`。
- 在已测试的 paginated transcript 中，`Stop` 执行时本轮的 `token_count` 已可见，但 `task_complete` 尚未可见；最终 transcript 在 Stop 之后才出现 `task_complete`。
- 一轮可以出现多个 `token_count` 快照；本次工具调用实验观察到两个快照，但目前还不能把它们普遍当作“每个模型请求一一对应”的稳定边界。
- OTel 的 HTTP metrics 导出可用，并能看到候选 engine TBT/TTFT 与 token usage 指标；本次捕获只有会话级 `conversation.id`，没有可证明的请求/turn 关联 key。因此尚未确认逐请求纯生成时长，也没有实现或显示 TPS。
- `codex exec` 的非交互路径在本次 0.149.1 实验中没有执行测试项目的生命周期 hook；本报告的 hook 时序结论限定于交互式 TUI。
- 第一阶段观察器现为显式 opt-in：未设置 `TPS_PROBE_DIR` 时不读取 transcript、不落盘；OTLP 原始 `.bin` 不属于脱敏观察数据。

因此仓库停留在“数据观察器 + 验证报告”阶段，不实现下一轮注入、`stop-notice`、原生状态栏或完整 TPS 计算。

## 范围与环境

本阶段只验证 Codex 生命周期、transcript 可见性、事件时序、脱敏和 OpenTelemetry 信号，不改变全局 Codex 配置，也不占用已有 `notify` 配置。

- Codex CLI：`0.149.1`
- 平台：Windows
- Node.js：`v24.14.0`
- 目标仓库：本仓库的本地开发克隆。
- 参考实现：只读检查了本地 Zcode TPS 插件的 README、Hook 配置、token-rate 算法和测试，未修改参考仓库。

实机 hook 回归使用一次性 probe 目录。为验证 hook 本身，受控运行使用了 `--dangerously-bypass-hook-trust`；这不等同于替用户在 Codex `/hooks` 中完成持久化审核/信任。正常安装后仍需在 `/hooks` 中审核，且 hook 内容变化后应重新确认。

## 官方接口边界

- [Hooks 文档](https://learn.chatgpt.com/docs/hooks)定义了 `UserPromptSubmit`、`Stop` 等生命周期事件及 hook 输出约束；`transcript_path` 可供 hook 读取，但 transcript 格式不是稳定接口。
- [插件构建文档](https://learn.chatgpt.com/docs/build-plugins)说明了插件目录、默认 `hooks/hooks.json` 和技能目录的发现方式。
- [高级配置与 OTel 指标](https://learn.chatgpt.com/docs/config-file/config-advanced)列出了 engine TBT/TTFT、turn TTFT 和 token usage 等候选信号。
- [配置参考](https://learn.chatgpt.com/docs/config-file/config-reference)中的 `tui.status_line` 目前只提供内置项目标识符，未验证到插件自定义动态状态项接口。

实现按这些边界工作：未知 transcript 事件保留为未知，局部坏行只影响对应解析结果；hook stdout 始终输出合法 JSON；观察器异常不阻断当前 turn。

## 已实现的验证器

- `hooks/collector.mjs`：仅在显式设置 `TPS_PROBE_DIR` 后写原子 JSON 观察文件；不落盘 prompt、assistant 正文、命令、完整路径、完整 session/turn ID。
- `scripts/probe-core.mjs`：解析并摘要 `session_meta`、`task_started`、`token_count`、`task_complete`、turn 上下文和压缩/中断信号。
- `scripts/analyze-transcript.mjs`：区分 legacy/paginated，报告解析错误、事件计数和当前 turn 快照。
- `scripts/metric-model.mjs`：验证口径；`output_tokens` 只计一次，`reasoning_output_tokens` 不再次相加；只有显式纯生成时长可用时才分类为 TPS candidate。
- `scripts/otel-receiver.mjs`：仅监听 `127.0.0.1` 的本地 OTLP HTTP 接收器，保存本地 bytes 和非敏感元数据，不向外转发。
- `scripts/otel.mjs` 与 `scripts/otel-inspect.mjs`：扫描候选信号，并在未证明请求级 joinability 时明确报告“不足以计算逐请求 TPS”。
- `$tps-doctor`：检查 CLI 版本、插件结构、hook 文件、旧 bearer token 风险、OTel 配置和可用性。

## 实机结果

### Hook 执行与 Stop 时序

先用最小 sentinel hook 验证交互式 TUI 的生命周期，得到 `UserPromptSubmit` 后 `Stop` 的事件顺序。随后安装插件本身进行干净回归，插件观察文件包含：

`SessionStart → UserPromptSubmit → PreToolUse → PostToolUse → Stop → SessionEnd`

插件的 Windows bundled command 使用 PowerShell 的 `$env:PLUGIN_ROOT` 语法后能够成功运行；此前使用 `%PLUGIN_ROOT%` 时在该 Windows hook runner 中未展开。

Stop 观察结果：

- transcript 可读，格式为 `paginated`；当时 22 行、22 条记录、0 个解析错误；
- 当前 turn 有 2 个 `token_count` 事件，`task_complete` 为 0；
- 两个快照的 output token 分别为 393 和 90，reasoning token 分别为 273 和 21；简单相加分别为 483 和 294，但因请求边界与快照语义尚未证明，该和只能用于探索，不能作为轮级 token 总量；
- Stop 之后的最终 transcript 增加了 `task_complete`，该受控工具调用实验的最终 `duration_ms` 为 14178，`time_to_first_token_ms` 为 7098。

另一次不含插件注入的纯文本受控项目 hook 实验也观察到相同顺序：Stop 时有 1 个 `token_count`、0 个 `task_complete`；最终 transcript 在 Stop 后出现 `task_complete`，最终耗时为 4735 ms、首字时间为 3893 ms。插件回归因环境中已有的全局 Orca hook 产生了工具调用，故不把插件回归本身称为纯文本实验。

### 多请求与工具事件

本次插件回归至少观察到同一轮的两个 `token_count` 快照，并同时观察到 `PreToolUse`/`PostToolUse`。这证明 Stop 不能只读取一个静态 token 字段，也证明工具事件可能位于同一轮生命周期中；但 transcript 没有在本次捕获中提供足够证据，证明每个快照必然对应一个、且只对应一个模型请求。逐请求关联仍是第二阶段前的阻断条件。

解析器将没有自身 turn ID 的 `token_count` 启发式归到最近一个尚未完成的 `task_started`。该规则只用于结构观察，不是 Codex 的稳定关联契约；子代理或未来 transcript 格式可能需要不同策略。

在本次受控环境中，`codex exec` 非交互命令没有执行测试项目 hook。该结果用于限定支持范围，不推断所有未来 CLI 模式都不会执行 hook。

### OTel

OTel 捕获分两种配置验证：

- 仅日志导出：捕获 7 个 `/v1/logs` 请求；能识别 `codex.api_request`、`codex.sse_event`、`response.completed`。
- 对象形式的 metrics exporter：捕获 15 个 `/v1/logs` 和 1 个 `/v1/metrics`，内容类型为 `application/x-protobuf`；总捕获 16 个 HTTP 请求。

对最终捕获目录做安全检查后的摘要为：

```json
{
  "requestCount": 16,
  "byUrl": {"/v1/logs": 15, "/v1/metrics": 1},
  "metricPayloads": 1,
  "signals": [
    "codex.api_request",
    "codex.sse_event",
    "response.completed",
    "responses_api_engine_iapi_tbt",
    "responses_api_engine_iapi_ttft",
    "responses_api_engine_service_tbt",
    "responses_api_engine_service_ttft",
    "turn.e2e_duration_ms",
    "turn.token_usage",
    "turn.ttft.duration_ms"
  ],
  "requestKeyNames": [],
  "sessionKeyNames": ["conversation.id"],
  "perRequestJoinKeyObserved": false
}
```

因此 OTel 已证明“导出通道和候选指标存在”，尚未证明“每个模型请求的 token、纯生成时长和同一请求关联 key 可以安全拼接”。当前检查仅搜索有限的 ASCII 属性名：它不能证明关联字段在所有版本中不存在，即使未来发现某个 request/turn key，也必须继续证明该 key 与 timing/token 位于同一数据点或可稳定关联。尝试使用 0.149.1 的标量 `metrics_exporter` 写法会报 `invalid type: unit variant, expected struct variant`；对象形式可工作，已在 `scripts/otel.mjs config` 中记录为版本适配事项。

## 验证矩阵

| 场景/问题 | 当前结果 | 证据或边界 |
|---|---|---|
| 交互式 TUI hook 是否执行 | 已确认 | sentinel 与插件回归均观察到生命周期事件 |
| Stop 时 `token_count` | 已确认（paginated 实机） | Stop 当前 turn 分别观察到 1/2 个快照 |
| `task_complete` 在 Stop 前还是后 | 已确认（本次实机） | Stop 为 0，最终 transcript 在之后出现 |
| 一轮多个模型请求的区分 | 部分确认 | 观察到多个 token 快照，但未证明稳定逐请求 join |
| 纯文本 | 受控实机已确认时序 | Stop 前有 token_count，task_complete 在之后；需更多版本回归 |
| 工具调用 | 受控实机已观察 | 有 PreToolUse/PostToolUse；端到端时长不作为 TPS |
| 子代理 | 未完成实机验证 | 代码保留 `agent_id`/`agent_type` 摘要字段，需专门场景 |
| 中断/恢复/压缩 | 未完成实机验证 | 代码覆盖信号摘要，需专门场景 |
| legacy transcript | 合成 fixture 已覆盖 | `history_mode` 可识别；未宣称实机覆盖 |
| paginated transcript | 合成 + 实机已覆盖 | 实机 Stop 快照无解析错误 |
| OTel TBT/TTFT | 候选信号已看到 | 无请求/turn join key，不确认逐请求 TPS |
| 非交互 `codex exec` hook | 本次未执行 | 结论限定为该 CLI 路径的实机观察 |

## 脱敏 fixture 与本地证据

已提交一份脱敏的实机 Stop 快照：[observed-stop-paginated.json](../test/fixtures/observed-stop-paginated.json)。它只保留事件计数、token 数、时序摘要和耗时数字，不包含 prompt、正文、路径、PID 或完整标识符。

真实捕获目录位于本地 `artifacts/`，默认被 `.gitignore` 忽略；测试使用的 legacy、paginated、坏尾行和 Stop-before-complete fixture 均在 `test/fixtures/`。fixture 和测试不会依赖用户本机 transcript 才能运行。

这里的“脱敏”只适用于 hook 观察 JSON 和已提交 fixture。OTel 接收器保存的 `.bin` 是未经内容脱敏的原始 OTLP 请求体，可能包含 prompt、工具或其他敏感属性；`otel-inspect.mjs` 的允许列表摘要并不是对原始 body 的脱敏证明。OTel 捕获必须显式启用、只保存在一次性本地目录，并在实验结束后删除。

## 观察器运行边界

- 未设置 `TPS_PROBE_DIR`：collector 只返回事件所需的合法 JSON，不读取 transcript，也不写 `PLUGIN_DATA` 或默认目录。
- 设置 `TPS_PROBE_DIR`：默认最多保留 500 个探针 JSON、合计 64 MiB；只清理符合本探针命名格式的旧文件。
- `PreToolUse`、`PostToolUse` 等高频事件不再读取 transcript，并作为后台 hook 运行；后台任务完成顺序不能作为生命周期时序证据。
- `Stop` 保持同步并读取完整 transcript，以保留 Stop 时点的观测语义。对本机 173.91 MiB transcript 的修复前独立解析基准约为 1.25 秒，因此显式探针仍不应长期常开；正常禁用状态不会触发这次读取。
- 采集代码异常不会主动 steer turn，但 Node 启动失败、Codex hook 超时等进程级失败仍可能被 Codex 报告，不能笼统承诺“绝不影响 turn”。

## 推荐数据源与禁止误标

推荐顺序：

1. 首选 OTel engine service TBT/TTFT，加上同一请求的 output token；出现稳定请求/turn join key 后再计算请求级速率。
2. `token_count.last_token_usage` 用于 token 计数和边界实验，不单独提供纯生成秒数。
3. `task_complete.duration_ms` 与 `time_to_first_token_ms` 用于轮级完成/TTFT 观测；`duration_ms` 可能包含工具执行、等待和其他端到端时间。
4. 在纯生成耗时缺失时不要出现 TPS 标签；如果产品决定展示端到端指标，应另称“轮吞吐”，并明确说明它包含工具与等待时间。

计算规则仍为：

```text
请求 TPS = output_tokens / 纯生成秒数
轮级 TPS = Σ output_tokens / Σ 纯生成秒数
会话 TPS = Σ output_tokens / Σ 纯生成秒数
```

`reasoning_output_tokens` 是 output token 的子集，不能再次相加。

## 进入第二阶段的条件

在下列条件满足前，不进入完整插件实现：

- Stop 时序和版本适配边界继续稳定；
- 多请求轮次可以逐请求关联；
- 存在请求级纯生成耗时，或产品明确降级为非 TPS 指标；
- 完成子代理、中断、恢复、压缩、legacy 和 transcript 损坏/升级场景；
- 保持 Windows 路径、并发原子写入、stdout 严格 JSON 和查询延迟的测试约束。

## 复现命令

在仓库根目录执行：

```powershell
node scripts/doctor.mjs --json
npm test
node scripts/probe-report.mjs <probe-run-directory> --json
node scripts/otel.mjs scan <otel-capture-directory>
node scripts/otel-inspect.mjs <otel-capture-directory>
```

OTel 接收器只绑定本机回环地址，但原始 body 仍可能敏感。真实 hook 实验必须使用一次性 `TPS_PROBE_DIR`，并在 Codex `/hooks` 中人工审核/信任插件；实验后删除准确的 hook/OTel 捕获目录。
