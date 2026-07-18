import fs from 'node:fs';
fs.mkdirSync('src/logger', { recursive: true });
fs.writeFileSync('src/logger/public.ts', "export function logReport10(message: string): string {\n  return '[report] ' + message;\n}\n");
const manifest = JSON.parse(fs.readFileSync('cellfence.manifest.json', 'utf8'));
manifest.cells.push({
  id: 'logger',
  ownedPaths: ['src/logger/**'],
  publicEntry: 'src/logger/public.ts',
  publicSymbols: ['logReport10'],
  consumes: [],
  producesArtifacts: [],
});
const reporting = manifest.cells.find((cell) => cell.id === 'reporting');
reporting.consumes.push({ cell: 'logger' });
fs.writeFileSync('cellfence.manifest.json', `${JSON.stringify(manifest, null, 2)}\n`);
const reportingSource = fs.readFileSync('src/reporting/public.ts', 'utf8');
fs.writeFileSync('src/reporting/public.ts', `import { logReport10 } from '../logger/public';\n${reportingSource.replace('return parsed.tokens.join(\',\');', 'return logReport10(parsed.tokens.join(\',\'));')}`);
