/**
 * G0.4F-2A.4 — Board piece-alignment UI structural regression.
 *
 * Asserts the Board.tsx layout invariants that keep the mouse/cat percentage
 * overlays aligned with the grid-cell centers:
 *   - cellItemStyle (entity layer) is a FULL-CELL ABSOLUTE layer (inset:0,
 *     flex-centered, out of normal flow) so it never alters grid-track sizing;
 *   - ghost underlay stays absolute (inset ~6%, zIndex 0);
 *   - entity layer zIndex 1, piece overlay zIndex 10;
 *   - pieceStyle geometry is the UNCHANGED percent math (top/left/width/height
 *     from r/rows, c/cols) with NO pixel-offset hacks (no translateY,
 *     marginTop, top-pixel corrections).
 *
 * No component-test infra exists, so this is a source-level structural
 * assertion (allowed by the task), supplemented by the human screenshot retest.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const src = readFileSync('src/components/Board.tsx', 'utf8');

function styleBlock(name: string): string {
  // extract `const <name>: React.CSSProperties = { ... };`
  const m = src.match(new RegExp(`const ${name}: React\\.CSSProperties = \\{([\\s\\S]*?)\\};`));
  expect(m, `${name} style must exist`).toBeTruthy();
  return m![1];
}

describe('G0.4F-2A.4 Board piece-alignment structural regression', () => {
  it('A: cellItemStyle is position absolute', () => {
    const b = styleBlock('cellItemStyle');
    expect(b).toMatch(/position:\s*'absolute'/);
  });

  it('B: cellItemStyle has inset: 0 (full cell containing block)', () => {
    const b = styleBlock('cellItemStyle');
    expect(b).toMatch(/inset:\s*0/);
  });

  it('C: cellItemStyle centers its content (flex center)', () => {
    const b = styleBlock('cellItemStyle');
    expect(b).toMatch(/display:\s*'flex'/);
    expect(b).toMatch(/alignItems:\s*'center'/);
    expect(b).toMatch(/justifyContent:\s*'center'/);
  });

  it('D: ghost underlay stays absolute with zIndex 0', () => {
    const g = styleBlock('ghostUnderlayStyle');
    expect(g).toMatch(/position:\s*'absolute'/);
    expect(g).toMatch(/zIndex:\s*0/);
  });

  it('E: entity layer zIndex is 1', () => {
    const b = styleBlock('cellItemStyle');
    expect(b).toMatch(/zIndex:\s*1/);
  });

  it('F: piece overlay zIndex is 10', () => {
    // pieceStyle is a function, extract its body
    const m = src.match(/const pieceStyle\s*=\s*\(r:\s*number,\s*c:\s*number\)\s*:\s*React\.CSSProperties\s*=>\s*\(\{([\s\S]*?)\}\)/);
    expect(m, 'pieceStyle function must exist').toBeTruthy();
    expect(m![1]).toMatch(/zIndex:\s*10/);
  });

  it('G: pieceStyle keeps percent geometry (top/left/width/height from r/rows, c/cols)', () => {
    const m = src.match(/const pieceStyle\s*=\s*\(r:\s*number,\s*c:\s*number\)\s*:\s*React\.CSSProperties\s*=>\s*\(\{([\s\S]*?)\}\)/);
    expect(m, 'pieceStyle function must exist').toBeTruthy();
    const body = m![1];
    expect(body).toMatch(/width:\s*`\$\{100 \/ boardCols\}%/);
    expect(body).toMatch(/height:\s*`\$\{100 \/ boardRows\}%/);
    expect(body).toMatch(/left:\s*`\$\{\(c \/ boardCols\) \* 100\}%/);
    expect(body).toMatch(/top:\s*`\$\{\(r \/ boardRows\) \* 100\}%/);
  });

  it('H: no pixel-offset hacks in pieceStyle (no translateY / marginTop / top-pixel correction)', () => {
    const m = src.match(/const pieceStyle\s*=\s*\(r:\s*number,\s*c:\s*number\)\s*:\s*React\.CSSProperties\s*=>\s*\(\{([\s\S]*?)\}\)/);
    expect(m, 'pieceStyle function must exist').toBeTruthy();
    const body = m![1];
    expect(body).not.toMatch(/translateY|translate\(|marginTop|paddingTop|top:\s*['"`]*[\d]/);
  });

  it('both desktop and narrow board renders reuse renderCell (single source)', () => {
    // There are two `renderCell(cell, r, c)` call sites (desktop + mobile/narrow).
    const calls = src.match(/renderCell\(cell,\s*r,\s*c\)/g) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(2);
  });

  it('ghost render is an underlay sibling BEFORE the cellItem entity layer', () => {
    // In the renderCell JSX, the ghost block (`style={ghostUnderlayStyle}`)
    // must appear before the entity block (`style={cellItemStyle}`) so z-index
    // stacking keeps ghost under the entities. Check the USAGE sites, not the
    // style definitions.
    const ghostUse = src.indexOf('style={ghostUnderlayStyle}');
    const itemUse = src.indexOf('style={cellItemStyle}');
    expect(ghostUse).toBeGreaterThan(-1);
    expect(itemUse).toBeGreaterThan(ghostUse);
  });
});
