import fs from "node:fs";

export function readJsonFile(filePath: string): unknown {
  const text = fs.readFileSync(filePath, "utf8");
  const duplicateKeys = duplicateJsonKeys(text);
  if (duplicateKeys.length > 0) throw new Error(`duplicate JSON keys are not allowed: ${duplicateKeys.join(", ")}`);
  return JSON.parse(text);
}

function duplicateJsonKeys(text: string): string[] {
  type Frame = { kind: "object"; keys: Set<string>; expectingKey: boolean } | { kind: "array" };
  const frames: Frame[] = [];
  const duplicates = new Set<string>();

  function skipWhitespace(index: number): number {
    let cursor = index;
    while (cursor < text.length && /\s/.test(text[cursor])) cursor += 1;
    return cursor;
  }

  function readString(index: number): { value: string; end: number } {
    let cursor = index + 1;
    while (cursor < text.length) {
      const character = text[cursor];
      if (character === "\\") {
        cursor += 2;
        continue;
      }
      if (character === "\"") {
        const rawString = text.slice(index, cursor + 1);
        try {
          return { value: JSON.parse(rawString) as string, end: cursor + 1 };
        } catch {
          return { value: rawString, end: cursor + 1 };
        }
      }
      cursor += 1;
    }
    return { value: text.slice(index, cursor), end: cursor };
  }

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === "\"") {
      const stringValue = readString(index);
      const current = frames[frames.length - 1];
      const colonIndex = skipWhitespace(stringValue.end);
      if (current?.kind === "object" && current.expectingKey && text[colonIndex] === ":") {
        if (current.keys.has(stringValue.value)) duplicates.add(stringValue.value);
        current.keys.add(stringValue.value);
        current.expectingKey = false;
      }
      index = stringValue.end - 1;
      continue;
    }
    if (character === "{") {
      frames.push({ kind: "object", keys: new Set<string>(), expectingKey: true });
    } else if (character === "[") {
      frames.push({ kind: "array" });
    } else if (character === "}" || character === "]") {
      frames.pop();
    } else if (character === ",") {
      const current = frames[frames.length - 1];
      if (current?.kind === "object") current.expectingKey = true;
    }
  }
  return [...duplicates].sort((left, right) => left.localeCompare(right));
}
