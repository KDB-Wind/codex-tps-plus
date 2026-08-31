# Codex TPS Plus：第三阶段请求内吞吐实现

更新时间：2026-08-31

## 结果

v0.3.2 在保留端到端整轮吞吐的同时，显示每轮“请求内吞吐”与会话加权值：

```text
⚡ 请求内吞吐 41.6 tok/s（含首字） · 会话请求内 39.8 tok/s · 整轮 33.3 tok/s · 输出 5.2k tok · 轮耗时 2m36s
```

该值不是把旧的整轮吞吐改名。解析器会重建当前 turn 内的模型请求区间：

1. 第一段以 `task_started` 为起点；后续段以上一条去重后的 `token_count` 为起点。
2. 终点取该请求最后一个持久化的模型活动项，包括 reasoning、assistant message 或
   tool call；tool output 不算模型活动。
3. `token_count.last_token_usage.output_tokens` 只按累计 output 推进去重，
   `reasoning_output_tokens` 不重复相加。
4. 轮级与会话级都使用 `Σ output_tokens / Σ 请求区间秒数`，不做各请求速率的算术平均。

该口径排除了请求之间的本地工具执行和等待，因而比整轮吞吐更接近模型请求阶段；但
请求区间仍包含 TTFT，不能代表纯解码速度。v0.3 最初把它显示成“近似 TPS”，容易让人
误读为生成 TPS；v0.3.1 将名称修正为“请求内吞吐（含首字）”。平均每个请求少于
128 个输出 token 时追加“短回复参考”，只用于提示 TTFT 占比可能较高。只要本轮存在
无法估算的带输出请求，插件就不展示部分样本的请求内吞吐，而是安全降级到整轮吞吐。

## 真实 transcript 回放

在本机 0.149.1 的四个已完成 turn 上回放，所有有效 token 请求均得到区间：

| 模型请求数 | 输出 token | 整轮吞吐 | 请求内吞吐（含首字） | 未估算请求 |
|---:|---:|---:|---:|---:|
| 13 | 5,196 | 33.3 | 41.6 | 0 |
| 7 | 3,397 | 30.3 | 40.6 | 0 |
| 2 | 372 | 20.6 | 24.7 | 0 |
| 29 | 21,927 | 31.9 | 39.7 | 0 |

这些结果只用于验证算法确实排除了非模型区间，不用于声称 transcript 估算等同于
服务端纯生成 TPS。

安装 v0.3 后又在独立的 Codex CLI 0.149.1 TUI 会话中完成无工具调用实测，Stop hook
实际显示：

```text
⚡ 近似 TPS 12.9 · 会话近似 12.9 · 整轮 11.9 tok/s · 输出 113 tok · 轮耗时 9.5s
```

这是 v0.3 的历史显示。该会话实际使用 `gpt-5.6-luna max fast`，且平均每请求只有
56.5 个输出 token；它不能用于判断 GPT-5.6 Sol 的纯生成 TPS。随后用明确指定的
`gpt-5.6-sol low fast`、无工具、407 输出 token 做受控基线，旧算法得到请求内吞吐
32.6 tok/s、整轮吞吐 31.2 tok/s、轮耗时 13.1s。两次测量都包含 TTFT。

## 原生 OTel TBT/TTFT 结论

v0.3 将原先的 ASCII 字符串搜索替换为依赖为零的 OTLP protobuf 结构解析。对第一
阶段的真实捕获重新分析得到：

- `codex.responses_api_engine_service_tbt.duration_ms`：13.124 ms，倒数换算约 76.2 TPS；
- `codex.responses_api_engine_service_ttft.duration_ms`：277 ms；
- metrics temporality：delta，两个 timing data point 的 count 都为 1；
- metric resource/data point 没有 conversation、request 或 turn ID；
- `conversation.id` 只出现在 log record，不能与 timing data point 直接关联。

因此 `1000 / service TBT_ms` 是更接近 Codex 原生 engine timing 的近似 TPS 候选，但
当前不能稳定注入 Stop 行：metrics exporter 异步批量发送，且数据点没有本轮关联键。
插件不会把旧批次或其他会话的 TBT 冒充当前轮数值。

## 安全与测试

- 状态 schema 升至 v3，同时兼容读取 v1/v2；只有记录具备完整请求区间时才显示
  请求内吞吐。
- 持久化仍只有哈希 ID 与数字，不含 prompt、assistant 正文、工具参数或路径。
- OTLP 报告只输出允许列出的指标名、属性名和数值统计，不输出任意属性值；原始
  `.bin` 仍按敏感数据处理。
- 回归测试覆盖工具耗时排除、请求/会话加权、短回复提示边界、token 去重、严格 hook JSON、结构化
  protobuf 解码、伪 ASCII request ID 不得造成误关联，以及日志/指标无共同请求键。
- 发布配置只注册 Stop Hook；第一阶段的其他生命周期探针保留为开发工具，不再给正常
  工具调用增加 PreToolUse/PostToolUse 进程。

参考：[Codex 高级配置与 OTel 指标](https://learn.chatgpt.com/docs/config-file/config-advanced)、
[Codex 配置参考](https://learn.chatgpt.com/docs/config-file/config-reference)。
