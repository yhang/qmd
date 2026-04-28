# 中文支持 — 修改计划

> 状态：待实施
> 范围：FTS5 中文分词、自定义向量模型（BGE-M3 等）、中文检索时的 LLM 提示词
> 设计文档：[CHINESE_SUPPORT_DESIGN.md](./CHINESE_SUPPORT_DESIGN.md)

## 目标

1. FTS5 支持中文分词（不再每个汉字一个 token）。
2. 支持通过环境变量切换到 BGE-M3 等多语向量模型，且不会被错误的英文 prompt 污染向量。
3. 中文查询走正确的检索路径：要么旁路英文专用的 LLM expansion，要么使用中文提示词。
4. 不破坏默认行为（英文场景输出与上游一致）。
5. 改动以"加文件 + 注入开关"为主，便于后续从上游 fork 合并。

## 非目标（本期不做）

- jieba 用户词典 / 自定义词表加载。
- BGE-M3 sparse / multi-vector（仍只用 dense embedding）。
- `extractIntentTerms` 的中文 stopword 列表。
- 替换默认模型为多语模型（保持上游默认）。

## 设计原则

- **零默认行为变化（review-4 #1 强化 + review-5 #1 精确化）**：作用域严格界定为：
  - **ASCII 查询路径** byte-identical 与上游（schema、embedding prompt、英文 expansion prompt、查询返回结构均不变）。
  - **FTS body 形态** 严格不变：即便 `@node-rs/jieba` 经 `optionalDependencies` 自动安装，`QMD_FTS_SEGMENTER` 默认 `identity` 时 body 仍是 raw、segmenter state 为 identity（review-4 #1）。
  - **CJK 查询的 expansion 路径**默认有改进性变化：`auto+CJK+默认模型` 旁路 LLM 返回 `[lex, vec]` 原句。这不是回归（上游 CJK 路径本就是英文 prompt 配中文查询，输出近似乱码）。**完整**恢复上游行为需显式设 `QMD_EXPAND_LANG=en`（review-6 #1：`=force` 仅保证调 LLM，但 CJK 下会走中文 prompt，并不等价于上游）。该改进通过 §8.1 Case C 显式记录而不是隐藏。
- **新增 > 修改**：核心新逻辑放进新文件，现有文件只插入薄 hook。
- **可选依赖 + 显式开关**：`@node-rs/jieba` 进 `optionalDependencies`；`isJiebaAvailable()` 反映模块加载，`isJiebaActive()` 聚合 `QMD_FTS_SEGMENTER` 与模块状态（**缓存归一化**，未知值仅 warn 一次，review-5 medium-3）；只有 active 才参与索引/查询切分。
- **Schema 与 Segmenter 双自愈**：tokenizer 变化由 sqlite_master 检测；segmenter 激活/失活由 `store_config[fts_segmenter_state]` 检测（**访问器 `readSegmenterState(db)` 把缺 row 视为 `'identity'`**，review-5 #2），自动 walk + resync 现有 FTS body（关键修复，否则 `qmd update` 对 hash-unchanged 文档不会触发 syncFtsBody）。

## 改动概览

### 新文件（5 个）

| 文件 | 作用 |
|------|------|
| `src/embedFormat.ts` | 向量提示词格式注册表（`gemma`/`qwen3`/`bge-m3`/`raw`） |
| `src/i18n/cjk.ts` | `containsCJK` / `isPredominantlyCJK` 工具 |
| `src/fts/segmentCJK.ts` | 可选 jieba 词级切分，**模块顶部用 `createRequire` 同步加载** |
| `src/expandPrompt.ts` | LLM expansion 提示词注册表 + `resolvePromptLang` + `shouldSkipLlmExpansion` |
| `test/i18n.test.ts` | 集中测试 |

### 修改文件（7 个）

| 文件 | 改动 |
|------|------|
| `src/llm.ts` | 三个 format 函数改为薄壳；`expandQuery` 用 `buildExpandPrompt` 替换硬编码英文 prompt（**不做 CJK 检测，CJK 短路在 store 层**）；修复 `hasQueryTerm` Unicode 兼容 |
| `src/store.ts` | tokenizer 走 `resolveTokenizer()`；tokenizer-mismatch 自愈（sqlite_master 真源）；segmenter-state 自愈 walk-resync（store_config，状态值由 tokenizer family + jieba 共同决定）；`syncFtsBody` 在 4 个写入函数末尾调用（仅 jieba 兼容 family 下生效）；`buildFTS5Query(query, tokenizerFamily)` **签名变更**；`searchFTS` 注入 family；`expandQuery` 入口调 `shouldSkipLlmExpansion` 旁路 |
| `src/cli/qmd.ts` | `qmd status` 输出加多语 section（含 segmenter state、bypass rule 行） |
| `package.json` | `optionalDependencies` 加 `@node-rs/jieba` |
| `README.md` | 新增 `## Multilingual / Chinese Support` 小节 + env 变量表 |
| `CLAUDE.md` | `## Architecture` 后追加一行说明 |
| `CHANGELOG.md` | `## [Unreleased]` 加 `### Added` 条目 |

## 新增环境变量

| 变量 | 默认 | 作用 |
|------|------|------|
| `QMD_FTS_TOKENIZER` | `porter unicode61` | FTS5 tokenizer。**仅接受 allowlist 值**：`porter unicode61`/`unicode61`/`unicode61 remove_diacritics 2`/`trigram`/`trigram case_sensitive 0`/`trigram remove_diacritics 1`/`ascii`/`auto`。`auto` 时按 `isJiebaActive()`（=segmenter 真正启用且模块装了）切换 |
| `QMD_FTS_SEGMENTER` | `identity` | FTS body 预切分开关（review-4 #1）。`identity`：不切；`jieba`：必须 jieba 装好，否则 fallback identity；`auto`：装了就用，没装就 identity。**默认 `identity` 是"零默认变化"的关键** |
| `QMD_EMBED_FORMAT` | 自动检测 | 强制指定向量提示词格式：`gemma`/`qwen3`/`bge-m3`/`raw` |
| `QMD_EXPAND_LANG` | `auto` | LLM expansion 语言策略：`auto`/`en`/`zh`/`force`/`skip` |
| `QMD_EXPAND_PROMPT` | 未设置 | 完全自定义 expansion 提示词模板（含 `{query}`、`{intent}` 占位符） |

