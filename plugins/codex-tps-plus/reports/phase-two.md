# Codex TPS Plus：第二阶段实现说明

更新时间：2026-08-30

## 已交付

- Stop 时只读取 transcript 尾部，定位当前 `task_started` 和属于当前 turn 的
  `token_count.last_token_usage`。
- `output_tokens` 按累计 `total_token_usage.output_tokens` 去重后，每个真实推进只计
  一次；这会排除速率限制更新重复广播的旧 `last_token_usage`。
  `reasoning_output_tokens` 不重复相加。
- 当前轮吞吐使用 Stop 墙钟时间，公式为
  `Σ output_tokens / (Stop 时间 - task_started 时间)`。
- 会话吞吐使用 `Σ output_tokens / Σ duration` 加权计算，不使用各轮速率的算术平均。
- Stop 通过严格 JSON `systemMessage` 自动显示指标；失败时安静降级为 `{}`。
- 状态只包含哈希后的 session/turn ID 和数字，按会话限制为 200 文件、2 MiB。
- `$tps` 读取当前 `CODEX_THREAD_ID`/`CODEX_SESSION_ID` 对应状态。

## 性能与降级

解析器从 256 KiB 尾部开始，找不到当前 `task_started` 时逐步扩大，最大读取
16 MiB；不会在正常模式下读取整个超大 transcript。如果当前 turn 本身超过上限、
transcript 损坏、缺少 token 或无法写入 `PLUGIN_DATA`，Stop 返回空 JSON，不影响
Codex 继续结束当前轮。

## 为什么仍不标成 TPS

Codex 一轮可以在工具调用前后发出多个模型请求。当前稳定 Hook 边界没有给每次
请求同时提供请求 ID、生成开始/首 token/完成时间和 token usage。官方 OTel 的
engine TBT 指标是候选信号，但已捕获样本没有可证明的逐请求关联键。

因此 v0.2 显示的是端到端“整轮吞吐”和“会话吞吐”，不是纯模型生成 TPS。未来只有
在请求级边界可验证后，才会增加 `最近 TPS / 上轮均 / 会话均`。
