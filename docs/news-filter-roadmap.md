# 资讯过滤系统 · 改进路线图

> v6（已完成）→ v7（规划中）
> 上次更新：2026-06-19

---

## 进度总览

```
已完成  ████████░░░░░░░░░░░░  2 / 7
进行中  ░░░░░░░░░░░░░░░░░░░░  0 / 7
待开始  ░░░░░░░░░░░░░░░░░░░░  5 / 7
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

---

## 二、待实施

### 🔴 P0 · 种子词 JSON 化

**工作量**：30 分钟
**为什么**：当前 400+ 关键词硬编码在 JS 数组中。加一个词 = 在大数组里找位置 → 插入 → 确保逗号正确。JSON 天然防语法错误。

**做法**：

- [ ] 新建 `data/seed-keywords.json`
- [ ] 迁移 8 个种子数组到 JSON
- [ ] `scripts/fetch-news.js` 改为 `JSON.parse(fs.readFileSync(...))` 读取
- [ ] 构建 Set / 构建 regex 的逻辑留在 JS

**参考**：AniList 的标签和过滤逻辑分离；B 站的标签生产层独立于应用层。

---

### 🔴 P0 · `--dry-run` 模式 + 盲区日志

**工作量**：20 分钟
**为什么**：不知道哪些内容穿透了所有过滤器。`no_match` 项被静默丢弃——这些正是你该加关键词的地方。

**做法**：

- [ ] `node scripts/fetch-news.js --dry-run`：抓取+分类，不写文件
- [ ] 输出每条决策：`[pass:anime]` / `[block:gacha] blocked by "原神"` / `[no_match]`
- [ ] `no_match` 条目标题写入 `data/no-match-log.json`（保留 7 天，每天 ≤50 条）
- [ ] 结尾统计：`50 fetched → 18 passed + 15 blocked + 17 no_match`

**参考**：BiliBlockFusion 的"显示屏蔽原因"——knowing why something was blocked is as important as blocking it.

---

### 🔴 P0 · 源健康监控

**工作量**：15 分钟
**为什么**：某天 Bilibili API 改版 → 静默返回 0 条 → 几天后才发现。需要可观测性。

**做法**：

- [ ] 统计每轮各源产出数量，对比 7 天滑动均值
- [ ] 写入 `data/source-health.json`（只保留 30 天）
- [ ] 控制台输出：`[health] Bilibili: 7 (avg 9.3) ↓ ⚠ below normal`
- [ ] 连续 2 天低于 50% 均值 → `console.warn` 加 ⚠

**参考**：MBlock 的 scoring model——用数据而非直觉判断系统健康度。

---

### 🟡 P1 · 种子词命中率追踪

**工作量**：20 分钟
**为什么**：195 个 GACHA 词中有多少个从未命中？不知道。dead keywords 占空间且增加 regex 复杂度。

**做法**：

- [ ] `data/seed-stats.json`：每个种子词的命中次数 + 最后命中日期
- [ ] 每轮输出 dead keywords：`[seed-stats] unused 30d (8/195): ルパン三世, ...`
- [ ] 输出 top blockers：`[seed-stats] top 5: 原神(45), 崩坏(32), genshin(28)...`

**参考**：AniList 的 `minimumTagRank`——低使用率的标签自动隐藏。你的版本：低命中率的种子词标记为候选删除。

---

### 🟡 P1 · 关键词试用期

**工作量**：30 分钟
**为什么**：新排除词可能误杀正常内容——需要"只记录不拦截"的观察期。

**做法**：

- [ ] `data/seed-keywords.json` 新增 `watch_exclude` 数组
- [ ] 试用期 7 天：匹配时记录但不拦截，输出 `[watch]` 日志
- [ ] 到期评估：命中 ≥3 次 → 自动升级为 exclude；<3 次 → 移除
- [ ] 支持手动标记 `safe`：永不升级

**参考**：B 站的灰度放量策略（保留 5 个版本，支持快速回滚）。Git 就是你的版本管理——每次改关键词一个 commit，有问题 `git revert`。

---

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
vim data/seed-keywords.json    # 改种子词
vim data/keyword-bank.json     # 改学习词

# 2. 试跑看效果
node scripts/fetch-news.js --dry-run

# 3. 关注输出
#    [no_match] 里的标题 → 考虑加 include 词
#    [block:xxx] 里被误杀的 → 考虑移出 exclude 词

# 4. 确认无误后正式跑
node scripts/fetch-news.js

# 5. 提交
git add data/ && git commit -m "fix: keyword update — ..."
```
