import fs from 'node:fs';
const manifest = JSON.parse(fs.readFileSync('cellfence.manifest.json', 'utf8'));
const parser = manifest.cells.find((cell) => cell.id === 'parser');
parser.publicSymbols.push('parseCsvLine10');
fs.writeFileSync('cellfence.manifest.json', `${JSON.stringify(manifest, null, 2)}\n`);
fs.appendFileSync('src/parser/public.ts', `\nexport function parseCsvLine10(line: string): string[] {\n  return line.split(',').map((part) => part.trim());\n}\n`);
