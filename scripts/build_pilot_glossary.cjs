const fs = require("fs");

const SOURCE_PDF =
  "Transport Canada AC 100-001 Issue 07 (Glossary for Pilots and Air Traffic Services Personnel)";

const normalizeLine = (line) =>
  line
    .replace(/\t/g, " ")
    .replace(/[“”]/g, '"')
    .replace(/[’]/g, "'")
    .replace(/[–—]/g, "-")
    .replace(/…/g, "...")
    .replace(/°/g, " deg")
    .replace(/±/g, "+/-")
    .replace(/¼/g, "1/4")
    .replace(/½/g, "1/2")
    .replace(/¾/g, "3/4")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const stripParentheticals = (term) => term.replace(/\s*\([^)]*\)\s*/g, " ").trim();

const normalizeTerm = (raw) =>
  String(raw || "")
    .toLowerCase()
    .replace(/[“”"]/g, "")
    .replace(/[’']/g, "'")
    .replace(/[–—]/g, "-")
    .replace(/…/g, "...")
    .replace(/°/g, " deg")
    .replace(/±/g, "+/-")
    .replace(/\./g, "")
    .replace(/\s+/g, " ")
    .trim();

const isSkipLine = (line) =>
  /^--\s*\d+\s*of\s*\d+\s*--/i.test(line) ||
  /^Glossary for Pilots/i.test(line) ||
  /^\d{4}-\d{2}-\d{2}/.test(line) ||
  /^AC\s+\d+/i.test(line) ||
  /^\d+\.\d+/.test(line) ||
  /^[A-Z]\.?\s*\d+\s*of\s*\d+/i.test(line);

const isDefMarker = (line) =>
  /^\(\d+\)/.test(line) ||
  /^\([a-z]\)/i.test(line) ||
  /^•/.test(line) ||
  /^Fr:\s*/i.test(line) ||
  /^Note[:]?/i.test(line) ||
  /:/.test(line) ||
  /^(Canada|ICAO|NATO|U\.S\.|DND|NAV\s+CANADA|U\.K\.)\b/i.test(line);

const isDefStart = (line) =>
  isDefMarker(line) || /^(A|An|The|To|This|These|That)\s+/i.test(line);

const isTermLine = (line, nextLine) => {
  if (!line) return false;
  if (isSkipLine(line)) return false;
  if (isDefMarker(line)) return false;
  if (/^[A-Z]\s*-\s*[A-Z]\s*$/i.test(line)) return false;
  if (/^-\s*$/.test(line)) return false;

  if (/[,;]$/.test(line)) return false;

  const words = line.split(/\s+/);
  if (words.length > 14) return false;

  const connectorEnd = /\b(and|or|which|that|if|for|to|with|when|in|by|from|of)$/i;
  if (connectorEnd.test(words[words.length - 1])) return false;

  if (/^[a-z]/.test(line) && words.length > 8) return false;

  const endsWithPeriod = /\.$/.test(line);
  if (endsWithPeriod) {
    const abbr = /^[A-Z0-9][A-Z0-9./-]*$/;
    if (!abbr.test(line)) return false;
  }

  if (!nextLine) return false;
  return isDefStart(nextLine);
};

const readLines = (path) => fs.readFileSync(path, "utf8").split(/\r?\n/);

const glossaryLines = readLines("glossary.txt").map(normalizeLine);

const startIdx = glossaryLines.findIndex(
  (line, i) => i > 300 && /^4\.2/.test(line) && /A/.test(line)
);
const endIdx = glossaryLines.findIndex((line, i) => i > startIdx && /^5\.0/.test(line));

if (startIdx === -1 || endIdx === -1) {
  throw new Error("Failed to locate glossary section in glossary.txt");
}

const slice = glossaryLines.slice(startIdx + 1, endIdx);
const entries = new Map();

const addEntry = (term, definition) => {
  const normalized = normalizeTerm(term);
  if (!normalized || !definition) return;
  const existing = entries.get(normalized);
  if (!existing) {
    entries.set(normalized, definition);
    return;
  }
  if (existing.includes(definition)) return;
  entries.set(normalized, `${existing} / ${definition}`);
};

let currentTerm = "";
let defLines = [];

const flush = () => {
  if (!currentTerm) return;
  const definition = defLines.join(" ").replace(/\s+/g, " ").trim();
  if (definition) {
    addEntry(currentTerm, definition);
    const stripped = stripParentheticals(currentTerm);
    if (stripped && stripped !== currentTerm) addEntry(stripped, definition);
  }
  currentTerm = "";
  defLines = [];
};

const nextNonEmpty = (arr, idx) => {
  for (let i = idx + 1; i < arr.length; i++) {
    const line = arr[i];
    if (!line || isSkipLine(line)) continue;
    return line;
  }
  return "";
};

for (let i = 0; i < slice.length; i++) {
  const line = slice[i];
  if (!line) continue;
  if (isSkipLine(line)) continue;

  const nextLine = nextNonEmpty(slice, i);
  if (isTermLine(line, nextLine)) {
    flush();
    currentTerm = line.replace(/^[\"“”]+|[\"“”]+$/g, "").trim();
    continue;
  }

  if (!currentTerm) continue;
  if (/^Fr:\s*/i.test(line)) continue;
  if (/^•/.test(line)) continue;

  const clean = line
    .replace(/^[\"“”]+|[\"“”]+$/g, "")
    .replace(/\s*Fr\s*:\s*.*$/i, "")
    .trim();
  if (clean) defLines.push(clean);
}

flush();

const embeddedTermRegex =
  /(?:^|\.\s+)([a-z][a-z0-9/'() -]{1,60})\s+(A|An|Any|The|To|This|These|That)\b/;

for (const [term, definition] of entries) {
  let currentDef = definition;
  let updated = false;

  while (true) {
    const match = embeddedTermRegex.exec(currentDef);
    if (!match || match.index === 0) break;

    const offset = match[0].startsWith(". ") ? 2 : 0;
    const termStart = match.index + offset;
    const foundTerm = match[1].trim();
    if (foundTerm.length < 2) break;

    const defStart = termStart + foundTerm.length;
    const nextDef = currentDef.slice(defStart).trim();
    if (nextDef) addEntry(foundTerm, nextDef);

    currentDef = currentDef.slice(0, termStart).trim().replace(/[.\\s]+$/, "");
    updated = true;
  }

  if (updated) entries.set(term, currentDef);
}

const entriesArray = Array.from(entries.entries()).sort((a, b) => a[0].localeCompare(b[0]));

const payload = {
  source: SOURCE_PDF,
  generatedAt: new Date().toISOString(),
  entries: Object.fromEntries(entriesArray),
};

fs.writeFileSync(
  "functions/api/pilot_glossary.json",
  JSON.stringify(payload, null, 2)
);

const jsHeader = `// Generated from ${payload.source} on ${payload.generatedAt}\n`;
const jsBody = `export const PILOT_GLOSSARY = new Map(${JSON.stringify(entriesArray, null, 2)});\n`;
fs.writeFileSync("functions/api/pilot_glossary.js", jsHeader + jsBody);

console.log(`entries: ${entriesArray.length}`);
