// Export the 24 frozen human roots into fixtures/real_human/ as first-class
// real-position fixtures.
//
// Contract:
//   * SOURCE is the frozen production fixture and is never modified
//     (src/game/ai/__tests__/fixtures/ppcId01-human-roots.json).
//   * Every exported file carries provenance = REAL_HUMAN_REPLAY, the source
//     file + line, the source sha256 and the canonical snapshot sha256, so a
//     reader can re-derive the position without trusting this round.
//   * Nothing here is synthesized. Synthetic positions live in fixtures/
//     synthetic/ and are marked SYNTHETIC there.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';

const SRC = 'src/game/ai/__tests__/fixtures/ppcId01-human-roots.json';
const OUT = 'PPC-CAT-STRATEGY-01/fixtures/real_human';

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const srcBuf = readFileSync(SRC);
const srcSha = sha256(srcBuf);
const records = JSON.parse(srcBuf.toString('utf8'));

// Recursively key-sorted JSON — the canonical form the frozen snapshots were
// hashed with (P1-ID-01). Re-implemented here so the export is self-checking.
const canonicalJson = (v) => {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(v).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(',')}}`;
};

mkdirSync(OUT, { recursive: true });

const index = [];
for (const rec of records) {
  const canon = sha256(canonicalJson(rec.state));
  const ok = canon === rec.canonicalSnapshotSha256;
  const doc = {
    id: rec.id,
    provenance: 'REAL_HUMAN_REPLAY',
    note: 'Extracted byte-for-byte from the frozen human-root fixture. Not synthesized, not edited.',
    source: {
      file: rec.file,
      line: rec.line,
      fixture: SRC,
      fixtureSha256: srcSha,
      sourceSha256: rec.sourceSha256,
    },
    canonicalSnapshotSha256: rec.canonicalSnapshotSha256,
    exportCanonicalSha256: canon,
    canonicalMatch: ok,
    state: rec.state,
  };
  const name = `${rec.id}.json`;
  writeFileSync(`${OUT}/${name}`, JSON.stringify(doc, null, 2));
  index.push({
    id: rec.id,
    file: name,
    humanSource: rec.file,
    humanLine: rec.line,
    sourceSha256: rec.sourceSha256,
    canonicalSnapshotSha256: rec.canonicalSnapshotSha256,
    canonicalMatch: ok,
  });
}

const allMatch = index.every((r) => r.canonicalMatch);
writeFileSync(`${OUT}/INDEX.json`, JSON.stringify({
  generatedBy: 'probe/export_real_human.mjs',
  provenance: 'REAL_HUMAN_REPLAY',
  separation: 'Only REAL positions live in this directory. SYNTHETIC positions live in fixtures/synthetic/.',
  sourceFixture: SRC,
  sourceFixtureSha256: srcSha,
  count: index.length,
  allCanonicalMatch: allMatch,
  roots: index,
}, null, 2));

console.log(`exported ${index.length} roots, allCanonicalMatch=${allMatch}`);
if (!allMatch) {
  console.error('canonical mismatch:', index.filter((r) => !r.canonicalMatch).map((r) => r.id));
  process.exit(1);
}
