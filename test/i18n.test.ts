/**
 * i18n / multilingual support (CJK FTS, embed formats, expansion bypass).
 */

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/db.js";
import type { Database } from "../src/db.js";
import { detectEmbedFormat } from "../src/embedFormat.js";
import {
  buildExpandPrompt,
  resolvePromptLang,
  shouldSkipLlmExpansion,
} from "../src/expandPrompt.js";
import { containsCJK, isPredominantlyCJK } from "../src/i18n/cjk.js";
import {
  formatQueryForEmbedding,
  formatDocForEmbedding,
  DEFAULT_GENERATE_MODEL_URI,
  type LlamaCpp,
} from "../src/llm.js";
import * as segmentMod from "../src/fts/segmentCJK.js";
import {
  __resetSegmenterSettingCache,
  isJiebaActive,
  isJiebaAvailable,
  segmentCJK,
  shouldApplyJiebaSegmentation,
} from "../src/fts/segmentCJK.js";
import { getTokenizerFamily, resolveTokenizer } from "../src/fts/tokenizer.js";
import {
  buildFTS5Query,
  createStore,
  expandQuery,
  insertContent,
  insertDocument,
  readSegmenterState,
  searchFTS,
  type Store,
} from "../src/store.js";

let envSnapshot: Record<string, string | undefined>;

beforeEach(() => {
  envSnapshot = { ...process.env };
  __resetSegmenterSettingCache();
});

afterEach(() => {
  vi.restoreAllMocks();
  __resetSegmenterSettingCache();
  for (const key of Object.keys(process.env)) {
    if (!(key in envSnapshot)) delete process.env[key];
  }
  for (const key of Object.keys(envSnapshot)) {
    const v = envSnapshot[key];
    if (v === undefined) delete process.env[key];
    else process.env[key] = v;
  }
});

describe("detectEmbedFormat", () => {
  test("URI and env override", () => {
    delete process.env.QMD_EMBED_FORMAT;
    expect(detectEmbedFormat("hf:foo/bge-m3.gguf")).toBe("bge-m3");
    expect(detectEmbedFormat("hf:foo/bge-large-zh.gguf")).toBe("raw");
    expect(detectEmbedFormat("hf:Qwen/Qwen3-Embedding.gguf")).toBe("qwen3");
    expect(detectEmbedFormat("hf:ggml-org/embeddinggemma.gguf")).toBe("gemma");
    process.env.QMD_EMBED_FORMAT = "raw";
    expect(detectEmbedFormat("hf:ggml-org/embeddinggemma.gguf")).toBe("raw");
  });
});

describe("containsCJK / isPredominantlyCJK", () => {
  test("basic", () => {
    expect(containsCJK("")).toBe(false);
    expect(containsCJK("   ")).toBe(false);
    expect(containsCJK("hello")).toBe(false);
    expect(containsCJK("中文")).toBe(true);
    expect(containsCJK("How 中文 work")).toBe(true);
    expect(isPredominantlyCJK("中文")).toBe(true);
    expect(isPredominantlyCJK("How does machine learning work")).toBe(false);
    expect(isPredominantlyCJK("a")).toBe(false);
  });
});

describe("segmentCJK", () => {
  test("identity when no jieba or no CJK", () => {
    expect(segmentCJK("hello")).toBe("hello");
  });
});

describe("resolvePromptLang", () => {
  test("modes", () => {
    delete process.env.QMD_EXPAND_LANG;
    expect(resolvePromptLang("hello")).toBe("en");
    expect(resolvePromptLang("机器学习")).toBe("zh");
    process.env.QMD_EXPAND_LANG = "en";
    expect(resolvePromptLang("机器学习")).toBe("en");
    process.env.QMD_EXPAND_LANG = "zh";
    expect(resolvePromptLang("hello")).toBe("zh");
    process.env.QMD_EXPAND_LANG = "force";
    expect(resolvePromptLang("机器学习")).toBe("zh");
    expect(resolvePromptLang("hi")).toBe("en");
  });
});

