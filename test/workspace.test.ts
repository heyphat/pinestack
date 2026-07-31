/**
 * Workspace-wide invariants — the ones RELEASING.md currently relies on a human
 * remembering.
 *
 * These live at the repo root rather than in a package because they are
 * statements about the workspace as a whole, and because no single package owns
 * them. They read the manifests off disk and are self-maintaining: a fourth
 * package is covered the moment it appears under `packages/`, with no edit here.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(import.meta.path), '..');
const PACKAGES = join(ROOT, 'packages');

interface Manifest {
  name?: string;
  version?: string;
  bin?: Record<string, string>;
  scripts?: Record<string, string>;
}

/** Every workspace package, in directory order. */
function workspacePackages(): { dir: string; manifest: Manifest }[] {
  return readdirSync(PACKAGES, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      dir: entry.name,
      manifest: JSON.parse(
        readFileSync(join(PACKAGES, entry.name, 'package.json'), 'utf8'),
      ) as Manifest,
    }));
}

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

describe('workspace packages version in lockstep (RELEASING.md §Versioning)', () => {
  test('there is more than one package, or this test proves nothing', () => {
    expect(workspacePackages().length).toBeGreaterThan(1);
  });

  test('every package carries the same version', () => {
    const packages = workspacePackages();
    const versions = new Map<string, string[]>();
    for (const { dir, manifest } of packages) {
      const version = manifest.version ?? '(missing)';
      versions.set(version, [...(versions.get(version) ?? []), dir]);
    }

    // One distinct version across the workspace. The failure message names who
    // disagrees, because "expected 1, got 2" would not tell you which manifest
    // to edit — and a forgotten bump means that binary ships the old number.
    const summary = [...versions.entries()]
      .map(([version, dirs]) => `${version}: ${dirs.join(', ')}`)
      .join(' | ');
    expect(summary).toBe(
      `${packages[0]!.manifest.version}: ${packages.map((p) => p.dir).join(', ')}`,
    );
  });

  test('every version is valid semver', () => {
    for (const { dir, manifest } of workspacePackages()) {
      expect(`${dir} ${manifest.version}`).toMatch(new RegExp(`^${dir} ${SEMVER.source.slice(1)}`));
    }
  });
});

describe('a package that ships a binary can be built and released', () => {
  test('every `bin` entry has a matching build:bin script', () => {
    // pinetop originally declared `bin` with no way to compile it, so there was
    // no path from the source tree to a release artifact. This is that gap.
    for (const { dir, manifest } of workspacePackages()) {
      if (manifest.bin == null) continue;
      expect(`${dir}: ${manifest.scripts?.['build:bin'] ?? 'MISSING build:bin'}`).toContain(
        'build-bin.ts',
      );
    }
  });

  test('every `bin` name is also a product the build script knows', () => {
    // The build script's PRODUCTS table is read as text on purpose: importing
    // scripts/build-bin.ts would execute it and start a real compile.
    const buildScript = readFileSync(join(ROOT, 'scripts/build-bin.ts'), 'utf8');
    const products = new Set([...buildScript.matchAll(/^ {2}(\w+): \{$/gm)].map((m) => m[1]!));
    expect(products.size).toBeGreaterThan(0);

    for (const { dir, manifest } of workspacePackages()) {
      for (const binName of Object.keys(manifest.bin ?? {})) {
        expect(`${dir} → ${binName} in PRODUCTS: ${products.has(binName)}`).toBe(
          `${dir} → ${binName} in PRODUCTS: true`,
        );
      }
    }
  });

  test('every build product resolves to a real package directory', () => {
    const buildScript = readFileSync(join(ROOT, 'scripts/build-bin.ts'), 'utf8');
    const products = [...buildScript.matchAll(/^ {2}(\w+): \{$/gm)].map((m) => m[1]!);
    const dirs = new Set(workspacePackages().map((p) => p.dir));
    for (const product of products) {
      expect(`${product}: ${dirs.has(product)}`).toBe(`${product}: true`);
    }
  });
});
