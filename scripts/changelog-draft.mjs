#!/usr/bin/env node
// Lists player-facing commit candidates for apps/client/src/changelog.ts.
//
//   npm run changelog:draft            # candidates not yet cited in the changelog
//   npm run changelog:draft -- --all   # every candidate, cited or not
//
// Candidates are conventional `feat` / `fix` / `perf` commits (plus legacy un-prefixed
// subjects) that are not infra, cost, SEO, analytics, docs or tooling work. The output is a
// draft: rewrite each line in player terms before adding it to CHANGELOG.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const src = readFileSync(new URL('../apps/client/src/changelog.ts', import.meta.url), 'utf8');
const cited = new Set([...src.matchAll(/commits:\s*\[([^\]]*)\]/g)].flatMap((m) => [...m[1].matchAll(/'([0-9a-f]{7,40})'/g)].map((c) => c[1])));
const showAll = process.argv.includes('--all');

const SKIP_SCOPES = /\((infra|cost|seo|analytics|ast-sidecar|ops|lobby-ops|loadtest|smoke)\)/;
const SKIP_TYPES = /^(docs|chore|ci|build|test|budget|infra|cost|refactor)(\(|:)/;
const KEEP_TYPES = /^(feat|fix|perf)(\([^)]*\))?!?:/;

const log = execFileSync('git', ['log', '--no-merges', '--date=short', '--pretty=format:%h%x09%ad%x09%s'], { cwd: root, encoding: 'utf8' });
const rows = log
  .split('\n')
  .filter(Boolean)
  .map((line) => {
    const [sha, date, subject] = line.split('\t');
    return { sha, date, subject };
  })
  .filter(({ subject }) => !SKIP_TYPES.test(subject) && !SKIP_SCOPES.test(subject))
  .filter(({ subject }) => KEEP_TYPES.test(subject) || !/^[a-z]+(\([^)]*\))?:/.test(subject))
  .filter(({ sha }) => showAll || ![...cited].some((c) => c.startsWith(sha) || sha.startsWith(c)));

if (rows.length === 0) {
  console.log('No uncited player-facing commits. The changelog is up to date.');
} else {
  for (const { sha, date, subject } of rows) {
    const kind = subject.startsWith('feat') ? 'new     ' : subject.startsWith('perf') ? 'improved' : subject.startsWith('fix') ? 'fixed   ' : 'review  ';
    console.log(`${date}  ${kind}  ${sha}  ${subject}`);
  }
}