describe("shouldSkipLlmExpansion", () => {
  test("matrix", () => {
    delete process.env.QMD_EXPAND_PROMPT;
    delete process.env.QMD_EXPAND_LANG;
    expect(shouldSkipLlmExpansion("hello")).toBe(false);
    expect(shouldSkipLlmExpansion("机器学习")).toBe(true);
    expect(shouldSkipLlmExpansion("机器学习", { usingDefaultGenerateModel: false })).toBe(false);
    process.env.QMD_EXPAND_LANG = "en";
    expect(shouldSkipLlmExpansion("机器学习")).toBe(false);
    process.env.QMD_EXPAND_LANG = "skip";
    expect(shouldSkipLlmExpansion("hello")).toBe(true);
    delete process.env.QMD_EXPAND_LANG;
    process.env.QMD_EXPAND_PROMPT = "x {query}";
    expect(shouldSkipLlmExpansion("机器学习")).toBe(false);
    process.env.QMD_EXPAND_LANG = "skip";
    expect(shouldSkipLlmExpansion("机器学习")).toBe(true);
  });

  test("default usingDefaultGenerateModel", () => {
    delete process.env.QMD_EXPAND_LANG;
    delete process.env.QMD_EXPAND_PROMPT;
    expect(shouldSkipLlmExpansion("机器学习")).toBe(true);
  });
});

describe("buildExpandPrompt", () => {
  test("templates and override", () => {
    delete process.env.QMD_EXPAND_PROMPT;
    delete process.env.QMD_EXPAND_LANG;
    expect(buildExpandPrompt("foo")).toMatch(/Expand this search query: foo/);
    expect(buildExpandPrompt("机器学习")).toMatch(/中文/);
    process.env.QMD_EXPAND_PROMPT = "hi {query}";
    expect(buildExpandPrompt("机器学习")).toBe("hi 机器学习");
    delete process.env.QMD_EXPAND_PROMPT;
    process.env.QMD_EXPAND_LANG = "en";
    expect(buildExpandPrompt("机器学习")).toMatch(/Expand this search query: 机器学习/);
  });
});

describe("resolveTokenizer + isJiebaActive", () => {
  test("allowlist and auto combinations", () => {
    delete process.env.QMD_FTS_TOKENIZER;
    delete process.env.QMD_FTS_SEGMENTER;
    vi.spyOn(segmentMod, "isJiebaActive").mockReturnValue(false);
    expect(resolveTokenizer()).toBe("porter unicode61");
    process.env.QMD_FTS_TOKENIZER = "auto";
    expect(resolveTokenizer()).toBe("trigram");
    vi.spyOn(segmentMod, "isJiebaActive").mockReturnValue(true);
    expect(resolveTokenizer()).toBe("porter unicode61");
    process.env.QMD_FTS_TOKENIZER = "bogus";
    expect(resolveTokenizer()).toBe("porter unicode61");
  });

  test("getTokenizerFamily", () => {
    expect(getTokenizerFamily("porter unicode61")).toBe("porter");
    expect(getTokenizerFamily("trigram case_sensitive 0")).toBe("trigram");
  });
});