复用已有变量：`QMD_EMBED_MODEL`、`QMD_GENERATE_MODEL`、`QMD_RERANK_MODEL`。

**安全**：所有 env 字符串走 allowlist，不直接拼进 SQL；非法值告警 + 回退默认。

## 实施步骤（按依赖顺序）

- [ ] **1. CJK 检测工具** — 新建 `src/i18n/cjk.ts`，导出 `containsCJK` / `isPredominantlyCJK`。无外部依赖。
- [ ] **2. 向量格式注册表** — 新建 `src/embedFormat.ts`（4 个 strategy：`gemma`/`qwen3`/`bge-m3`/`raw`，BGE 检测收紧到 `bge-?m3`）；改造 `src/llm.ts` L29-58 的三个函数为薄壳。
- [ ] **3. CJK 切分器（同步） + segmenter 开关（review-4 #1）** — 新建 `src/fts/segmentCJK.ts`，**用 `node:module` 的 `createRequire` 在模块顶部同步加载** `@node-rs/jieba`；导出 `segmentCJK(text): string`、`isJiebaAvailable(): boolean`、`isJiebaActive(): boolean`（聚合 `QMD_FTS_SEGMENTER` + 模块状态，默认 `identity` → false）、`getJiebaStatus()`。
- [ ] **4. Tokenizer 解析与 allowlist** — 新建 `resolveTokenizer()` / `getTokenizerFamily()`：`QMD_FTS_TOKENIZER` 限定 allowlist（合法值见上表），`auto` 调 `isJiebaActive()`（**而非** `isJiebaAvailable()`，review-4 #1）决策；非法值告警 + fallback。
- [ ] **5. FTS tokenizer 注入** — 修改 `src/store.ts` L835-839，用 `resolveTokenizer()` 输出注入 `tokenize='...'`。
- [ ] **6. FTS 自愈重建（sqlite_master 为 tokenizer 真源）** — `initStore` 解析现有 `documents_fts.sql`，与目标 tokenizer 不一致时 DROP + CREATE + walk-and-segment 重填。tokenizer 信息**只**走 sqlite_master，不进 store_config。
- [ ] **7. Segmenter state 自愈（store_config 持久化，review-2 #1 + review-3 #4/#5 + review-4 #1/#4）** — 新增 `reconcileFTSState`：tokenizer 不一致 → schema 重建走 `rebuildFTSWithSegmentation`，**重建的最后一步走 `walkAndResyncFTSBodies` 而非裸 `INSERT...SELECT`**（review-3 #4），保证一次性应用 segmenter；schema 一致但 segmenter state 不一致 → 仅 walk-resync。`getEffectiveSegmenterState(tokenizerFamily)` 返回 `'jieba'` 当且仅当 tokenizer family ∈ {`porter`,`unicode61`}（**review-4 #4：移除 ascii**）且 `isJiebaActive()=true`（**review-4 #1：而非 isJiebaAvailable**）；trigram 永远 `'identity'`。
- [ ] **8. FTS body 词级切分（review-3 #5 + review-4 #4）** — 实现 `syncFtsBody(db, collection, path)`：先用 `getTokenizerFamilyForDb` 取 family，调 `shouldApplyJiebaSegmentation(family)` 决定是否切分；后者要求 family ∈ {`porter`,`unicode61`} 且 `isJiebaActive()=true`。trigram 下直接 return（保持 raw body 给 trigram 做连续 3-gram 匹配）。在以下函数末尾调用：
   - `insertDocument` ([L2083](src/store.ts#L2083))
   - `updateDocument` ([L2186](src/store.ts#L2186))
   - `updateDocumentTitle` ([L2172](src/store.ts#L2172))
   - `findOrMigrateLegacyDocument` 手动 rebuild ([L2153-2159](src/store.ts#L2153-L2159))
- [ ] **9. lex query 切分（buildFTS5Query 签名变更 review-2 #4 + 查询侧守卫 review-4 #2）** — 改为 `buildFTS5Query(query, tokenizerFamily)`；**入口的 `segmentCJK(query)` 必须用同一个 `shouldApplyJiebaSegmentation(family)` 守卫包住**：`const input = shouldApplyJiebaSegmentation(family) ? segmentCJK(query) : query`。否则 trigram 下"机器学习"被切成"机器 学习"两个不足 3 字 token，trigram 召回失败。新增 `getTokenizerFamilyForDb(db)` 用 `WeakMap<Database,string>` 缓存（自愈重建时 `cache.delete(db)` 失效）；`searchFTS` 调用前 resolve family 注入。trigram 家族下对 CJK term 去掉前缀 `*`。
- [ ] **10. expandQuery 中文旁路（store 层，review-8 #3 + review-9 #1 + review-10 #1/#3 注入 effective model）** — 修改 `src/store.ts:expandQuery` ([L3258-3290](src/store.ts#L3258-L3290))：**沿用既有的 `llmOverride` 参数通道**，入口写 `const llm = llmOverride ?? getDefaultLlamaCpp(); const usingDefaultGenerateModel = llm.usingDefaultGenerateModel(); if (shouldSkipLlmExpansion(query, { usingDefaultGenerateModel })) return [{type:'lex',query},{type:'vec',query}]`。后续 `llm.expandQuery(...)` 调用复用同一 `llm` 变量（与 [L3276 现有写法](src/store.ts#L3276) 对齐）。**关键（review-9 #1）**：`createStore` 在 [L1646](src/store.ts#L1646) 把 `store.llm` 作为 `llmOverride` 注入；`store.llm` 在 [`src/cli/qmd.ts` L123-128](src/cli/qmd.ts#L123-L128) 由 `config.models.generate` 构造。绕过 `llmOverride` 直接 `getDefaultLlamaCpp()` 会让 `config.models.generate` 配置失效。同步在 [`src/llm.ts`](src/llm.ts) 的 `LlamaCpp` 类上**加两个 public 方法**：`usingDefaultGenerateModel(): boolean`（**与 [`DEFAULT_GENERATE_MODEL_URI` L209](src/llm.ts#L209) 比较**，review-9 #3）+ `getGenerateModelUri(): string`（review-10 #3：供 `qmd status` 展示用，避免直接读 private 字段卡 TypeScript 可见性）。**不要**把 `generateModelUri` 字段改 public。
- [ ] **11. expansion 提示词注册表（review-2 #5 + review-6 #1 + review-8 #1）** — 新建 `src/expandPrompt.ts` 同时导出 `resolvePromptLang`（en/zh）+ `shouldSkipLlmExpansion(query, options?)`（旁路决策）+ `buildExpandPrompt`。优先级（高到低）：① `=skip` 绝对最高永远旁路；② `=force/en/zh` 显式不旁路；③ `QMD_EXPAND_PROMPT` 设了任意非空值视为隐式 opt-in 不旁路（**review-8 #1**：用户写了模板就要用 LLM）；④ `auto`+CJK+effective 默认模型 → 旁路。`force` 不锁定 prompt 语言（按查询脚本），`en`/`zh` 锁定。`src/llm.ts:expandQuery` 用 `buildExpandPrompt` 替换硬编码英文 prompt。
- [ ] **12. Unicode 修复** — `src/llm.ts` L1180-1187 的 `hasQueryTerm` 改为 `\p{L}\p{N}` Unicode-aware。
- [ ] **13. `qmd status` 状态展示（review-9 #2 + review-10 #3 effective model 对称）** — 多语 section：tokenizer / jieba / segmenter state / **generate model** / embed format / prompt lang / bypass rule。**与 store 层对称取 effective LlamaCpp**：先 `const llm = store.llm ?? getDefaultLlamaCpp()`，`Generate model` 行打印 `llm.getGenerateModelUri()`（**review-10 #3 锁定为 public getter，不直接读 private 字段**），`Expand bypass` 行调用 `shouldSkipLlmExpansion(query, { usingDefaultGenerateModel: llm.usingDefaultGenerateModel() })`。这样 status 显示与 store 层旁路决策永远一致 —— 否则 `config.models.generate` 配自定义模型时 status 会错误显示 "默认模型 → 旁路"。
- [ ] **14. 依赖与文档** — `package.json`、`README.md`、`CLAUDE.md`、`CHANGELOG.md`。README "jieba 启用步骤" 强调"安装后下次启动自动 resync，无需 qmd update"。
- [ ] **15. 测试** — `test/i18n.test.ts` 覆盖所有新模块（详见下文）。

## 测试矩阵

`test/i18n.test.ts`（**所有用例必须 `beforeEach`/`afterEach` 快照恢复 `process.env`**）：

### 默认行为契约断言（review-2 #12 + review-4 medium-2 + review-5 #1）

**作用域（review-5 #1）**：Case A/B 守 ASCII byte-identical 与 FTS body 严格不变；Case C 把"CJK 默认改进"作为**显式契约**而非隐藏行为。

**Case A — jieba 不可用 + 未设任何 `QMD_*`**（mock `isJiebaAvailable()=false`）：
- `documents_fts` schema 包含 `tokenize='porter unicode61'`
- `formatQueryForEmbedding('foo')` === `task: search result | query: foo`
- `formatDocForEmbedding('hello', 'doc')` === `title: doc | text: hello`
- ASCII：`buildExpandPrompt('foo')` === `/no_think Expand this search query: foo`
- ASCII：`shouldSkipLlmExpansion('foo')===false`，mock-LLM **被调用**且参数 == 英文模板

**Case B — jieba 可用 + 未设任何 `QMD_*`（review-4 medium-2 关键）**（mock `isJiebaAvailable()=true`、env 全清）：
- `isJiebaActive()===false`（`QMD_FTS_SEGMENTER` 默认 `identity`）
- `shouldApplyJiebaSegmentation('porter')===false`
- `insertDocument("机器学习……")` 后 `documents_fts.body` 等于 raw 原文（无空格）
- `readSegmenterState(db)==='identity'`（review-5 #2：访问器统一兜底；可能体现为 row 缺失）
- 该断言守住"optionalDependencies 自动安装不污染默认行为"

**Case C — CJK 默认改进的非回归断言（review-5 #1 显式契约 + review-6 #1 修正）**（未设任何 env，CJK 查询）：
- `shouldSkipLlmExpansion('机器学习')===true`
- `store.expandQuery('机器学习')` 返回 `[{type:'lex',query},{type:'vec',query}]`，mock-LLM **未被调用**
- 显式恢复上游"英文 prompt + LLM"：`QMD_EXPAND_LANG=en` → `shouldSkipLlmExpansion===false`，mock 被调用，prompt == 英文模板
- 强制走中文 prompt：`QMD_EXPAND_LANG=zh` → mock 被调用，prompt 由 `resolvePromptLang` 选（CJK → zh）
- 强制调 LLM 但按查询脚本选模板：`QMD_EXPAND_LANG=force` → mock 被调用，CJK 查询走中文模板，ASCII 查询走英文模板
- 永远旁路：`QMD_EXPAND_LANG=skip` → mock 永不被调用

### 单元测试

- `detectEmbedFormat`：`bge-m3` URI → `bge-m3`；`bge-large-zh` → `raw`（注意 review #10 的收紧）；`Qwen3-Embedding` → `qwen3`；`embeddinggemma` → `gemma`；`QMD_EMBED_FORMAT=raw` 覆盖优先。
- `containsCJK` / `isPredominantlyCJK`：纯/混合/空/纯空格场景；阈值边界。
- `segmentCJK`：jieba 缺失时 identity；混合 ASCII+CJK 时只切 CJK 段；同步可调用。
- `resolvePromptLang`：CJK auto → `zh`；ASCII auto → `en`；`en`/`zh` 直接返回；`force`/`skip` 按查询脚本判定（**不**落到固定语言）。
- `shouldSkipLlmExpansion`（review-6 #1 + review-8 #1/#3）：
  - `auto`+CJK+`usingDefaultGenerateModel=true` → `true`；`auto`+CJK+`usingDefault=false` → `false`；`auto`+ASCII → `false`。
  - `en`/`zh`/`force` → **永远 `false`**（显式 → 不旁路）。
  - `skip` → 永远 `true`（绝对最高优先级）。
  - `QMD_EXPAND_PROMPT='custom'` + `auto` + CJK + `usingDefault=true` → **`false`**（review-8 #1：隐式 opt-in 覆盖默认旁路）；同条件 + `=skip` → 仍 `true`。
  - 不传 `options` → 默认 `usingDefaultGenerateModel=true`（向后兼容）。
- `buildExpandPrompt`：CJK 查询走中文模板；`QMD_EXPAND_PROMPT="hi {query}"` 占位符替换；`QMD_EXPAND_LANG=en` 强制英文（即便查询是中文）；`QMD_EXPAND_LANG=force` 不影响模板选择。
- `isJiebaActive`（review-4 #1 + review-5 medium-3）：`QMD_FTS_SEGMENTER` 取 `identity`/未设/未知值 → false；`jieba` 但模块未装 → false；`auto`/`jieba` 且模块装了 → true；未知值仅 warn 一次（用 `__resetSegmenterSettingCache` 在 `beforeEach` 重置缓存）。
- `resolveTokenizer`（review-5 #3 重写）：allowlist 命中；`auto` 决策**基于 `isJiebaActive()`**（而非 `isJiebaAvailable()`）。覆盖关键组合 ——
  - jieba 装了 + `QMD_FTS_SEGMENTER=identity`（默认）+ `QMD_FTS_TOKENIZER=auto` → **trigram**（active=false）
  - jieba 装了 + `QMD_FTS_SEGMENTER=jieba` + `QMD_FTS_TOKENIZER=auto` → `porter unicode61`
  - jieba 装了 + `QMD_FTS_SEGMENTER=auto` + `QMD_FTS_TOKENIZER=auto` → `porter unicode61`
  - jieba 未装 + `QMD_FTS_SEGMENTER=jieba` + `QMD_FTS_TOKENIZER=auto` → trigram（active=false，模块未装）
  - 未命中 allowlist → 告警 + fallback `porter unicode61`
- `getTokenizerFamily`：`'trigram case_sensitive 0'` → `'trigram'`、`'porter unicode61'` → `'porter'`。

### 集成测试（mock LLM）

`store.expandQuery`（不是 `llm.ts:expandQuery`）注入 mock + 在测试里 `setDefaultLlamaCpp(mockLlm)`，`mockLlm.usingDefaultGenerateModel()` 可控：
- 中文查询 + `usingDefaultGenerateModel()=true` → mock 不被调用，返回 `[{type:'lex',query},{type:'vec',query}]`（不含 hyde）。
- 中文查询 + `usingDefaultGenerateModel()=false`（review-8 #3：覆盖 env 与 config 两条路径）→ mock 被调用，prompt 是中文模板。
- 中文查询 + `usingDefault=true` + 设 `QMD_EXPAND_PROMPT='hi {query}'`（review-8 #1）→ mock **被调用**，prompt == `'hi 机器学习'`（隐式 opt-in 覆盖默认旁路）。
- 英文查询 → mock 被调用，传入的 prompt 是英文模板（行为不变）。

### SQL 集成测试

> 所有要求 jieba 切分生效的测试都必须**同时**显式设 `QMD_FTS_SEGMENTER=jieba`（review-4 #1）；只 mock `isJiebaAvailable()=true` 不再足够。

- **默认 tokenizer 不变**：未设 env 时 schema SQL 应保持 `tokenize='porter unicode61'`。
- **tokenizer 切换重建**：先用 `porter unicode61` 索引，改 `QMD_FTS_TOKENIZER=trigram` 重新 `initStore`，验证 `documents_fts` 已被 DROP+CREATE 且文档仍可搜到。
- **trigram + 中文搜索（≥3 字符，review-3 #1）**：插入"机器学习是人工智能的一个分支"，搜索 `"机器学"` 应命中。**显式断言** `"机器"`（2 字）在 trigram 下不可靠/不召回。
- **jieba 写入切分一致（review-3 #5）**：`QMD_FTS_TOKENIZER=porter unicode61` + `QMD_FTS_SEGMENTER=jieba` + mock 确定性 `segmentCJK`，`insertDocument` 后 `documents_fts.body` 含切分。
- **查询侧切分对称（review-4 #2）**：`QMD_FTS_TOKENIZER=trigram` + `QMD_FTS_SEGMENTER=jieba`，断言 `buildFTS5Query("机器学习", 'trigram')` **不调用** `segmentCJK`（mock 调用次数 0）；同条件 family=`porter` 时**调用** `segmentCJK`。
- **trigram 永不预切分（review-3 #5 + review-4 #4）**：`QMD_FTS_TOKENIZER=trigram` × `QMD_FTS_SEGMENTER ∈ {identity, jieba, auto}` 三组，所有情况下 `documents_fts.body` 都为 raw、`readSegmenterState(db)==='identity'`（review-5 #2：访问器统一兜底）。
- **ascii tokenizer 不参与 jieba（review-4 #4）**：`QMD_FTS_TOKENIZER=ascii` + `QMD_FTS_SEGMENTER=jieba`，断言 `documents_fts.body` 仍为 raw、`readSegmenterState(db)==='identity'`。
- **`updateDocumentTitle` 不破坏 segmented body**：先 insert（segmenter=jieba 切分） → `updateDocumentTitle` → FTS body 仍为 segmented。
- **`findOrMigrateLegacyDocument` 切分**：rename 后 FTS body 也是 segmented（仅在 family ∈ {porter, unicode61} 且 segmenter active 下）。
- **Segmenter state 自愈（review-2 #1 + review-4 #1）**：先 `QMD_FTS_SEGMENTER` 未设 + jieba available + 索引中文（body raw、state=identity），随后设 `QMD_FTS_SEGMENTER=jieba` 重 `initStore`，验证 walk-resync 把 body 改写为 segmented、state 变 `'jieba'`。
- **tokenizer + segmenter 一次性合并（review-3 #4）**：`trigram + identity` → `porter unicode61 + segmenter=jieba`，验证：1) 走 schema 重建路径，2) 重建后 body 已 segmented，3) state = `'jieba'`，4) `walkAndResyncFTSBodies` 仅被调用一次。
- **buildFTS5Query 接受 tokenizerFamily 参数**：`buildFTS5Query("中国", 'trigram')` 不带前缀 `*`；`buildFTS5Query("中国", 'porter')` 带前缀 `*`。

## 风险与回滚

| 风险 | 缓解 |
|------|------|
| FTS tokenizer 变更需要重建索引（耗时） | 检测后自动重建，walk-and-segment 单事务；用户可见进度 log |
| 用户切换 embed 模型但维度不同 | 现有 `ensureVecTable` 已有 dimension mismatch 检测，会抛错提示 `qmd embed -f` |
| jieba 在 Windows / Alpine 安装失败 | 列入 `optionalDependencies`，`createRequire` 同步加载捕获异常静默降级；`qmd status` 显示原因 |
| **optionalDependencies 自动安装 jieba 改变默认行为（review-4 #1 关键）** | `QMD_FTS_SEGMENTER` 默认 `identity`；`isJiebaActive()` 同时检查 env 与模块；专用单元测试 Case B 守住 |
| jieba 缺失时静默用字级 token | `QMD_FTS_TOKENIZER=auto` + `QMD_FTS_SEGMENTER=auto` 显式 opt-in；README 提示中文用户配置；`qmd status` 提示 |
| 用户期望切换 tokenizer / 装 jieba 后立即生效（review-3 #2） | tokenizer schema 与 segmenter state 都在 `initStore` 自动 reconcile，**无需 `qmd update`**；`qmd update` 只用于"想重新扫描磁盘内容"场景 |
| trigram 对短 CJK 查询召回率低（review-3 #1） | README 说明 1-2 字 CJK 查询应选 `QMD_FTS_TOKENIZER=auto` + `QMD_FTS_SEGMENTER=auto`（jieba）而非 trigram；`qmd status` 显示当前 tokenizer 让用户自检 |
| `QMD_FTS_TOKENIZER` / `QMD_FTS_SEGMENTER` 设为非法值 | `resolveTokenizer` / `isJiebaActive` 拦截，告警 + fallback 默认 |
| `QMD_EXPAND_PROMPT` 用户模板格式错误 | grammar 约束 + fallback 兜底 |

回滚（review-3 #3）：删除 4 个新源文件 + 还原 7 个修改文件即可。`store_config[fts_segmenter_state]` 这条新增 row **可保留**（旧版本会忽略）；如手动删除，下次启动 `initStore` 会按当前环境自动重建 + walk-resync 一次。`sqlite_master.documents_fts` 在还原后会被自愈逻辑识别为"tokenizer 不一致" → 重建一次回到默认 `porter unicode61`，无破坏性 schema 残留。

## 合并友好性

- 改动集中在 env-var 读取、format 委派、tokenizer 配置、FTS body 写入路径、prompt 构建、status 输出几个明确扩展点。
- 新文件不与上游冲突。
- 任何上游 PR 涉及 `expandQuery` / `formatXForEmbedding` / FTS schema 时，本期改动呈现为额外几行 hook + 几个委派调用，rebase 难度低。

## Review 修订记录

本计划经过九轮 review，共吸纳 50 条意见。

### Round 1（13 条，全部吸纳）

- **#1 同步加载 jieba**：`createRequire` 替换 `await import` + `void preload`，消除竞态。
- **#2 旁路移到 store 层**：避开 `r.text !== query` 过滤，旁路返回 `[lex, vec]`（不含 hyde）。
- **#3 函数名修正**：实际写入路径是 `insertDocument`/`updateDocument`/`updateDocumentTitle`/`findOrMigrateLegacyDocument`。
- **#4 jieba 启用步骤改 `qmd update`**：不再误导用户跑 `qmd embed -f`。
- **#5 tokenizer allowlist**：拒绝任意字符串，防 SQL 注入面与坏 env 崩溃。
- **#6 `auto` 显式 opt-in**：默认仍是 `porter unicode61`，避免英文用户被静默升级到 trigram。
- **#7 sqlite_master 单一真源（仅 tokenizer）**：取消 `store_config.fts_tokenizer`。
- **#8 tokenizer family 解析**：覆盖 `trigram case_sensitive 0` 等合法变体。
- **#9 测试扩展**：默认行为不变断言、tokenizer 切换、`updateDocumentTitle` 不破坏 segmented body。
- **#10 BGE 收紧**：strategy 从 `bge` 改名 `bge-m3`，正则 `bge-?m3`，其他 BGE 变体走 `raw`。
- **#11 `qmd status` 展示**：暴露当前 tokenizer / jieba / embed format / expand 状态。
- **#12 零默认行为变化做成断言**：可执行的契约比文档承诺更可靠。
- **#13 测试 env 隔离**：`beforeEach`/`afterEach` 快照恢复。

### Round 2（5 条，全部吸纳）

- **R2-#1 Segmenter state 自愈（关键）**：`reindexCollection` 对 hash-unchanged 文档不会触发 `syncFtsBody`，导致 jieba 安装后既有库 FTS body 仍是 raw。新增 `store_config[fts_segmenter_state]` + `initStore` 自动 walk-resync。与 R1-#7 不冲突（tokenizer 与 segmenter 是正交事实）。详见设计文档 §6.6。
- **R2-#2 行为契约统一**：CJK 旁路返回值在所有文档（架构图、行为矩阵、测试描述）统一为 `[lex, vec]`（不含 hyde）。
- **R2-#3 模块导入路径**：`shouldSkipLlmExpansion` 实现在 `src/expandPrompt.ts`，`store.ts` 直接 `import './expandPrompt.js'`，避免反向依赖 `llm.ts`。
- **R2-#4 `buildFTS5Query` 签名变更**：从 `(query)` 改为 `(query, tokenizerFamily)`；`searchFTS` 通过 `WeakMap<Database,string>` 缓存 family 注入；自愈重建时 `cache.delete(db)` 失效。
- **R2-#5 `force` 语义拆分**：把 `QMD_EXPAND_LANG` 拆成两个正交概念 —— `resolvePromptLang`（决定 prompt 模板语言）+ `shouldSkipLlmExpansion`（决定是否调 LLM）。`force`/`skip` 不影响 prompt 选择，仍按查询脚本判定，避免之前 `lang === 'zh'` 单分支落入英文模板的 bug。

### 文档内部一致性修订

- 改动概览表中 `bge`/`raw` → `bge-m3`/`raw`；lazy import → 同步 createRequire；llm.ts CJK 检测 → store.ts 短路。
- 推荐配置档位 A 的 `QMD_EMBED_FORMAT=bge` → `bge-m3`（allowlist 值）。
- 档位 B 删除 `qmd update` 误导，改为"安装后下次启动自动 resync"。

### Round 3（9 条，全部吸纳）

- **R3-#1 trigram 短 CJK 查询**：trigram 本质是 3-gram，2 字 `MATCH` 通常无法召回，与去掉 `*` 无关。测试断言改用 `"机器学"`（≥3 字），并显式断言 1-2 字查询不可靠；README/设计 §6.3 加表格列说明短 CJK 查询限制；推荐档位提示用户："对中文短查询应选 `QMD_FTS_TOKENIZER=auto`（jieba），而非 trigram"。
- **R3-#2 风险表与 §6.6 一致性**：`tokenizer 后忘记 qmd update` 的旧表述与"自动 reconcile"自相矛盾，已更新为"`initStore` 自动处理；`qmd update` 仅用于重新扫描磁盘"。
- **R3-#3 回滚说明**：旧文写"不引入 store_config 新行"，与新版引入 `fts_segmenter_state` 冲突。已改为"row 可保留或删除后下次启动自动重建"。
- **R3-#4 重建流程图**：tokenizer mismatch 重建路径的最后一步从裸 `INSERT INTO documents_fts SELECT ...` 改为复用 `walkAndResyncFTSBodies`，让 schema 重建与 segmenter 应用一次完成，避免 schema 变化时 body 仍是 raw、再靠 segmenter-state 触发二次 resync。
- **R3-#5 syncFtsBody 与 trigram 互斥（关键）**：jieba 预切分破坏 trigram 的连续子串匹配能力。新规则：**仅** tokenizer family ∈ {`porter`,`unicode61`,`ascii`} 时做 jieba 预切分；trigram 永远不切。`getEffectiveSegmenterState(tokenizerFamily)` 把 tokenizer family 编码进状态值，避免"jieba 装着但 trigram 下 body 是 raw"被错误标成 `'jieba'`。**注**：ascii 一项随后在 review-4 #4 中移除。
- **R3-medium-1 改动文件计数**：`(5 个)` → `(7 个)`。
- **R3-medium-2 删除"约 50 行"承诺**：reconcile/walk-resync/cache/status 添加后估计偏差大，去掉具体行数。
- **R3-medium-3 测试返回值统一为对象字面量风格**：`[{lex, query}, {vec, query}]` → `[{type:'lex',query},{type:'vec',query}]`。
- **R3-medium-4 status 示例补全**：示例 block 增加 `Segmenter state` 与 `Expand bypass` 两行，与"数据来源"列表对齐。

### Round 4（7 条，全部吸纳，**用户选项 B**：保留 optionalDependencies + 新增 `QMD_FTS_SEGMENTER` 开关）

- **R4-#1 optionalDependencies 与"零默认变化"冲突（关键）**：`@node-rs/jieba` 列入 optionalDependencies 后，Bun/npm 在支持平台默认会自动安装，从而 `isJiebaAvailable()=true`，原方案的"默认行为不变"只在 jieba 未安装时成立。**采纳选项 B**：新增 `QMD_FTS_SEGMENTER=jieba|auto|identity`（默认 `identity`），引入 `isJiebaActive()=isJiebaAvailable() && QMD_FTS_SEGMENTER∈{jieba,auto}`；写入/查询/auto-tokenizer 决策**全部**改读 `isJiebaActive`，让"模块加载"与"特性激活"完全解耦。即便 jieba 自动安装，默认 `QMD_FTS_SEGMENTER=identity` 保证 FTS body 仍是 raw、`store_config[fts_segmenter_state]='identity'`。新增 Case B 单元测试覆盖 "jieba available but no env"。
- **R4-#2 buildFTS5Query 查询侧切分缺守卫（关键）**：`segmentCJK(query)` 当前无条件执行，trigram 下"机器学习"被切成"机器 学习"两个不足 3 字 token，trigram 召回失败。修订入口为 `const input = shouldApplyJiebaSegmentation(family) ? segmentCJK(query) : query`，与 `syncFtsBody` 用同一守卫，索引/查询永远对称。新增"查询侧切分对称"测试断言 mock 调用次数。
- **R4-#3 §6.4 文字 vs 实现不一致**：旧文字写 `syncFtsBody(db, docId)`，实现已改为 `(db, collection, path)`。同步统一。
- **R4-#4 ascii 移出 jieba-compatible**：SQLite ascii tokenizer 对非 ASCII 字符整体作为单 token，jieba 预切分后字符边界处理不可预期。`JIEBA_COMPATIBLE_TOKENIZERS` 收紧为 `{porter, unicode61}`，新增 ascii × jieba=identity 测试守住。
- **R4-medium-1 架构图节点名**：`resolveExpandLang` → 拆为 `shouldSkipLlmExpansion` 与 `resolvePromptLang` 两节点，与新模块名同步。
- **R4-medium-2 默认行为测试 Case B**：`Round 1 #12` 只覆盖 jieba 不可用，新增 jieba 可用但 segmenter 未设的断言，主动暴露 R4-#1 那条矛盾。
- **R4-medium-3 时序图条件**：`jieba 可用 且 body 含 CJK` → `shouldApplyJiebaSegmentation(family) 且 body 含 CJK`，加了 family 维度。

### Round 5（6 条，全部吸纳，**用户选项 A**：限定"零默认变化"作用域为 ASCII）

- **R5-#1 零默认变化 vs CJK 旁路矛盾（关键，用户选 A）**：`QMD_EXPAND_LANG=auto` + CJK 默认旁路 LLM 是默认行为变化，与旧版"未设 env 时 byte-identical"自相矛盾。**选项 A**：把"零默认变化"语义精确化为：① ASCII 路径完全 byte-identical；② FTS body 形态严格不变（review-4 #1）；③ CJK expansion 路径默认有改进性变化（旁路返回原句，从乱码到原句兜底）。新增 §8.1 Case C 把这条改进作为显式契约测试。设计 §2 原则表对应改写。**注（review-7 #3 精确化）**：本条最初写"可由 `=en`/`=force` 显式恢复上游"，但 Round 6 修订后，**只有 `=en` 完整恢复"英文 prompt + 调 LLM"的上游路径**；`=force` 仅保证调 LLM，CJK 查询下会走中文 prompt，不等价上游。详见 R6-#1 与 §4.4 五值矩阵。
- **R5-#2 store_config 缺 row 语义（关键）**：旧伪代码 `currentSegmenter = read ?? "identity"` 在首次 init+target=identity 时不会写 row，导致测试 `store_config[fts_segmenter_state]==='identity'` 失败。修订：① 新增访问器 `readSegmenterState(db)`：缺 row 返回 `'identity'`；② `qmd status` 与全部测试用 `readSegmenterState`，不直接 `readStoreConfig`；③ `reconcileFTSState` 仅在状态实际改变时写 row（默认 identity 用户无需污染 store_config）。
- **R5-#3 resolveTokenizer 测试更新**：旧描述"jieba 在/不在"已不精确（新语义看 `isJiebaActive`）。重写覆盖关键组合：① jieba 装了 + segmenter=identity + tokenizer=auto → trigram；② jieba 装了 + segmenter=jieba/auto + tokenizer=auto → porter unicode61；③ jieba 未装 + segmenter=jieba + tokenizer=auto → trigram。
- **R5-medium-1 §6.6 ascii 残留**：旧文 "在 porter/unicode61/ascii 下自动 resync" 与 review-4 #4 已收紧的兼容集合不一致。改为 "porter/unicode61"。
- **R5-medium-2 短中文推荐缺 segmenter**：仅 `QMD_FTS_TOKENIZER=auto` 在 segmenter 未激活时落到 trigram，与 "auto + jieba 是短中文最佳组合" 矛盾。同步写完整组合 `QMD_FTS_TOKENIZER=auto` + `QMD_FTS_SEGMENTER=auto`/`jieba`。
- **R5-medium-3 isJiebaActive 警告刷屏**：原实现每次写入/查询都解析 env 并可能 `console.warn`。重构为 `resolveSegmenterSetting()` 模块级缓存 + 同一未知值仅 warn 一次（`warnedUnknownValues` Set）；测试导出 `__resetSegmenterSettingCache()`。

### Round 6（2 条，全部吸纳）

- **R6-#1 `QMD_EXPAND_LANG=en` 恢复上游路径不通（高，修代码）**：旧伪代码 `if force return false; if skip return true; auto/en/zh 同分支判定旁路`。这导致设 `=en` 仍会因 CJK + 默认模型旁路 LLM，**无法**恢复"英文 prompt 处理 CJK"的上游行为。设计文档 §8.1 Case C 之前写的"`=en` → mock 被调用且 prompt==英文模板"会失败。修订：把 `en`/`zh`/`force` 都纳入"永不旁路"分支，只有 `skip` 永远旁路、`auto` 在 CJK+默认模型时旁路。新增完整五值语义矩阵表，明确 `auto`/`en`/`zh`/`force`/`skip` 五种取值的 `resolvePromptLang` × `shouldSkipLlmExpansion` 组合行为。
- **R6-#2 §6.4 重复定义 isJiebaActive（中）**：`segmentCJK.ts`（§4.3）已经有带缓存与 warn-once 的版本；§6.4 又写了一份简化版伪代码会让实现者复制粘贴出"无缓存、每次 warn"的实现。删除 §6.4 重复定义，改为 `import { isJiebaActive } from "./segmentCJK.js"` 的引用；只保留 `shouldApplyJiebaSegmentation` 与 `JIEBA_COMPATIBLE_TOKENIZERS` 在该节定义。

### Round 7（3 条，全部吸纳，文档残留清理）

- **R7-#1 §4.4 旧 force/skip 语义表与五值矩阵冲突（高）**：Round 6 修订后该旧表（`auto`/`en`/`zh` 三行都写"CJK + 默认模型 → 旁路"）与 §4.4 末尾的五值矩阵（`en`/`zh`/`force` 永不旁路）和伪代码（`if (raw === "force" || raw === "en" || raw === "zh") return false`）直接冲突，会让实现者照旧表写出错误代码。删除旧表，留指向五值矩阵的引用。
- **R7-#2 `shouldSkipLlmExpansion` 注释过时（中）**：注释写"由 force/skip 控制"，与新版"五值都参与"不符。改为"由 auto/en/zh/force/skip 五值语义决定，详见下方矩阵"，并标注 review-6 #1 的关键修订（`en`/`zh`/`force` 永不旁路）。
- **R7-#3 Round 5 历史说明遗留旧表述（低）**：Round 5 历史里写"可由 `=en`/`=force` 显式恢复上游"，与 Round 6 修订（`=en` 才完整恢复、`=force` 不等价）有歧义。在 Round 5 条目末追加精确化批注，避免读者把它当作"全部吸纳"的最终事实。

### Round 8（3 条，全部吸纳，**用户选 A**：QMD_EXPAND_PROMPT 隐式 opt-in）

- **R8-#1 `QMD_EXPAND_PROMPT` 优先级与默认旁路冲突（高，修代码）**：旧设计里 `QMD_EXPAND_PROMPT` 被宣称为"最高优先级"，但 `shouldSkipLlmExpansion` 完全不看它。当用户设了自定义 prompt 但查询是 CJK + 默认模型时，会先被 auto 默认旁路 → 自定义 prompt 永远不生效。**用户选 A**：在 `shouldSkipLlmExpansion` 加入 `if (process.env.QMD_EXPAND_PROMPT) return false`，把"用户写了 prompt 模板"视为隐式 opt-in，与 `force/en/zh` 同级。优先级显式定义为 `skip > QMD_EXPAND_PROMPT/force/en/zh > auto`。新增专用单元 + 集成测试覆盖 "PROMPT 设了 + auto + CJK + 默认模型 → 调 LLM 用 PROMPT"。
- **R8-#2 行为矩阵旧语义残留（中）**：§5 旧表里 "英文 \| 默认 \| 任意 → 英文模板 + LLM" 不成立（`skip` 会旁路、`zh` 会用中文模板）；"中文 \| 默认 \| force → 可能输出英文翻译" 也错了（review-6 修订后 `force` 在 CJK 走中文模板）。重写整张矩阵让其与 §4.4 五值矩阵**完全同构**，所有 16 种组合显式列出 `resolvePromptLang × shouldSkipLlmExpansion × 结果`，并把 effective generate model 拆为单独子表（默认/自定义两组）。新增 §5.5 "用户意图速查"按用户场景给出推荐 env 配置。
- **R8-#3 `usingDefaultGenerateModel` 仅查 env（中，扩展）**：旧实现 `!process.env.QMD_GENERATE_MODEL` 漏掉 `config.models.generate` 配置文件路径，导致用户在 `~/.qmd/config.yaml` 配中文模型时仍被当作默认模型旁路。修订：① `shouldSkipLlmExpansion` 签名改为 `(query, options?: { usingDefaultGenerateModel?: boolean })`；② `LlamaCpp` 加一个 `usingDefaultGenerateModel(): boolean` public 方法（不污染 `generateModelUri` 字段封装）；③ `store.ts:expandQuery` 调用方先 `getDefaultLlamaCpp().usingDefaultGenerateModel()` 取值再注入。这样 env 与 config.yaml 两条注入路径都能正确触发"自定义模型"分支。**注（review-9 #1 精确化）**：第 ③ 步在伪代码里直接用 `getDefaultLlamaCpp()` 是错的，会绕过既有 `llmOverride` 参数通道。详见 R9-#1。

### Round 9（3 条，全部吸纳，实现路径对齐）

- **R9-#1 `expandQuery` 必须沿用 `llmOverride` 通道（高，修伪代码）**：[`store.ts:expandQuery` L3258](src/store.ts#L3258) 早已有 `llmOverride?: LlamaCpp` 参数，[L3276](src/store.ts#L3276) 内部写 `const llm = llmOverride ?? getDefaultLlamaCpp()`。R8-#3 给的伪代码直接 `getDefaultLlamaCpp()` 绕过了这条注入路径 —— 而 [`createStore` L1646](src/store.ts#L1646) 把 `store.llm`（来自 `config.models.generate`）作为 `llmOverride` 传给 `expandQuery`。如果按旧伪代码实现，API 路径下 `config.models.generate` 配的中文模型仍会被识别为默认模型并旁路。修订：所有伪代码改成 `const llm = llmOverride ?? getDefaultLlamaCpp(); const usingDefault = llm.usingDefaultGenerateModel();`，后续 `llm.expandQuery(...)` 复用同一变量。计划步骤 #10 与设计 §4.4 同步更新。
- **R9-#2 `qmd status` 与 store 层旁路决策对称（中）**：旧文 status 数据来源里 `Expand bypass: shouldSkipLlmExpansion(query)` 没传 `{ usingDefaultGenerateModel }`，会导致 status 在 `config.models.generate` 设了自定义模型时仍按默认模型展示 "→ 旁路"，与 store 层实际不旁路矛盾。修订：status 实现改为 `const llm = store.llm ?? getDefaultLlamaCpp()`，再 `shouldSkipLlmExpansion(query, { usingDefaultGenerateModel: llm.usingDefaultGenerateModel() })`，保证显示与决策永远一致。同时新增 `Generate model` 行展示 effective model uri。
- **R9-#3 常量名 `DEFAULT_GENERATE_MODEL` vs `DEFAULT_GENERATE_MODEL_URI`（低）**：文字段写 "比较 `DEFAULT_GENERATE_MODEL`"，但实际可导出常量是 [`src/llm.ts:209`](src/llm.ts#L209) 的 `DEFAULT_GENERATE_MODEL_URI`（伪代码下面已经用对了）。文字同步为 `DEFAULT_GENERATE_MODEL_URI`，避免实现者照文字 import 不到常量。

### Round 10（3 条，全部吸纳，清残留 + 锁 private 字段访问方式）

- **R10-#1 §363 旧伪代码残留（高）**：设计文档前面 §4.4 头部仍保留一段旧版 `store.ts:expandQuery` 伪代码 —— 只写 `if (shouldSkipLlmExpansion(query))`，不取 `llmOverride ?? getDefaultLlamaCpp()`，也不传 `{ usingDefaultGenerateModel }`。后面 §4.5 的伪代码已经是 review-9 修订后的完整版，但实现者大概率会照抄第一段。修订：把第一段直接替换为完整版（`llm = llmOverride ?? getDefaultLlamaCpp(); usingDefaultGenerateModel = llm.usingDefaultGenerateModel(); shouldSkipLlmExpansion(query, { usingDefaultGenerateModel })`），并在末尾加一句"本节后面 §4.5 还有同一段伪代码 —— 两段保持一致"，明确两处必须同步。
- **R10-#2 §484 文字回退到旧说法（中）**：判断 `usingDefaultGenerateModel` 一段写 "从 `getDefaultLlamaCpp().usingDefaultGenerateModel()` 取真值"，绕过了 `llmOverride`，与 R9-#1 修订相反。修订：拆成两个上下文 —— store 路径 `const llm = llmOverride ?? getDefaultLlamaCpp()`，status 路径 `const llm = store.llm ?? getDefaultLlamaCpp()`，并加粗禁止 `getDefaultLlamaCpp().usingDefaultGenerateModel()`。
- **R10-#3 status 直接读 private `generateModelUri`（中，TS 可见性卡点）**：`qmd status` 数据源写 `(store.llm ?? getDefaultLlamaCpp()).generateModelUri`，但该字段在 `LlamaCpp` 类是 private，TypeScript 编译会失败。计划文档 #10 此前模糊写"或暴露 getter"。本轮锁定方案：在 `LlamaCpp` 类同时新增两个 public 方法 —— `usingDefaultGenerateModel(): boolean`（既有，旁路决策用）+ `getGenerateModelUri(): string`（review-10 #3 新增，status 展示完整 effective URI 用），保持 `generateModelUri` 字段仍为 private 不污染封装。计划步骤 #10/#13 + 设计 §4.4 / §10 同步更新。
