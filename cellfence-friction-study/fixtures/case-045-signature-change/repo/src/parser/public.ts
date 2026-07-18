import { tokenize } from './internal/tokenizer';

export type ParseResult = { value: string; tokens: string[] };

export function parseInput(input: string): ParseResult {
  const value = input.trim();
  return { value, tokens: tokenize(value) };
}
