import { KEYWORDS } from "../config.js";

export function findMatchingKeywords(text: string): string[] {
  const lowerText = text.toLowerCase();
  return KEYWORDS.filter((keyword) =>
    lowerText.includes(keyword.toLowerCase())
  );
}
