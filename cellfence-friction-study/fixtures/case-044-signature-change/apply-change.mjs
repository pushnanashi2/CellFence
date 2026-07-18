import fs from 'node:fs';
const source = fs.readFileSync('src/parser/public.ts', 'utf8');
const updated = source
  .replace('export function parseInput(input: string): ParseResult {', 'export function parseInput(input: string, options: { trim?: boolean } = {}): ParseResult {')
  .replace('  const value = input.trim();', '  const value = options.trim === false ? input : input.trim();');
fs.writeFileSync('src/parser/public.ts', updated);
