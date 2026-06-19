# 资讯过滤系统 · 改进路线图

> v6（已完成）→ v7（已完成）→ v8（已完成）→ v9（规划中）
> 上次更新：2026-06-19

---

## 进度总览

```
已完成  ██████████████████████  7 / 7  (P0/P1 全部完成)
待开始  ░░░░░░░░░░░░░░░░░░░░░░  2 / 9  (P2 待做)
```

---

## 一、已完成 ✅

### 1.1 VTuber 术语移出 SEED_GACHA

- 移除 `hololive` `にじさんじ` `nijisanji` `vtuber` `ブイアバ` `VTuber`
- 移除 `ディズニー`（过于宽泛）
- VTuber 文化属正统二次元，不应被二游过滤器拦截
- 品质控制交给 SEED_JUNK（切片/录播/clickbait）

### 1.2 关键词扩充 + 策展

- SEED_ANIME +30 词（推しの子、孤独摇滚、Dandadan、ATRI 等）
- SEED_GAME_JP +30 词（Innocent Grey、FLOWERS、サクラノ刻 等）
- SEED_JUNK 去重（移除已在 SEED_GACHA 中的冗余词）
- keyword-bank.json 策展（移除 vtuber/include、中文字幕/exclude 等）

### 1.3 种子词 JSON 化

- `data/seed-keywords.json`（119 行，8 个种子数组全部迁移）
- `fetch-news.js` 改为 `JSON.parse(fs.readFileSync(...))` 加载
- 正则构建 / Set 构建逻辑保留在 JS 中
- **提交**：`8fec3c9` (v7)

### 1.4 `--dry-run` 模式 + 盲区日志

- `node scripts/fetch-news.js --dry-run`：抓取+分类，不写文件
- 每条决策输出：`[pass:anime]` / `[block:gacha]` / `[no_match]`
- `data/no-match-log.json`：保留 7 天，单日 ≤50 条
- 结尾统计摘要
- **提交**：`8fec3c9` (v7)

### 1.5 源健康监控

- 4 源各产出数量 → 7 天滑动均值 → 低于 50% ⚠ 告警
- `data/source-health.json`：保留 30 天
- 连续 2 天低值 → `console.warn`
- **提交**：`8fec3c9` (v7)

### 1.6 种子词命中率追踪

- `data/seed-stats.json`：每个种子词的累计命中次数 + 最后命中日期
- 每轮输出 dead keywords（30 天未命中）和 top 5 blockers/passers
- **提交**：本 commit (v8)

### 1.7 关键词试用期

- `seed-keywords.json` 新增 `watch_exclude` 数组 — 试用期只记录不拦截
- 7 天到期评估：命中 ≥3 → 自动升级到 SEED_JUNK；<3 → 移除
- `watch_safe` 数组：标记永不自动升级的关键词
- `[watch:xxx]` 日志输出（dry-run 可见）
- **提交**：本 commit (v8)

---

## 二、待实施

### 🟢 P2 · 反向审计

**工作量**：20 分钟
**为什么**：现有关键词阻止了多少"其实该放行"的内容？

**做法**：

- [ ] `--audit` 模式：采样每个活跃 exclude 词的命中标题
- [ ] 智能标记：标题含 分析/杂谈/鉴赏/美学/历史/考据/回顾 但被拦截 → 标记为可疑误杀
- [ ] 只报告疑似误杀，不自动改规则

**参考**：ANN 用户的反馈——"过度过滤比不过滤更糟糕"。MAL 的教训——没有过滤机制用户会自己想办法，但错误的过滤机制用户会离开。

---

### 🟢 P2 · Admin 删除反馈

**工作量**：30 分钟
**为什么**：管理员手动删除 = 最强的负反馈信号，当前被丢弃。

**做法**：

- [ ] 被 admin 删除的自动条目 → 标题+标签写入 `data/admin-overrides.json`
- [ ] 下一轮：同标题自动降 heat（不展示）
- [ ] 标签提取 → 加入 watch_exclude 候选

**参考**：MBlock 的 HITL（Human-in-the-Loop）——"AI 不替代编辑，而是让编辑更高效"。你的 admin 就是那个人。

---

## 三、暂不实施

| 项目 | 原因 |
|------|------|
| 跨源去重（Jaccard 相似度） | n ≤ 30，肉眼可辨，自动化收益低 |
| 关键词管理 UI（admin 面板） | admin 操作量太小，CLI + JSON 够用 |
| fetch-news.js 拆模块 | 架构改进，无用户感知收益。功能稳定后再做 |
| 贝叶斯自适应分类 | 400 个种子关键词已覆盖主要场景，ML 是过度设计 |

---

## 四、每次改关键词的标准操作

```bash
# 1. 编辑关键词
vim data/seed-keywords.json    # 改种子词 / watch_exclude
vim data/keyword-bank.json     # 改学习词

# 2. 试跑看效果
node scripts/fetch-news.js --dry-run

# 3. 关注输出
#    [watch:xxx] 试用期关键词命中 → 不拦截，仅观察
#    [pass:anime] / [block:gacha] → 分类决策
#    [no_match] 里的标题 → 考虑加 include 词或加到 watch_exclude 观察
#    [block:xxx] 里被误杀的 → 考虑从 exclude 词移除
#    [seed-stats] top blockers / dead keywords → 词库健康度

# 4. 确认无误后正式跑
node scripts/fetch-news.js

# 5. 提交
git add data/ && git commit -m "fix: keyword update — ..."
```
