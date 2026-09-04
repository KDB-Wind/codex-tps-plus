# codex-tps-plus 0.6.0 准确性修订冻结说明

状态：实现冻结；仅制作本地提交，不创建 tag、不推送、不发布远端。

## 审计结论

Codex Responses 用量中的 `reasoning_output_tokens` 是 `output_tokens` 的组成部分，因此旧版
没有发生二次相加；但它把包含隐藏 reasoning 的总 output 直接标成“输出”，并优先显示由
transcript 事件顺序推断的请求区间吞吐。该区间没有上游请求生命周期契约，不能成为最可信
的默认速率。

本机已有 127 条脱敏数字状态记录的只读复验结果：reasoning 占总 output 的 50.7%；旧请求
区间加权值为 38.2 tok/s，非推理 output 除以完整轮耗时约为 16.2 tok/s。100 条同时具备
Stop 墙钟与 `task_complete.duration_ms` 的记录中，后者比前者中位多 114 ms。完成事件的
时长应在回填后成为权威分母，而不应只保存不用。

上游源码同时确认：Responses 的 reasoning 是 output details 中的拆分项；turn completion
提供端到端 `duration_ms`，但一轮可含多个模型请求，rollout 尚无每请求完整起止时间。参见：

- https://github.com/openai/codex/blob/main/codex-rs/codex-api/src/sse/responses.rs
- https://github.com/openai/codex/issues/37460

## 冻结口径

1. `totalOutputTokens = Σ last_token_usage.output_tokens`，继续按累计 output 去重。
2. 仅当每条有效 usage 都满足 `0 <= reasoning_output_tokens <= output_tokens` 时，计算
   `nonReasoningOutputTokens = totalOutputTokens - reasoningTokens`。
3. 主指标为
   `nonReasoningOutputTokens / endToEndDurationSeconds`，名称固定为“非推理输出吞吐”；它
   包含 TTFT、工具执行、排队和客户端开销，不叫纯生成 TPS。
4. `endToEndDurationMs` 优先使用有效的 `task_complete.duration_ms`；当前同步 Stop 尚未出现
   completion 时，暂用 `Stop capturedAt - task_started timestamp`。JSON 必须暴露来源。
5. 会话值按 token 与时长加权，只聚合 reasoning 拆分完整的轮次；不得把总 output 口径和
   非推理 output 口径混在同一平均值里。拆分完整但非推理 output 为 0 的轮次是有效零速率
   样本，其端到端时长必须进入会话分母。
6. reasoning 拆分缺失或越界时，降级显示明确命名的“总输出整轮吞吐”，并标注拆分缺失。
7. transcript 推断的请求区间保留在 JSON 作兼容诊断，改用非推理 output 作为分子；不再
   出现在默认状态行，也不得称为精确请求速率或 TPS。
8. TTFT 与完成时长独立回填：缺 TTFT 不能阻止有效 `duration_ms` 修正分母，反之亦然。
9. 状态 schema 升至 v6，继续读取 v1-v5；旧记录能由 total/reasoning 复算时直接迁移语义。

## 验收不变量

- reasoning 不重复相加，也不进入主速率分子。
- completion 回填后，同一轮的主速率和会话加权值使用完成时长。
- 缺失/越界 reasoning 不产生伪造的非推理速率。
- 缺失 TTFT 仍可回填完成时长；缺失完成时长仍可回填 TTFT。
- Stop stdout 仍是严格 JSON；失败不 steer 或延长模型轮次。
- 状态文件仍只含哈希 ID、数值和固定枚举，不落盘正文、路径或凭据。
- stable runtime、Windows junction、保留策略、OTel 隔离边界与 phase-six capture-only
  约束保持不变。
- 全量测试、doctor、release check 和真实历史数字回放通过后才提交。
