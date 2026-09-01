# Codex TPS Plus：第五阶段 OTel 捕获与归属边界

v0.5.0 将原有开发用 OTLP HTTP sink 正式化为 `node scripts/otel.mjs serve`，但它仍是显式
opt-in 的高级实验能力。生产 Stop Hook 不启动接收器、不修改用户配置，也不默认读取或
保存 OTLP body。

## 实现边界

- receiver 只监听 `127.0.0.1`，每个捕获目录有独占锁和随机 receiver identity；
- 默认每个 body 上限 64 MiB，最多 1000 个 payload、合计 512 MiB；
- `.bin` 是潜在敏感原始数据，结构化报告只保留允许列出的字段名、数字和计数；
- TBT/TTFT histogram 保存窗口起止、count、sum、min、max 和 temporality；
- doctor 分别检查 receiver 存活、logs/metrics exporter 匹配和多 conversation 污染；
- TTFT 状态记录区分 `task_complete_async`、`task_complete_direct` 与
  `task_complete_sync_recovery`；
- 没有经过验证的 request/turn join ID 时，任何 OTel 值都保持
  `currentTurnAttributed: false`、`exactPerRequestTps: false`。

证据等级只有两档可显示值：

1. `capture-aggregate`：捕获中存在 service TBT，但无法证明只有一个完成 turn；
2. `isolated-window-candidate`：一个 receiver identity、一个 conversation、一个完成 turn。

第二档仍只是隔离窗口候选，不是当前活动 Stop 的归属证明。未来只有指标本身携带并验证
request/turn ID，才可能升级为 `request-correlated`。

## Windows / Codex CLI 0.149.1 实验

所有实验使用 GPT-5.6 Sol、`otel.log_user_prompt=false`、全新捕获目录和 localhost receiver。
原始捕获位于被 `.gitignore` 排除的目录，不进入版本库。

| 场景 | 观察 | 结论 |
|---|---|---|
| 5-token 单请求 | service TBT 107.77 ms（≈9.3 tok/s）；iapi TBT 14.0 ms；turn TTFT 6061 ms | 极短输出的 TBT 倒数高度失真，不能挑选更好看的 scope |
| 603-token 单请求 | service TBT 17.95 ms（≈55.7 tok/s）；iapi TBT 7.11 ms；turn TTFT 5512 ms | 足够长输出时 service TBT 与常见约 55 tok/s 体感一致 |
| 单 turn、4 个模型请求 | 一个 service histogram 点，`count=4`、mean 18.64 ms、min/max 18.54/18.77 ms | histogram 合并请求；倒数是请求均值近似，不是 token 加权 TPS |
| 两个并发 Codex | 2 个 conversation、2 个 service 点；receiver identity 仍只有 1 个 | receiver 独占不等于会话隔离，doctor 必须分开检查 |
| 子代理尝试 | `codex exec` 报 spawn 失败，但捕获仍出现 2 个 conversation、5 个 observation | 子代理链路必须按污染降级，不能候选归轮 |
| 长输出 flush | 运行中已有 6 个 logs payload、0 metrics；进程结束附近才出现唯一 metrics payload | metrics 不是可供 Stop 实时 time-join 的逐请求流 |

## 时间和传输结论

histogram datapoint 的 `startTime/time` 是 delta 聚合窗口边界。它可以描述一个捕获窗口，
但不是逐 token 观测时间，也不能代替 request ID。实际日志中同一次运行同时出现
`codex.sse_event` 与 `codex.websocket_request` 命名信号；同时 `responses_websockets` 和
`responses_websockets_v2` 在 0.149.1 中均标记为 removed。因此报告只输出
`transportSignals`，不声称当前流一定是 SSE 或 WebSocket，也不存在可信的强制 A/B 实验。

## 显示决策

`$tps` 只有在用户提供 `TPS_PLUS_OTEL_CAPTURE_DIR` 或 `--otel-capture` 时才扫描原始捕获。
完整隔离条件成立时显示：

```text
原生生成 TPS ≈55.7（TBT 推算·单轮候选·未归轮）
```

否则显示“捕获参考·未归轮”。短输出增加“短输出”提示。自动 Stop Hook 不扫描 `.bin`，
所以不会因为启用 OTel 而扩大每轮同步 Hook 的 I/O 或隐私面。
