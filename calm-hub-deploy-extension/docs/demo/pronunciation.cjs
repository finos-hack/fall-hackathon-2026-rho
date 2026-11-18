// How the voice should say words it gets wrong. Applied to the text sent to the voice only: captions and the .srt keep
// the real spelling. Changing an entry re-speaks only the lines that contain it (voice.cjs caches by spoken text).
module.exports = [
  // "fin" + "oss" (fintech open source), not "fee-nos" or "fy-nos".
  [/\bFINOS\b/g, 'Fin-oss'],
  // British "root", not American "rowt": Route, route, routes.
  [/\b([Rr])oute(s?)\b/g, '$1oot$2'],
  [/\bgitops-deploy\b/gi, 'git-ops deploy'],
  [/\bgitops\b/gi, 'git-ops'],
  [/\bGitea\b/g, 'git-tea'],
  [/\bk8s-deploy\b/g, 'Kubernetes deploy'],
  [/\bno-auth\b/g, 'no auth'],
  [/\bPostgreSQL\b/g, 'Postgres'],
  // Jim's picks from the pronunciation options (2026-11-18): "sequel-lite", "Jay-son", and "red" where read is past.
  [/\bSQLite\b/g, 'sequel-lite'],
  [/\bJSON\b/g, 'Jay-son'],
  [/\bread (at start-up|back)\b/g, 'red $1'],
  [/\bread-only\b/g, 'reed-only'],
  [/\bRead-only\b/g, 'Reed-only'],
  [/\bplatform-connector\b/g, 'platform connector'],
  // Versions as Jim says them (2026-11-18): 1.0.23 is "1 point oh point 23" (twenty-three), not digit by digit.
  [/\b(\d+)\.(\d+)\.(\d+)\b/g, (_, major, minor, patch) => `${major} point ${minor === '0' ? 'oh' : minor} point ${patch}`],
];
