// PPC-P1-CHECKPOINT-01 · post-regression freeze check.
// Confirms the tree that the regression/build actually exercised is byte-identical
// to the tree stored in the checkpoint. No extraction, no writes.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const manifest = JSON.parse(readFileSync('PPC-P1-CHECKPOINT-01/CHECKPOINT_MANIFEST.json', 'utf8'));

const rows = [];
for (const m of manifest.members) {
  if (!m.repoPath) continue;
  const abs = path.join(ROOT, m.repoPath);
  if (!existsSync(abs)) { rows.push({ path: m.repoPath, verdict: 'MISSING' }); continue; }
  const buf = readFileSync(abs);
  const h = sha256(buf);
  rows.push({
    path: m.repoPath,
    kind: m.kind,
    checkpointSha256: m.sha256,
    currentSha256: h,
    bytes: buf.length,
    verdict: h === m.sha256 && buf.length === m.bytes ? 'IDENTICAL' : 'CHANGED',
  });
}

const changed = rows.filter((r) => r.verdict !== 'IDENTICAL');
const source = rows.filter((r) => r.kind.startsWith('source'));
const result = {
  artifactId: 'FREEZE_CHECK',
  round: 'PPC-P1-CHECKPOINT-01',
  checkedAt: new Date().toISOString(),
  purpose: 'the archive and the regression run must describe the same bytes',
  checkpointManifestSha256: sha256(readFileSync('PPC-P1-CHECKPOINT-01/CHECKPOINT_MANIFEST.json')),
  sourceMembers: source.length,
  sourceIdentical: source.filter((r) => r.verdict === 'IDENTICAL').length,
  evidenceMembers: rows.length - source.length,
  changedOrMissing: changed,
  verdict: changed.length === 0 ? 'PASS' : 'FAIL',
};
writeFileSync('PPC-P1-CHECKPOINT-01/_raw/freeze_check.json', JSON.stringify(result, null, 2) + '\n');
console.log('source members    =', result.sourceMembers, '/ identical', result.sourceIdentical);
console.log('evidence members  =', result.evidenceMembers);
console.log('changed or missing=', changed.length, changed.slice(0, 5));
console.log('VERDICT           =', result.verdict);
