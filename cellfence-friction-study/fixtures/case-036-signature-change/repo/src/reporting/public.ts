import { parseInput } from '../parser/public';

export function formatReport(input: string): string {
  const parsed = parseInput(input);
  return parsed.tokens.join(',');
}
