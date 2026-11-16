// How the voice should say words it gets wrong. Applied to the text sent to the voice only: captions and the .srt keep
// the real spelling. Changing an entry re-speaks only the lines that contain it (voice.cjs caches by spoken text).
module.exports = [
  [/\bgitops-deploy\b/gi, 'git-ops deploy'],
  [/\bgitops\b/gi, 'git-ops'],
  [/\bGitea\b/g, 'git-tea'],
  [/\bk8s-deploy\b/g, 'Kubernetes deploy'],
  [/\bno-auth\b/g, 'no auth'],
];
