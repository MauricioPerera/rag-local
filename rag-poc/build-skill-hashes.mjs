import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

const ROOT = process.cwd();
const llmsPath = join(ROOT, 'llms.txt');

// Compute sha256 for every skills/<name>/tool.js, keyed by its tool path.
const shaByToolPath = {};
const skillDirs = readdirSync(join(ROOT, 'skills'), { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name);
for (const dir of skillDirs) {
  const toolPath = '/skills/' + dir + '/tool.js';
  const file = join(ROOT, 'skills', dir, 'tool.js');
  let content;
  try {
    content = readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  shaByToolPath[toolPath] = createHash('sha256').update(content).digest('hex');
}

// Rewrite the tool_sha256 field of each llms.txt entry, matching by tool path.
const llms = readFileSync(llmsPath, 'utf8');
const lines = llms.split('\n');
const out = lines.map((line) => {
  const m = line.match(/^(.*<!-- skill: )(\{.*\})( -->)$/);
  if (!m) return line;
  let meta;
  try {
    meta = JSON.parse(m[2]);
  } catch {
    return line;
  }
  const sha = shaByToolPath[meta.tool];
  if (!sha) return line;
  meta.tool_sha256 = sha;
  return m[1] + JSON.stringify(meta) + m[3];
});
writeFileSync(llmsPath, out.join('\n'));