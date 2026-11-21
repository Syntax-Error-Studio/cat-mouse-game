// PPC-G6T2-SELECTION-CAUSE-01 / G2 — generator for the ISOLATED observed search copy.
//
// The ONLY permitted differences between src/game/ai/expectiminimax.ts and
// probe/expectiminimax_observed.ts are the three edits below:
//   1. relative imports rewritten to point at the production files;
//   2. one import of the observation sink;
//   3. two inert hook calls (guarded by ctx.capturePlan && ply <= 3) that
//      record child values and the decided action for the first four plies.
// The parity test re-applies transform() to the production source and requires
// byte equality with the copy, so a hand edit is impossible.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SOURCE_REL = 'src/game/ai/expectiminimax.ts';
const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(HERE, '..', '..');
const TARGET = join(HERE, 'expectiminimax_observed.ts');
const META = join(HERE, 'expectiminimax_observed.meta.json');

const sha256 = (b) => createHash('sha256').update(b).digest('hex');

export function transform(src) {
  const nl = src.includes('\r\n') ? '\r\n' : '\n';
  const lines = src.split(/\r?\n/);
  let lastImport = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^import\b/.test(lines[i])) lastImport = i;
  }
  if (lastImport < 0) throw new Error('no top-level import found');

  const out = [];
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    if (/^import\b/.test(line)) {
      line = line
        .replace(/'\.\.\/engine'/g, "'../../src/game/engine'")
        .replace(/'\.\.\/types'/g, "'../../src/game/types'")
        .replace(/'\.\.\/config'/g, "'../../src/game/config'")
        .replace(/from '\.\/([A-Za-z0-9_]+)'/g, "from '../../src/game/ai/$1'");
    }
    out.push(line);
    if (i === lastImport) out.push("import { observeCandidate, observeChoice } from './observe';");
  }

  let text = out.join(nl);

  const anchorCand = [
    '      bound: childRes.bound,',
    '    };',
    '    if (ctx.capturePlan && ply === 0) {',
  ].join(nl);
  const hookCand = [
    '      bound: childRes.bound,',
    '    };',
    '    if (ctx.capturePlan && ply <= 3) { observeCandidate(key, depthTurns, ply, pa.action, pa.originalIndex, candidate); }',
    '    if (ctx.capturePlan && ply === 0) {',
  ].join(nl);
  if (!text.includes(anchorCand)) throw new Error('candidate anchor not found');
  if (text.split(anchorCand).length !== 2) throw new Error('candidate anchor not unique');
  text = text.replace(anchorCand, hookCand);

  const anchorChoice = [
    '  if (ctx.capturePlan && bestAction !== null) {',
    '    ctx.planBranches.set(stateKey(state), bestAction);',
    '  }',
  ].join(nl);
  const hookChoice = [
    '  if (ctx.capturePlan && bestAction !== null) {',
    '    ctx.planBranches.set(stateKey(state), bestAction);',
    '  }',
    '  if (ctx.capturePlan && ply <= 3) { observeChoice(key, depthTurns, ply, bestAction, result); }',
  ].join(nl);
  if (!text.includes(anchorChoice)) throw new Error('choice anchor not found');
  if (text.split(anchorChoice).length !== 2) throw new Error('choice anchor not unique');
  text = text.replace(anchorChoice, hookChoice);

  return { text, nl };
}

export function buildMeta(srcText, srcSha, trackedText, trackedSha) {
  const srcLines = srcText.split(/\r?\n/);
  const rewrittenImports = [];
  srcLines.forEach((l, i) => {
    if (/^import\b/.test(l) && (l.includes("'../") || /from '\.\//.test(l))) {
      rewrittenImports.push({ line: i + 1, source: l });
    }
  });
  const hookLines = [];
  trackedText.split(/\r?\n/).forEach((l, i) => {
    if (l.includes('observeCandidate(') || l.includes('observeChoice(') || l.includes("from './observe'")) {
      hookLines.push({ line: i + 1, source: l });
    }
  });
  return {
    round: 'PPC-G6T2-SELECTION-CAUSE-01',
    phase: 'G2_OBSERVED_COPY_META',
    sourcePath: SOURCE_REL,
    sourceSha256Raw: srcSha,
    observedPath: 'PPC-G6T2-SELECTION-CAUSE-01/probe/expectiminimax_observed.ts',
    observedSha256Raw: trackedSha,
    transformation: {
      importsRewritten: rewrittenImports,
      addedImport: "import { observeCandidate, observeChoice } from './observe';",
      hookLines,
      rule: 'no other line may differ; verified by re-applying transform() to the production source',
    },
    productionSourceModified: false,
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const srcBuf = readFileSync(join(ROOT, SOURCE_REL));
  const srcText = srcBuf.toString('utf8');
  const { text } = transform(srcText);
  mkdirSync(dirname(TARGET), { recursive: true });
  writeFileSync(TARGET, text, 'utf8');
  const trackedBuf = readFileSync(TARGET);
  const meta = buildMeta(srcText, sha256(srcBuf), text, sha256(trackedBuf));
  writeFileSync(META, `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
  console.log(`wrote ${TARGET}`);
  console.log(`source  ${meta.sourceSha256Raw}`);
  console.log(`observed ${meta.observedSha256Raw}`);
  console.log(`hook lines: ${meta.transformation.hookLines.length}`);
}