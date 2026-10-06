import { getKeywords } from "../services/watch-config.js";

export function findMatchingKeywords(text: string): string[] {
  const lowerText = text.toLowerCase();
  return getKeywords().filter((keyword) =>
    lowerText.includes(keyword.toLowerCase())
  );
}
