#!/usr/bin/env node
/*
 * Fails when demo, test or documentation content looks like real
 * infrastructure: private IPv4 ranges, or account and machine names that could
 * be somebody's.
 *
 * The rule is simple: every address in this repository is either loopback (the
 * local API binds there), link-local (a reserved range the metadata code filters
 * on purpose), or from a documentation / benchmarking block nobody can route:
 *
 *   192.0.2.0/24      RFC 5737 "TEST-NET-1"
 *   198.51.100.0/24   RFC 5737 "TEST-NET-2"
 *   203.0.113.0/24    RFC 5737 "TEST-NET-3"
 *   198.18.0.0/15     RFC 2544 benchmarking
 *   100.64.0.0/10     RFC 6598 shared address space (carrier NAT)
 *
 * Names follow the same idea: `demo`, `alice`, `bob`, `root`, `DEMO-PC`,
 * `node-01`, `core-node-01`, `edge-gw-01`, `*.example.com`.
 *
 * Usage: node scripts/check-demo-data.cjs   (npm run check:data)
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.md', '.json', '.yml', '.css', '.html']);

/** Ranges that cannot be anyone's machine, or are the app's own loopback. */
const ALLOWED_IPV4 = [
  /^127\./,
  /^169\.254\./,
  /^192\.0\.2\./,
  /^198\.51\.100\./,
  /^203\.0\.113\./,
  /^198\.1[89]\./,
  /^100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
  /^0\.0\.0\.0$/,
  /^255\.255\.255\.255$/,
];

/**
 * Only private ranges are reported. A version string such as `24.2.0.0` or
 * `5.15.167.4` also parses as four octets, and chasing those was how this check
 * first flagged its own dependencies; nobody's infrastructure hides behind
 * `10.x`, `172.16-31.x` or `192.168.x` unless somebody put it there.
 */
const PRIVATE_IPV4 = [/^10\./, /^172\.(?:1[6-9]|2\d|3[01])\./, /^192\.168\./];

/**
 * Machine names whose shape alone gives them away: a role word plus an index, or
 * a corporate suffix. None of these belongs to one person, so they travel with
 * the repository, and none of them matches its own source line.
 */
const FORBIDDEN_SHAPES = [
  /WORKSTATION-\d+/i,
  /devlab-node\d+/i,
  /bastion-core-\d+/i,
  /bastion-edge-\d+/i,
  /\.corp\.internal/i,
  /\bomioc@/i,
];

/**
 * The account and machine names that once leaked out of this repository are
 * deliberately absent from this file. A digest of a short name is one dictionary
 * pass away from the name, so storing one is the same leak in another encoding.
 * They live in an untracked local file instead - `demo-deny.local.json` at the
 * repository root, a JSON array of names, matched case-insensitively against
 * every alphanumeric run on a line. Without that file the name rule is exactly
 * the shapes above.
 */
const LOCAL_DENY_FILE = 'demo-deny.local.json';

const IPV4 = /\b(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\b/g;

/**
 * Only what git tracks.
 *
 * A document or a note that is ignored (this repository ignores `/docs/`) is the
 * author's own business: its examples may well be real, and rewriting them is
 * not this check's job. What gets published is what git tracks.
 */
function collect() {
  const listed = spawnSync('git', ['ls-files', '-z'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (listed.status !== 0 || typeof listed.stdout !== 'string') {
    console.error('check:data needs a git work tree (git ls-files failed).');
    process.exit(2);
  }
  return listed.stdout
    .split('\0')
    .filter(Boolean)
    .filter((file) => EXTENSIONS.has(path.extname(file).toLowerCase()))
    .filter((file) => fs.existsSync(file));
}

function isAllowedIp(value) {
  const octets = value.split('.').map(Number);
  if (octets.some((octet) => !Number.isInteger(octet) || octet > 255)) return true; // not an address
  if (!PRIVATE_IPV4.some((pattern) => pattern.test(value))) return true; // a version string, or public
  return ALLOWED_IPV4.some((pattern) => pattern.test(value));
}

/**
 * The optional local denylist. Nothing here is versioned: the names it holds are
 * the ones that must never reach a tracked file, and writing them down in this
 * repository - in any encoding - is how they left in the first place.
 */
function loadLocalDeny() {
  if (!fs.existsSync(LOCAL_DENY_FILE)) return new Set();
  let parsed;
  try {
    // Editors on Windows write a BOM; JSON.parse rejects it and the failure
    // would look like a broken script rather than a broken list.
    const raw = fs.readFileSync(LOCAL_DENY_FILE, 'utf8').replace(/^\uFEFF/, '');
    parsed = JSON.parse(raw);
  } catch (error) {
    console.error(`check:data could not read ${LOCAL_DENY_FILE}: ${error.message}`);
    process.exit(2);
  }
  if (!Array.isArray(parsed)) {
    console.error(`check:data expects ${LOCAL_DENY_FILE} to be a JSON array of names.`);
    process.exit(2);
  }
  return new Set(
    parsed
      .filter((name) => typeof name === 'string' && name.trim() !== '')
      .map((name) => name.trim().toLowerCase()),
  );
}

const localDeny = loadLocalDeny();
const problems = [];
for (const file of collect()) {
  const text = fs.readFileSync(file, 'utf8');
  text.split(/\r?\n/).forEach((line, index) => {
    const at = index + 1;
    // Version numbers such as 1.2.3.4 in a dependency tree are not addresses;
    // only flag the value when it parses as one and lands in a private range.
    for (const match of line.matchAll(IPV4)) {
      if (!isAllowedIp(match[1])) problems.push(`${file}:${at}: ip ${match[1]}`);
    }
    for (const pattern of FORBIDDEN_SHAPES) {
      if (pattern.test(line)) problems.push(`${file}:${at}: name ${pattern}`);
    }
    for (const token of line.split(/[^A-Za-z0-9]+/)) {
      if (!localDeny.has(token.toLowerCase())) continue;
      problems.push(`${file}:${at}: name listed in ${LOCAL_DENY_FILE}`);
      break;
    }
  });
}

if (problems.length > 0) {
  console.error('Demo/test data must not look like real infrastructure:\n');
  for (const problem of problems) console.error(`  ${problem}`);
  console.error(
    `\n${problems.length} problem(s). Use documentation ranges (192.0.2.x, 198.51.100.x, 203.0.113.x) ` +
      'and obviously synthetic names.',
  );
  process.exit(1);
}

console.log(`Demo/test data is clean: ${collect().length} files checked.`);
