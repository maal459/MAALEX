#!/usr/bin/env node
/**
 * Mint a MAALEX license key from the command line.
 *
 * Usage:
 *   node scripts/issue-license.js --label "Acme Co" --days 365
 *   node scripts/issue-license.js --label "Tester" --days 14 --device <deviceId>
 *   node scripts/issue-license.js --label "Owner" --days 36500   # ~100 years
 *
 * Picks up LICENSE_SECRET from server/.env automatically.
 * Same secret must be in the running server, or keys won't validate.
 */
import 'dotenv/config';
import { issueLicense } from '../src/licenses.js';

const args = process.argv.slice(2);
const opts = { tier: 'full' };

const takeValue = (rawArg, next, alreadyHasInline) => {
  if (alreadyHasInline !== undefined) return [alreadyHasInline, false];
  if (next === undefined) {
    console.error(`Missing value for ${rawArg}`);
    process.exit(1);
  }
  return [next, true];
};

for (let i = 0; i < args.length; i += 1) {
  const raw = args[i];

  // Skip a stray `--` separator if npm/PowerShell passed it through.
  if (raw === '--') continue;

  // Support both `--label Owner` and `--label=Owner` forms.
  const eq = raw.indexOf('=');
  const flag = eq >= 0 ? raw.slice(0, eq) : raw;
  const inline = eq >= 0 ? raw.slice(eq + 1) : undefined;

  switch (flag) {
    case '--label': {
      const [value, consumed] = takeValue(raw, args[i + 1], inline);
      opts.label = value;
      if (consumed) i += 1;
      break;
    }
    case '--days': {
      const [value, consumed] = takeValue(raw, args[i + 1], inline);
      const n = Number(value);
      if (!Number.isFinite(n) || n <= 0) {
        console.error('--days must be a positive number');
        process.exit(1);
      }
      opts.durationMs = n * 24 * 60 * 60 * 1000;
      if (consumed) i += 1;
      break;
    }
    case '--device': {
      const [value, consumed] = takeValue(raw, args[i + 1], inline);
      opts.deviceId = value;
      if (consumed) i += 1;
      break;
    }
    case '--tier': {
      const [value, consumed] = takeValue(raw, args[i + 1], inline);
      opts.tier = value;
      if (consumed) i += 1;
      break;
    }
    case '--help':
    case '-h':
      console.log(
        'Usage: node scripts/issue-license.js [--label "..."] [--days 365] [--device <id>] [--tier full|trial]'
      );
      process.exit(0);
      break;
    default:
      console.error(`Unknown argument: ${raw}`);
      console.error(
        `If you ran via "npm run issue-license -- ...", try calling node directly:`
      );
      console.error(`  node scripts/issue-license.js --label "Owner" --days 36500`);
      process.exit(1);
  }
}

if (!process.env.LICENSE_SECRET) {
  console.warn(
    'WARNING: LICENSE_SECRET not set — using dev-only fallback. Keys minted now will NOT validate against a server with a real secret.\n'
  );
}

const { key, payload } = issueLicense(opts);

console.log('License key:');
console.log('');
console.log(`  ${key}`);
console.log('');
console.log(`Tier:       ${payload.t}`);
console.log(`Issued:     ${new Date(payload.iat).toISOString()}`);
console.log(`Expires:    ${new Date(payload.exp).toISOString()}`);
console.log(`Device:     ${payload.dev === '*' ? 'any (admin key)' : payload.dev}`);
if (payload.lbl) {
  console.log(`Label:      ${payload.lbl}`);
}
