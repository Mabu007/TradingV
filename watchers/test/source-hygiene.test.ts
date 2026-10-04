/**
 * Source hygiene, checked by the test suite so it cannot regress quietly.
 *
 * A NUL byte once sat in a source file in this repository. It is the
 * kind of thing that survives review -- the file looks correct in every
 * viewer that renders it, and fails only in a tool that reads the bytes
 * strictly. It cost a confusing debugging session, so the check is now
 * automated rather than remembered.
 *
 * Two classes are checked: control characters that should never appear in
 * a text source file, and line endings, so a file cannot quietly become
 * CRLF-only on one platform and break a byte-exact fixture comparison
 * somewhere else.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');

/** Directories that are generated, vendored, or binary. */
const SKIP_DIRECTORIES = new Set([
  'node_modules', '.git', 'dist', 'build', 'coverage', '.venv', 'venv',
  '__pycache__', '.wrangler', '.cache', '.next', 'target',
]);

/** Text source extensions. Binary fixtures are deliberately not listed. */
const TEXT_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.css', '.html',
  '.json', '.jsonc', '.md', '.toml', '.yml', '.yaml', '.sh', '.py',
]);

/** Tab, line feed, carriage return. Everything else below 0x20 is a defect. */
const ALLOWED_CONTROL_BYTES = new Set([0x09, 0x0a, 0x0d]);

function* sourceFiles(directory: string): Generator<string> {
  for (const entry of readdirSync(directory)) {
    if (SKIP_DIRECTORIES.has(entry)) continue;
    const full = join(directory, entry);
    if (statSync(full).isDirectory()) {
      yield* sourceFiles(full);
    } else if (TEXT_EXTENSIONS.has(extname(entry))) {
      yield full;
    }
  }
}

describe('source hygiene', () => {
  it('no source file contains a control character', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(REPO_ROOT)) {
      const bytes = readFileSync(file);
      for (let index = 0; index < bytes.length; index += 1) {
        const byte = bytes[index];
        if (byte === 0x7f || (byte < 0x20 && !ALLOWED_CONTROL_BYTES.has(byte))) {
          offenders.push(`${relative(REPO_ROOT, file)} at byte ${index} (0x${byte.toString(16)})`);
          break;
        }
      }
    }
    // A NUL in particular renders invisibly and breaks strict parsers.
    expect(offenders).toEqual([]);
  });

  it('no source file mixes line endings', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(REPO_ROOT)) {
      const text = readFileSync(file, 'utf8');
      const hasCrlf = text.includes('\r\n');
      const bareLf = /(?<!\r)\n/.test(text);
      if (hasCrlf && bareLf) offenders.push(relative(REPO_ROOT, file));
    }
    expect(offenders).toEqual([]);
  });

  it('no source file is empty', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(REPO_ROOT)) {
      if (readFileSync(file).length === 0) offenders.push(relative(REPO_ROOT, file));
    }
    expect(offenders).toEqual([]);
  });
});
