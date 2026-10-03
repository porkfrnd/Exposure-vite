/**
 * Structural guard against conditional-hook crashes.
 *
 * React requires the same hooks in the same order on every render. A component
 * that returns early (`if (!open) return null`) before calling some of its
 * hooks changes its hook count between renders. React then throws
 * "Rendered more hooks than during the previous render" and unmounts the entire
 * application, not just the offending component.
 *
 * That is not hypothetical: BreakdownDrawer had three useState calls and a
 * useCallback below its early return, so clicking "View Scientific Breakdown"
 * took the whole app down. There is no DOM test environment here, so this
 * asserts the source shape instead — which is what actually caused the bug.
 *
 * Only statements at the top level of a component body count. These files are
 * formatted with two-space indentation, so exactly two leading spaces means
 * "directly in the component body". Anything deeper is inside a nested helper,
 * where an early return is perfectly legal.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const UI_DIR = join(process.cwd(), 'src/ui');

/** A statement that sits directly in a component body. */
const TOP_LEVEL = /^ {2}\S/;

/**
 * Every hook React counts. Bare `use` is not one.
 *
 * The tail is deliberately loose. Type arguments can nest arbitrarily
 * (`useState<Set<SectionId>>(`), so this only asserts that a hook name on the
 * line is followed by a call on the same line. Overly clever generic parsing
 * silently stopped matching `useState<Set<SectionId>>(`, which is exactly the
 * kind of quiet gap that makes a guard useless.
 */
const HOOK_CALL = /\buse(State|Effect|Memo|Callback|Ref|Reducer)\b[^\n]*\(/;

/** `return null` directly in a component body, guarded or not. */
const EARLY_NULL_RETURN = /^ {2}(if\s*\(.*\)\s*)?return\s+null\b/;

function tsxFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...tsxFiles(full));
    else if (entry.endsWith('.tsx')) out.push(full);
  }
  return out;
}

/** Split a file into top-level `function` blocks so one cannot mask another. */
function componentBlocks(source: string): Array<{ name: string; lines: string[] }> {
  const out: Array<{ name: string; lines: string[] }> = [];
  let current: { name: string; lines: string[] } | null = null;

  for (const line of source.split('\n')) {
    const decl = /^(?:export\s+)?function\s+([A-Za-z0-9_]+)/.exec(line);
    if (decl) {
      if (current) out.push(current);
      current = { name: decl[1], lines: [line] };
    } else if (current) {
      current.lines.push(line);
    }
  }
  if (current) out.push(current);
  return out;
}

const files = tsxFiles(UI_DIR);

describe('UI has components to check', () => {
  it('finds the tsx sources', () => {
    expect(files.length).toBeGreaterThan(3);
  });
});

describe('no component returns early before calling a hook', () => {
  for (const file of files) {
    const rel = file.slice(process.cwd().length + 1);

    for (const { name, lines } of componentBlocks(readFileSync(file, 'utf8'))) {
      it(`${rel} :: ${name}`, () => {
        const firstNull = lines.findIndex((l) => EARLY_NULL_RETURN.test(l));
        if (firstNull === -1) return; // no early return, nothing to violate

        const lateHook = lines.findIndex(
          (l, i) => i > firstNull && TOP_LEVEL.test(l) && HOOK_CALL.test(l),
        );

        expect(
          lateHook === -1 ? null : lines[lateHook].trim(),
          `${rel}: ${name}() returns null at line ${firstNull + 1} but calls a hook at ` +
            `line ${lateHook + 1}. React throws "Rendered more hooks than during the ` +
            `previous render" and unmounts the entire app. Move every hook above the ` +
            `early return.`,
        ).toBeNull();
      });
    }
  }
});

describe('BreakdownDrawer regression', () => {
  const block = componentBlocks(
    readFileSync(join(UI_DIR, 'cards/BreakdownDrawer.tsx'), 'utf8'),
  ).find((b) => b.name === 'BreakdownDrawer');

  it('exists', () => {
    expect(block).toBeDefined();
  });

  it('calls all eight of its hooks before the closed-render early return', () => {
    const lines = block!.lines;
    const firstNull = lines.findIndex((l) => EARLY_NULL_RETURN.test(l));
    const hookLines = lines.filter((l) => TOP_LEVEL.test(l) && HOOK_CALL.test(l));

    // useState(openSections), useRef, useEffect x2, useState x3, useCallback
    expect(hookLines.length).toBeGreaterThanOrEqual(8);
    expect(
      lines.slice(firstNull).some((l) => TOP_LEVEL.test(l) && HOOK_CALL.test(l)),
      'a hook still sits below the early return in BreakdownDrawer',
    ).toBe(false);
  });

  it('still has the early return that avoids rendering a closed drawer', () => {
    expect(block!.lines.some((l) => EARLY_NULL_RETURN.test(l))).toBe(true);
  });
});
