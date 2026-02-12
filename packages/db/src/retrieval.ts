import { createHash } from "node:crypto";

export const tokenizeRetrievalText = (value: string): string[] =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9_\-/\.\s]+/g, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2)
    .slice(0, 160);

export const buildHash64Embedding = (value: string): number[] => {
  const dims = new Array<number>(64).fill(0);
  for (const token of tokenizeRetrievalText(value)) {
    const digest = createHash("sha256").update(token).digest();
    const index = digest[0]! % dims.length;
    dims[index]! += 1;
  }
  const norm = Math.sqrt(dims.reduce((acc, v) => acc + v * v, 0));
  if (norm === 0) return dims;
  return dims.map((v) => Number((v / norm).toFixed(6)));
};
