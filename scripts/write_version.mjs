#!/usr/bin/env node
/**
 * Stamp a release version into package.json and plugin.json.
 *
 * The committed version in both files is a `0.0.0` placeholder — the real
 * version comes from the release tag and is written here by CI immediately
 * before the plugin zip is built. Decky reads the version out of plugin.json,
 * so the zip must carry the tag's version rather than whatever is committed.
 *
 * Usage:
 *   node scripts/write_version.mjs --tag v1.2.3   # write 1.2.3
 *   node scripts/write_version.mjs 1.2.3          # same, bare version
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const TAG_RE = /^v?(\d+\.\d+\.\d+)$/;
const TARGETS = ['package.json', 'plugin.json'];

function parseArgs(argv) {
  const args = argv.slice(2);
  const tagIndex = args.indexOf('--tag');
  const raw = tagIndex === -1 ? args[0] : args[tagIndex + 1];
  if (!raw) {
    throw new Error('Usage: write_version.mjs [--tag] vX.Y.Z');
  }
  const match = TAG_RE.exec(raw.trim());
  if (!match) {
    throw new Error(`Expected a vX.Y.Z version, got '${raw}'`);
  }
  return match[1];
}

function stamp(repoRoot, version) {
  for (const name of TARGETS) {
    const path = join(repoRoot, name);
    const data = JSON.parse(readFileSync(path, 'utf8'));
    if (!('version' in data)) {
      throw new Error(`${name} has no 'version' field to stamp`);
    }
    data.version = version;
    writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    console.log(`${name}: version -> ${version}`);
  }
}

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
stamp(repoRoot, parseArgs(process.argv));
