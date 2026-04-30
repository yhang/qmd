const CJK_RANGE =
  /[\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF\uFF66-\uFF9F]/u;

export function containsCJK(text: string): boolean {
  return CJK_RANGE.test(text);
}

export function isPredominantlyCJK(text: string, threshold = 0.3): boolean {
  if (!text) return false;
  const cjk = (text.match(new RegExp(CJK_RANGE.source, "gu")) ?? []).length;
  const totalNonSpace = (text.match(/\S/gu) ?? []).length;
  if (totalNonSpace === 0) return false;
  return cjk / totalNonSpace >= threshold;
}
