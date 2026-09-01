# codex-tps-plus

[![test](https://github.com/KDB-Wind/codex-tps-plus/actions/workflows/test.yml/badge.svg)](https://github.com/KDB-Wind/codex-tps-plus/actions/workflows/test.yml)

为 Codex CLI 在每轮回复结束后显示“请求区间吞吐”“整轮吞吐”，并延迟回填 TTFT 的
本地插件。v0.5.0 另提供显式启用的 localhost OTel 实验，可读取 Codex 原生 TBT 并给出
严格标注、未归轮的生成速度参考。

```text
⚡ 请求内吞吐 41.6 tok/s（含首字） · 会话请求内 39.8 tok/s · 整轮 33.3 tok/s · 输出 5.2k tok · 轮耗时 2m36s · 上轮 TTFT 6.8s
```

> [!IMPORTANT]
> 这里的“请求内吞吐”不是模型纯生成 TPS。它包含首字等待（TTFT）以及第一段可能存在的
> 客户端准备、排队等时间。插件没有拿到可与当前请求稳定关联的纯解码时长，因此不会把
> 这个数值标成 TPS。

## 它显示什么

| 字段 | 计算口径 | 适合回答的问题 |
|---|---|---|
| 请求内吞吐 | `Σ output_tokens / Σ 可完整推断的请求区间秒数` | 排除请求之间工具执行后，这轮模型请求阶段的总体吞吐如何？ |
| 会话请求内 | 当前会话中完整覆盖轮次的 `Σ output_tokens / Σ 请求区间秒数` | 本会话可测请求区间的加权平均是多少？ |
| 整轮 | 本轮 `output_tokens / (Stop - task_started)` | 从开始处理到回复结束，包含工具和等待的端到端吞吐是多少？ |
| 输出 | 本轮去重后的 `output_tokens` | 本轮共产生多少输出 token？ |
| 轮耗时 | 从 `task_started` 到 Stop Hook 的墙钟时间 | 用户实际等待了多久？ |
| TTFT | Stop 后落盘的 `task_complete.time_to_first_token_ms` | 上一轮从开始到首 token 等了多久？ |

所有平均值都是 token 与时长的加权结果，不是逐请求或逐轮速率的算术平均。
`reasoning_output_tokens` 已包含在 `output_tokens` 中，不会重复相加。
TTFT 是例外：会话 TTFT 是有成功回填值轮次的算术平均；缺失值不会按零参与。

如果平均每个推断请求少于 128 个输出 token，显示会增加：

```text
（含首字·短回复参考）
```

短回复中 TTFT 占比通常很高，数值可能看起来很低。128 只是提示阈值，不会修改计算结果。

## 工作机制

插件只注册一个 `Stop` 事件，其中有两个命令处理器：同步显示和后台 TTFT 回填。

1. Codex 完成一轮回复并触发 Stop；同步处理器与官方 `async: true` 后台处理器并发启动。
2. 同步处理器在当前 `PLUGIN_ROOT` 可用时，把生产 Hook 所需代码按内容哈希保存到不含
   版本号的 `PLUGIN_DATA/runtime`，最多保留 5 份代码快照。指针和调度器采用临时文件
   替换；快照失败不会影响本轮指标。
3. 同步处理器从 transcript 尾部读取 256 KiB；找不到当前 `task_started` 时逐步扩大，最多读取
   16 MiB，不会在正常模式下复制或保存整份会话正文。
4. 解析当前 turn 的 `task_started`、模型输出项和 `token_count.last_token_usage`。
5. 使用累计 `total_token_usage.output_tokens` 去除 Codex 重复广播的 token 快照。
6. 第一段从 `task_started` 开始；后续段从上一条有效 `token_count` 开始，到本次请求最后
   一个模型输出项结束。工具输出不算模型活动，因此请求之间的本地工具时间被排除。
7. 只有本轮所有带输出的请求区间都能推断时，才显示“请求内吞吐”；只要有一个区间缺失，
   就安全降级为“整轮吞吐”。
8. 同步处理器还会检查当前 turn 之前最近一条完整的 `task_complete`；如果异步处理器未曾
   回填，就为上一轮补写 TTFT。这让旧会话或偶发异步失败能在下一轮自动恢复。
9. 同步处理器将哈希 ID 和数字状态原子写入 `PLUGIN_DATA`，再通过严格 JSON `systemMessage`
   把指标显示为 Codex UI 事件。
10. 后台处理器最多等待 10 秒；当前 turn 的 `task_complete` 落盘后，只回填 TTFT、完成时长、
   哈希 turn ID 和时间来源。它输出空 JSON，不启动新 turn，也不给模型增加上下文。

Hook 命令会先运行会话启动时的版本目录；如果插件升级已经清理该目录，则自动调用
`PLUGIN_DATA/runtime/dispatch.mjs` 中最近一次成功保存的快照。两处都不可用或系统找不到
Node 时只返回 `{}`，不会用退出码 1 干扰旧会话。

由于当前轮 TTFT 在同步 Stop 之后才出现，第一轮状态行不会包含自己的 TTFT。后台回填完成
后，`$tps` 可以查询它；下一轮自动状态行会将最近已回填值标成“上轮 TTFT”。即使后台
处理器没有运行，下一次同步 Stop 也会补偿回填上一轮。

这条链路依赖 Codex transcript 的事件顺序，而 transcript 不是承诺稳定的公开数据格式。
格式变化、超长 turn、缺少 token 或状态目录不可写时，插件返回空 JSON，不伪造数值。

## 要求与支持范围

- Codex CLI 或支持本地 Codex 插件 Hook 的 ChatGPT Desktop/Codex 界面。
- Node.js `>= 22.5.0`，且 `node` 可从 Hook 进程的 `PATH` 找到。
- 插件必须来自已配置的 Codex marketplace。
- 当前实现已在 Windows、Codex CLI `0.149.1` 的交互式 TUI 实测；Hook 同时提供 POSIX
  命令格式，但 macOS/Linux 仍建议在发布后补做实机回归。
- 历史实验中 `codex exec` 没有运行项目 Hook，因此当前支持承诺以交互式会话为准。

## 安装

要求 Codex CLI `0.149.1` 或更高版本。先添加这个 Git marketplace，再安装插件：

```powershell
codex plugin marketplace add KDB-Wind/codex-tps-plus --ref main
codex plugin add codex-tps-plus@kdb-wind
codex plugin list --json
```

列表中应出现：

```text
codex-tps-plus@kdb-wind
installed: true
enabled: true
```

接下来：

1. 在 Codex 中打开 `/hooks`。
2. 审核本插件的 `Stop` Hook，确认两个命令分别指向 `hooks/collector.mjs` 和
   `hooks/backfill.mjs`；后者应标记为后台运行，然后信任它们。
3. **新开一个会话**。Codex 官方插件机制要求安装或更新后从新会话加载技能和工具；安装
   插件也不会自动信任它的 Hook。

升级时执行：

```powershell
codex plugin marketplace upgrade kdb-wind
codex plugin add codex-tps-plus@kdb-wind
```

升级不会热替换已经运行中的会话。请新开会话使用新版技能和 Hook 定义；已经运行或恢复的
历史会话会继续使用最近自动保存的 Hook 快照，不需要重新配置。Codex 按 Hook 定义哈希记录
信任，只有定义本身变化时才会要求重新审核。

## 使用

正常使用不需要任何环境变量。完成一轮回复后会自动出现吞吐行；后台处理器最多等待
10 秒回填 TTFT，不会阻塞回复。

在 Codex 输入：

```text
$tps
```

查询最近一轮、延迟 TTFT 和当前会话的详细 JSON 口径；输入：

```text
$tps-doctor
```

检查 Node、Codex CLI、插件安装、Hook 配置、认证覆盖风险和可选 OTel 配置。

也可以在仓库根目录执行：

```powershell
npm test
npm run doctor -- --json
```

如果已经显式采集了本地 OTLP 数据，可以附加一个只读的、未归属到当前轮的参考：

```powershell
node plugins/codex-tps-plus/scripts/status.mjs --otel-capture <otel-capture-directory> --json
```

也可在启动 Codex 前设置 `TPS_PLUS_OTEL_CAPTURE_DIR`，让 `$tps` 读取该目录。此选项不会
启动接收器或修改 Codex 配置；原始 `.bin` 仍应视为敏感数据。

### 可选：原生 TBT 捕获实验

普通使用者不需要启用本节。它适合希望观察 Codex 原生 engine timing、并接受本地原始
OTLP 数据风险的高级用户。生产 Stop Hook 永远不会启动接收器或修改配置。

先用固定的 localhost 端口启动独占接收器：

```powershell
$capture = Join-Path $env:TEMP "codex-tps-plus-otel"
node plugins/codex-tps-plus/scripts/otel.mjs serve --output-dir $capture --port 4318
```

接收器只监听 `127.0.0.1`，同一目录只允许一个进程写入；默认单个 body 不超过 64 MiB，
最多保留 1000 个 payload、合计 512 MiB。新开一个 PowerShell，使用仅对本次 Codex 进程
生效的配置覆盖：

```powershell
$env:TPS_PLUS_OTEL_CAPTURE_DIR = Join-Path $env:TEMP "codex-tps-plus-otel"
codex `
  -c 'otel.log_user_prompt=false' `
  -c 'otel.exporter={otlp-http={endpoint="http://127.0.0.1:4318/v1/logs",protocol="binary"}}' `
  -c 'otel.metrics_exporter={otlp-http={endpoint="http://127.0.0.1:4318/v1/metrics",protocol="binary"}}'
```

完成一轮后，`$tps` 会附加类似：

```text
原生生成 TPS ≈55.7（TBT 推算·单轮候选·未归轮）
```

这里的“单轮候选”只在一个 receiver identity、一个 conversation、一个完成 turn 的新鲜
捕获中出现；否则固定降级为“捕获参考”。两者的 `currentTurnAttributed` 都是 `false`。
`service TBT` 是 histogram：多请求可能合并为一个点，`count` 才是 observation 数；其倒数
是请求均值的近似值，不保证等于按输出 token 加权的精确 TPS。少于 128 个 turn 输出 token
时还会标记“短输出”，因为实测 5-token 回复的倒数从长回复约 55.7 降到约 9.3。

诊断显式捕获时可以运行：

```powershell
node plugins/codex-tps-plus/scripts/doctor.mjs --otel-capture $env:TPS_PLUS_OTEL_CAPTURE_DIR --json
node plugins/codex-tps-plus/scripts/otel.mjs scan $env:TPS_PLUS_OTEL_CAPTURE_DIR
```

doctor 会分别检查 receiver 是否仍存活、logs/metrics exporter 是否指向它，以及捕获中是否
出现多个 conversation。若配置只通过本次 `codex -c` 覆盖，独立 doctor 进程无法看到这些
覆盖；可用 `--config <toml>` 指向等价的检查配置。结束实验后停止 receiver，并删除准确的
临时捕获目录。

## 输出示例与解读

完整请求覆盖：

```text
⚡ 请求内吞吐 23.0 tok/s（含首字） · 会话请求内 23.0 tok/s · 整轮 21.9 tok/s · 输出 264 tok · 轮耗时 12.0s · 上轮 TTFT 3.9s
```

区间不完整时降级：

```text
⚡ 整轮吞吐 40.0 tok/s · 会话吞吐 35.2 tok/s · 输出 200 tok · 耗时 5.0s
```

请求内吞吐通常高于整轮吞吐，因为它排除了请求之间的工具执行；无工具的短轮次中二者
可能很接近。不同提示、推理强度、缓存、网络、服务负载和回复长度都会改变结果，不能用
单个短回复比较模型档位。

如果当前最新状态已经由后台补全，`$tps` 会把同一个值标成 `TTFT`，而不是“上轮 TTFT”。
若后台超时、会话立即关闭或 transcript 格式变化，TTFT 会保持缺失，不会显示为零。

## 数据与隐私

正常运行时只持久化：

- 截断 SHA-256 后的 session/turn ID；
- output/reasoning token 数字；
- 整轮与推断请求区间时长；
- 延迟回填的 TTFT 与 `task_complete` 完成时长；
- 请求、token 快照和工具调用计数；
- 捕获时间和 schema 版本。

此外，`PLUGIN_DATA/runtime` 最多保存 5 份插件自身的生产 Hook 代码快照，用来在升级清理
旧版本缓存后继续服务历史会话。快照不包含 transcript、prompt、回复、工具参数或原始 ID。

不会持久化 prompt、assistant 正文、工具参数、命令、工作目录、transcript 路径或原始
session/turn ID。每个会话最多保留 200 个状态文件，合计最多 2 MiB；只清理符合插件
状态命名格式的文件。

生产配置只有 Stop 事件，不会在每次工具调用前后额外启动 Node 进程。每轮启动一个同步
显示进程和一个最多等待 10 秒的后台回填进程。Node 不存在、版本目录已删除、稳定快照缺失
和内部解析错误都会安静降级；宿主 shell 无法启动或进程被外部强制终止等宿主级故障仍可能
被 Codex 报告为 Hook 失败。

## 常见问题

### 没有显示指标

依次检查：

1. `codex plugin list --json` 中插件是否 installed/enabled；
2. `/hooks` 中当前 Hook 定义是否已信任；
3. 安装或升级后是否新开了会话；
4. `node --version` 是否满足要求；
5. `$tps-doctor` 是否全部通过。

无输出 token、找不到当前 turn、turn 超过 16 MiB 尾部上限或 transcript 暂时不可读时，
插件也会有意不显示指标。

### 升级后旧会话出现 `hook exited with code 1`

活动会话会保留启动时的版本化 `PLUGIN_ROOT`。从本公开版开始，正常完成一次 Stop 会自动
保存稳定运行时；后续升级即使清理旧缓存，历史会话也会转到该快照，最差返回空 JSON，
不应再出现退出码 1。仍建议升级后新开会话，以加载新版技能和 Hook 定义。

早于这一兼容机制创建的内部开发会话无法被旧 Hook 命令追溯改写；它们需要一次性恢复旧
路径或结束会话。这不影响首次安装本公开版的用户。

### 为什么 `$tps` 一直没有 TTFT

正常情况下，后台 Stop 处理器会在 `task_complete` 落盘后回填当前轮。若历史会话没有加载
这个异步处理器，下一轮同步 Stop 会自动从 transcript 补偿回填上一轮，不需要重新配置。
第一轮仍可能没有 TTFT，因为当轮的完成事件必然晚于同步 Stop。

### 为什么数值比其他 TPS 工具低

本插件的请求区间包含 TTFT，整轮还包含工具和等待；其他工具可能使用首 token 到末 token
的纯解码时间。口径不同，数值不能直接比较。

### 为什么第一轮没有 TTFT

Codex 在同步 Stop 完成后才把 `task_complete.time_to_first_token_ms` 写入 transcript。插件
不会用估算值替代它；后台回填后可用 `$tps` 查询，下一轮自动行会显示“上轮 TTFT”。

### 为什么 OTel 参考仍不叫本轮 TPS

OTel service TBT 是真实的 Codex engine timing，但当前验证样本没有可稳定关联到 Stop 的
request/turn ID。多请求被合并进 histogram，指标又在进程结束附近批量 flush；窗口时间是
聚合边界，不是逐 token 到达时刻。插件只把显式捕获的倒数换算值标成“捕获参考”或
“单轮候选”，并始终带“未归轮”。

## 开发与验证

```powershell
npm test
npm run release:check
cd plugins/codex-tps-plus
node scripts/doctor.mjs --json
node scripts/analyze-transcript.mjs <transcript.jsonl>
node scripts/otel.mjs config
node scripts/otel.mjs serve --output-dir <capture-directory> --port 4318
node scripts/otel.mjs scan <otel-capture-directory>
node scripts/otel-inspect.mjs <otel-capture-directory>
node scripts/status.mjs --otel-capture <otel-capture-directory> --json
```

仓库根目录是 marketplace，插件本体位于 `plugins/codex-tps-plus`。GitHub Actions 在
Windows、macOS、Linux 上分别使用 Node.js 22 和 24 运行测试与发布检查。

仓库保留第一阶段的脱敏 transcript 探针，并将 localhost OTLP 接收器作为显式实验子命令。
它们不属于生产 Hook 注册项，也不会自动启用。

OTLP 原始 `.bin` 可能包含 prompt、工具或其他敏感属性。接收器只监听 `127.0.0.1`，但
这不等于内容已脱敏；实验结束后应删除准确的捕获目录，绝不能提交 `artifacts/otel/`。
结构化检查器只输出允许列出的结构、名称和数字，它不能证明原始 body 安全。

已验证样本中的原生 OTel TBT/TTFT 为异步批量 histogram，且没有可与当前 Stop 稳定关联的
request/turn ID，因此运行时不会把 `1000 / TBT_ms` 冒充当前轮 TPS。日志中同时出现 SSE
和 WebSocket 命名信号，而 0.149.1 的相关切换 feature 已移除，插件不会据此伪造传输类型。

详细证据见 [第一阶段验证报告](plugins/codex-tps-plus/reports/validation.md)、
[第二阶段实现说明](plugins/codex-tps-plus/reports/phase-two.md)、
[第三阶段请求区间吞吐说明](plugins/codex-tps-plus/reports/phase-three.md) 和
[第四阶段延迟 TTFT 说明](plugins/codex-tps-plus/reports/phase-four.md) 和
[第五阶段 OTel 实验报告](plugins/codex-tps-plus/reports/phase-five.md)。

## 官方参考

- [Codex Hooks](https://learn.chatgpt.com/docs/hooks)
- [Codex plugins](https://developers.openai.com/codex/plugins)
- [Codex 高级配置与 OTel](https://learn.chatgpt.com/docs/config-file/config-advanced)

## License

[MIT](LICENSE)
