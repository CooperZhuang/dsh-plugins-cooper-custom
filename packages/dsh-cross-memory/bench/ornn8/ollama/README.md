# 本地 ollama 能否替代 DeepSeek 做记忆抽取

- **PC ollama**：`http://192.168.31.21:11434/v1`（OpenAI 兼容），模型 `qwen3.8:27b`、`gpt-oss:20b`。
- **方法**：同一批 12 个真实会话（Mubea_Invoice-Insight），用插件自己的抽取提示词分别喂给本地模型和 DeepSeek，
  再让 LLM 评审「哪个抽得全、噪声少」。
- **只读**：不修改生产项目；抽取结果写在 `/tmp/ollama-work/`。

## 结论：本地模型**不满足**抽取需求

| 模型 | 覆盖（0-5） | 噪声（0-5，越低越好） | 12 局胜 |
| --- | ---: | ---: | ---: |
| DeepSeek `deepseek-chat` | 4.58 | 2.17 | 12 |
| 本地 `qwen3.8:27b` | 2.08 | 2.25 | 0 |
| 本地 `gpt-oss:20b` | — | — | 抽不出（返回空） |

- `qwen3.8:27b` 能产出合法 JSON、标题也合理，但**抽得少**：同一会话 DeepSeek 抽 5-26 条，qwen 抽 0-8 条。
  对记忆系统来说，漏记等于「未来答不出来」，所以覆盖率是硬指标。
- `gpt-oss:20b` 在抽取提示词下返回空回复，12 个会话 0 条。
- 速度：qwen 每会话 2-5 分钟（27B Q4，长上下文）；DeepSeek 每会话约 10 秒。

## 所以

- **抽取继续走 DeepSeek**，峰时/谷时的限制保留。本地模型可作**降级兜底**（DeepSeek 不可达时用，质量下降但不中断）。
- 作答环节（非插件职责，是主 agent 的事）另见 `answer-local.json`（如已生成）。

## 复现

```sh
ssh pc 'Start-Process -FilePath "C:\Users\Cooper\AppData\Local\Programs\Ollama\ollama.exe" -ArgumentList serve'
node /tmp/chat-memory-benchmark/outputs/ollama-test.mjs --model qwen3.8:27b
node /tmp/chat-memory-benchmark/outputs/ollama-test.mjs --model deepseek-chat
python3 /tmp/ollama-work/judge_extract.py
```
