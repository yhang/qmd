# Query Expansion 设计讨论与待迭代项

> 状态：讨论记录 / 待办池
> 关联文档：[CHINESE_SUPPORT_PLAN.md](./CHINESE_SUPPORT_PLAN.md)、[CHINESE_SUPPORT_DESIGN.md](./CHINESE_SUPPORT_DESIGN.md)
> 用途：把"是否需要微调 / 提示词如何加强"这条线的思考存档，等当前中文支持落地后再迭代

## 1. 关键问题

> 模型能力够强，是不是不用微调也可以？

简短回答：**是的，强模型可以替代微调。** SFT 的本质是"把检索常识烧进 1.7B 小模型权重"，强模型只要把常识写进 prompt 即可达到等价效果。

## 2. 微调实际在解决什么

把 [`finetune/SCORING.md`](../finetune/SCORING.md) 的训练目标拆开看：

| 解决的问题 | 是否需要微调 | 替代方案 |
|-----------|------------|---------|
| 输出格式 (`lex:/vec:/hyde:` DSL) | 不需要 | 已有 grammar 约束 [`src/llm.ts` L1142-1149](../src/llm.ts#L1142-L1149) 强制输出 shape |
| 检索学问内化（保留命名实体、lex 短 vec 长、避免泛词、何时引号） | 1.7B 小模型需要 | 强模型 + 详细 prompt + 少量 few-shot |
| 本地推理 / 隐私 / 成本 | 1.7B 微调是性价比首选 | 强模型吞 GPU / API key |

只有**第二项**是 SFT 真正不可替代的；前者由代码已有的 grammar 解决，后者是部署偏好。

## 3. 模型大小 vs 提示词详尽度

经验法则：**模型每大一档，prompt 可以简短一档**。

| 模型规模 | 推荐 prompt 风格 | 输入开销 |
|---------|----------------|---------|
| 1.7B SFT 专用（`qmd-query-expansion-1.7B`） | 极简："Expand this search query: …" | ~50 tok |
| 1.7B-7B 通用（`Qwen3-1.7B-Instruct`、`Qwen3-7B`） | 中等：列出 lex/vec/hyde 角色 + 数量 | ~200-300 tok |
| 32B+ 或 API（`Qwen3-32B`、`GPT-4o`、`DeepSeek-V3`） | 详细：完整 rubric + 1-2 个 few-shot | ~500-800 tok |

跨 tier 用错 prompt 风格的代价：

- 简 prompt + 通用小模型 → 输出泛化、丢实体（最常见的失败模式）
- 详 prompt + SFT 专用模型 → 多余开销，且会和 SFT 训练分布冲突，反而降准

## 4. 对当前中文路径的影响

当前计划已在走"无微调"路线（用户没有中文 SFT 模型可用），但 [`docs/CHINESE_SUPPORT_DESIGN.md` §4.4](./CHINESE_SUPPORT_DESIGN.md) 设计的 zh 模板偏中等详尽度：

```
- lex 行给 1-3 个关键词
- vec 行给 1-3 条自然语言改写
- hyde 行给 1 句假设性答案段落
```

够 Qwen3-1.7B 用，但**漏了最关键的 entity 保留 / 避免泛词 / 引号短语规则**。1.7B 通用模型在 `"TDS motorsports 是谁"` 这类查询上很可能输出 `lex: 公司信息`，对应 SCORING 里 -30 重罚的反面教材。

## 5. 待迭代项

下面三项不在当前 [`CHINESE_SUPPORT_PLAN.md`](./CHINESE_SUPPORT_PLAN.md) 范围内，等中文基础支持上线、收集真实使用反馈后再启动。

### 5.1 升级 `zh` 模板为 verbose 自包含版

把 SCORING 的关键规则压缩进 zh prompt：

```ts
zh: (q, intent) => `/no_think 你是搜索查询扩展助手。给定中文查询，按以下严格格式输出：
  hyde: <一句假设性答案段落，50-200 字，单行>
  lex: <1-3 行关键词短语，用于 BM25 检索>
  vec: <1-3 行自然语言改写，用于向量语义检索>

规则：
- 保留查询中所有命名实体（人名、产品名、技术名、专有名词），lex 行必须包含
- lex 行短而精，以关键词为主；vec 行用完整自然语句
- 不要逐字重复原查询
- 禁用"查找关于...的信息""搜索...""了解..."等空泛短语
- 多词专有名词在 lex 中用引号："机器学习"

示例：
  查询：身份认证配置
  hyde: 身份认证可以通过设置 AUTH_SECRET 环境变量并在配置文件中启用 auth 中间件来配置。
  lex: 身份认证 配置
  lex: auth 配置 设置
  vec: 如何配置身份认证
  vec: 身份认证选项与设置

查询：${q}${intent ? `\n查询意图：${intent}` : ''}`
```

**验收标准**：在 `evals/queries.txt` 增 ~20 条中文查询，跑 `eval.py` 用同一个 Qwen3-1.7B-Instruct 评测：verbose 版相对当前精简版，"entity 保留"维度 +15 分以上。

**风险**：长 prompt 会挤占 generation context window。当前 `expandContextSize` 默认 2048，verbose zh prompt 约 400 token，仍有 1600 token 余量给输出，足够。

### 5.2 新增"强模型"配置档（D 档）

在 [README.md `## Multilingual / Chinese Support`] 现有 A/B/C 三档之后追加 D 档：

```sh
# 档位 D — 强通用模型，跳过 SFT 路线
export QMD_GENERATE_MODEL="hf:Qwen/Qwen3-7B-Instruct-GGUF/Qwen3-7B-Instruct-Q4_K_M.gguf"
# 中文查询自动用 verbose zh 模板（5.1 落地后）
# 英文查询想用 verbose 可自定义：
export QMD_EXPAND_PROMPT="$(cat ~/my-verbose-template.txt)"
```

适合：用户已有 7B+ 模型在跑、不想额外维护 SFT 模型、或希望中英文检索质量统一的场景。

**风险**：7B 模型 VRAM 占用 ~5GB（Q4_K_M），需要文档明确硬件要求。

### 5.3 可选 — 给英文也加 verbose 模板

目前默认 en 模板是 `/no_think Expand this search query: …`，这是**专门给 SFT 模型设计的触发器**。用户切到通用英文强模型时这套 prompt 显著欠拟合。

方案：扩展 [`src/expandPrompt.ts`](../src/expandPrompt.ts) 的注册表为二维（语言 × 风格）：

```ts
const PROMPTS = {
  'en-compact': (q, i) => /* 现行默认，给 SFT 模型 */,
  'en-verbose': (q, i) => /* 完整 rubric + few-shot */,
  'zh-compact': (q, i) => /* 给小模型 */,
  'zh-verbose': (q, i) => /* 5.1 升级版 */,
};
```

引入 `QMD_EXPAND_STYLE=auto|compact|verbose` 环境变量：

- `auto`（默认）：默认模型 → compact；自定义 `QMD_GENERATE_MODEL` → verbose。
- `compact` / `verbose`：强制覆盖。

**触发条件**：用户反馈"切了通用英文模型后效果反而比 SFT 差"时启动这一项。

## 6. 何时启动这些迭代

按优先级：

1. **5.1（升级 zh）**：中文支持上线后立刻做。zh 模板是中文用户的唯一路径，欠详尽就是直接的质量损失。
2. **5.2（D 档配置）**：5.1 完成后顺手在 README 加；纯文档变更，无代码改动。
3. **5.3（英文 verbose）**：等真实用户反馈触发；不要主动做，因为它会让 prompt 注册表复杂化，得不偿失。

## 7. 不在范围（更远期）

- 训练中文版 SFT 模型（`tobil/qmd-query-expansion-1.7B-zh`）：成本 ~$1.50，但需要先收集 ~2000 条中文 query 标注。可考虑把英文数据机器翻译 + 人工校对作为冷启动。
- 双语混合训练：把英文 + 中文 SFT 数据合并，得到一个无需切换的双语模型。这是最优雅的终态，但样本平衡和评测设施都要扩。
- 评测集：在 `finetune/evals/queries.txt` 加中文测试用例，让 `eval.py` 能跑中文评测。

## 8. Review 历史

### 2026-04-28 — 计划与设计文档第一轮 review

[`CHINESE_SUPPORT_PLAN.md`](./CHINESE_SUPPORT_PLAN.md) 与 [`CHINESE_SUPPORT_DESIGN.md`](./CHINESE_SUPPORT_DESIGN.md) 第一稿收到 13 条反馈，全部吸纳：

**致命修订（不修则端到端行为不一致）**：
- 旁路 LLM 必须在 store 层（避开 `r.text !== query` 过滤）。
- jieba 必须同步加载（`createRequire`）才能与同步 FTS 路径配合。

**接口修正**：
- 实际写入函数是 `insertDocument`/`updateDocument`/`updateDocumentTitle`/`findOrMigrateLegacyDocument`（之前误写为 `addDocument`/`renameDocument`）。
- jieba 启用步骤改为 `qmd update`（之前误写为 `qmd embed -f`）。

**安全与一致性**：
- `QMD_FTS_TOKENIZER` 走 allowlist，不直接拼 SQL。
- jieba 缺失时改为 `auto` 显式 opt-in，默认仍 `porter unicode61`，避免英文用户被静默升级。
- sqlite_master 作为 tokenizer 真源，不引入 store_config 双源。
- `getTokenizerFamily` 解析覆盖 `'trigram case_sensitive 0'` 等合法变体。
- BGE 检测收紧为 `bge-?m3`，其他 BGE 变体走 `raw`。

**可观测性与测试**：
- `qmd status` 暴露多语支持当前状态。
- 测试加"零默认行为变化"断言（schema/prompt/format 全部不变）。
- 测试 `process.env` 用 `beforeEach`/`afterEach` 隔离。
- 加 `updateDocumentTitle` 不破坏 segmented body 的回归测试。

### 2026-04-28 — 第二轮 review

第一稿吸纳后又收到 5 条意见，揭示出关键落地缺口与文档内部不一致：

**关键落地缺口**：
- **`qmd update` 不能让 jieba 生效**：`reindexCollection` 对 hash+title 都没变的文档命中 `unchanged++` 短路（[`src/store.ts` L1242-1249](../src/store.ts#L1242-L1249)），不会调 `syncFtsBody`。10k 文档的库安装 jieba 后跑 `qmd update`，FTS body 仍可能全部是 raw。

  解法：新增 `store_config[fts_segmenter_state]` 持久化 segmenter 状态，`initStore` 检测变化自动 walk-resync 全量 FTS body。无需用户介入。详见设计文档 §6.6。这与"sqlite_master 是 tokenizer 单一真源"的原则不冲突 —— segmenter 是 sqlite_master 反映不出来的正交事实。

**`force` 语义错位**：
- 原 `buildExpandPrompt` 用 `lang === 'zh' ? PROMPTS.zh : PROMPTS.en` 判断，导致 `lang === 'force'` 落到英文模板。修复：把 `QMD_EXPAND_LANG` 解读拆成 `resolvePromptLang`（en/zh）+ `shouldSkipLlmExpansion`（旁路决策），两条线分别处理 `force`/`skip` 与 `auto/en/zh`。

**接口签名问题**：
- `buildFTS5Query` 当前没有 db 参数，新设计调用 `getCurrentTokenizer(db)` 会卡在边界。改为 `buildFTS5Query(query, tokenizerFamily)`，`searchFTS` 用 `WeakMap<Database,string>` 缓存注入。

**文档内部一致性**：
- 旁路返回值在多处文档不一致（mermaid 与文字一处 `[lex, vec, hyde]`，另一处 `[lex, vec]`）→ 全部统一为 `[lex, vec]`。
- `QMD_EMBED_FORMAT=bge` 出现在配置示例但 allowlist 已是 `bge-m3` → 同步修正。
- 改动概览表中"llm.ts:expandQuery 加 CJK 检测"未跟上"短路移到 store 层"的设计 → 同步修正。

## 参考

- [`finetune/SCORING.md`](../finetune/SCORING.md) — 完整评分规则，是 verbose prompt 的素材源
- [`finetune/README.md`](../finetune/README.md) — SFT 训练流程
- [HyDE 论文](https://arxiv.org/abs/2212.10496) — `hyde:` 行的理论依据
