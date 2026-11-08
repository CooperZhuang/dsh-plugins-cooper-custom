# 真实生产会话验证（Mubea_Invoice-Insight）

用本机真实会话日志做交叉会话记忆验证：拿 87 个真实会话，按时间顺序喂给插件抽取，
再拿每个会话里用户真实问过、当时助手确实回答了的问题，只用「该会话之前」的记忆回答，
与当时的真实回答对比。

- **只读**：只读 `~/.dsh/sessions/` 的日志，不改动生产项目任何代码；记忆库写在 `/tmp/real-work/`。
- **对照**：同一份抽取结果，只改召回/摘要参数（opt = 本分支，base = 优化前的门槛与预算）。
- **判分**：LLM 逐题判「只给记忆库的回答」相对「当时真实回答」的覆盖度（0/1/2）与是否含无关内容。

## 结果（82 个真实问题）

| 配置 | 平均覆盖 | 全覆盖 | 零覆盖 | 含无关内容 |
| --- | ---: | ---: | ---: | ---: |
| opt | 0.463 | 8.5% | 62.2% | 8.5% |
| base | 0.378 | 8.5% | 70.7% | 4.9% |

配对：opt 更好 12，base 更好 5，相同 65。

覆盖度绝对值偏低是正常的：真实问题里很大一部分答案只存在于「当前会话」的上下文里，
本来就不在跨会话记忆的范围。opt 的价值在于把「本来能答的」答出来（base 直接说不知道）。

## 典型差异

- 问「凭证号能否直接显示 / 发票能否做超链接」：opt 召回了两条相关约束（只有供应商发票才查 SAP 凭证号；
  预览不能用 `<a href>`，令牌在 localStorage、走 Authorization 头），base 只说不知道。
- 问「全量跑很慢是指什么」：opt 召回了「慢的根因是二维码解码阶梯，不是用例多」，base 说不知道。
- 问「批量建发票经办账号」：opt 召回了脚本路径、名单位置、默认口令，base 说不知道。

## 复现

```sh
# 1. 导出某项目的真实会话（只读）
python3 /tmp/dump_project.py ~/.dsh/sessions/--Users-cooper-Documents-Code-Mubea-Mubea_Invoice-Insight-- /tmp/mii-sessions.json
# 2. 跑 opt / base 两种配置
node harness.mjs --mode opt --reuse false
node harness.mjs --mode base --reuse false
# 3. 判分
python3 judge_real.py real-opt.json judge-opt.json
python3 judge_real.py real-base.json judge-base.json
```

原始会话内容不入库（含客户与项目信息），只保留聚合结果与少量示例。