describe("isJiebaActive / segmenter cache", () => {
  test("identity default", () => {
    delete process.env.QMD_FTS_SEGMENTER;
    __resetSegmenterSettingCache();
    if (isJiebaAvailable()) {
      expect(isJiebaActive()).toBe(false);
    }
  });

  test("unknown segmenter warns once", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.QMD_FTS_SEGMENTER = "nope";
    __resetSegmenterSettingCache();
    expect(isJiebaActive()).toBe(false);
    expect(isJiebaActive()).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe("default behavior contracts", () => {
  test("Case A: jieba unavailable — ASCII embed + expand prompt", () => {
    vi.spyOn(segmentMod, "isJiebaAvailable").mockReturnValue(false);
    delete process.env.QMD_EMBED_FORMAT;
    expect(formatQueryForEmbedding("foo")).toBe("task: search result | query: foo");
    expect(formatDocForEmbedding("hello", "doc")).toBe("title: doc | text: hello");
    delete process.env.QMD_EXPAND_PROMPT;
    delete process.env.QMD_EXPAND_LANG;
    expect(buildExpandPrompt("foo")).toBe("/no_think Expand this search query: foo");
    expect(shouldSkipLlmExpansion("foo")).toBe(false);
  });

  test("Case B: jieba available but segmenter identity — no segmentation", () => {
    vi.spyOn(segmentMod, "isJiebaAvailable").mockReturnValue(true);
    delete process.env.QMD_FTS_SEGMENTER;
    __resetSegmenterSettingCache();
    expect(isJiebaActive()).toBe(false);
    expect(shouldApplyJiebaSegmentation("porter")).toBe(false);
  });

  test("Case C: CJK bypass", () => {
    delete process.env.QMD_EXPAND_LANG;
    delete process.env.QMD_EXPAND_PROMPT;
    expect(shouldSkipLlmExpansion("机器学习")).toBe(true);
    process.env.QMD_EXPAND_LANG = "en";
    expect(shouldSkipLlmExpansion("机器学习")).toBe(false);
  });
});

describe("buildFTS5Query CJK / trigram", () => {
  test("trigram does not star CJK; porter does", () => {
    expect(buildFTS5Query("中国", "trigram")).toBe('"中国"');
    expect(buildFTS5Query("中国", "porter")).toBe('"中国"*');
  });
});

describe("expandQuery (store) with mock LLM", () => {
  test("CJK + default model bypasses LLM", async () => {
    const mockLlm = {
      expandQuery: vi.fn(),
      usingDefaultGenerateModel: () => true,
      getGenerateModelUri: () => DEFAULT_GENERATE_MODEL_URI,
    } as unknown as LlamaCpp;
    const db = openDatabase(":memory:");
    const out = await expandQuery("机器学习", undefined, db, undefined, mockLlm);
    expect(mockLlm.expandQuery).not.toHaveBeenCalled();
    expect(out).toEqual([
      { type: "lex", query: "机器学习" },
      { type: "vec", query: "机器学习" },
    ]);
    db.close();
  });

  test("CJK + custom model calls LLM", async () => {
    const mockLlm = {
      expandQuery: vi.fn().mockResolvedValue([
        { type: "lex" as const, text: "lex1" },
        { type: "vec" as const, text: "vec1" },
      ]),
      usingDefaultGenerateModel: () => false,
      getGenerateModelUri: () => "hf:custom/model.gguf",
    } as unknown as LlamaCpp;
    const db = openDatabase(":memory:");
    db.exec(`
      CREATE TABLE llm_cache (hash TEXT PRIMARY KEY, result TEXT NOT NULL, created_at TEXT NOT NULL);
    `);
    await expandQuery("机器学习", undefined, db, undefined, mockLlm);
    expect(mockLlm.expandQuery).toHaveBeenCalled();
    db.close();
  });
});

describe("SQL FTS integration", () => {
  let dir: string;
  let dbPath: string;
  let store: Store;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "qmd-i18n-"));
    dbPath = join(dir, "t.sqlite");
  });

  afterEach(async () => {
    try {
      store?.close();
    } catch {
      //
    }
    try {
      await unlink(dbPath);
    } catch {
      //
    }
    await rm(dir, { recursive: true, force: true });
  });

  test("trigram Chinese search needs ≥3 chars", async () => {
    process.env.QMD_FTS_TOKENIZER = "trigram";
    delete process.env.QMD_FTS_SEGMENTER;
    __resetSegmenterSettingCache();
    store = createStore(dbPath);
    const db = store.db;
    const now = new Date().toISOString();
    const body = "机器学习是人工智能的一个分支";
    const h = "a".repeat(64);
    insertContent(db, h, body, now);
    insertDocument(db, "c", "p.md", "t", h, now, now);
    const hit = searchFTS(db, "机器学", 10, "c");
    expect(hit.length).toBeGreaterThan(0);
    const miss = searchFTS(db, "机器", 10, "c");
    expect(miss.length).toBe(0);
  });

  test("readSegmenterState defaults to identity", async () => {
    delete process.env.QMD_FTS_TOKENIZER;
    delete process.env.QMD_FTS_SEGMENTER;
    __resetSegmenterSettingCache();
    store = createStore(dbPath);
    expect(readSegmenterState(store.db)).toBe("identity");
  });
});
