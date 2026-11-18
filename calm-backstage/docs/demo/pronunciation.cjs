// How the voice should say words it gets wrong. Applied to the text sent to the voice only: captions and the .srt keep
// the real spelling. Same format as calm-hub-deploy-extension/docs/demo/pronunciation.cjs, which voice.cjs expects.
module.exports = [
  // Capitals read as letters or a foreign word ("colm"): the ordinary word is said right.
  [/\bCALM\b/g, 'calm'],
  [/\bdraw\.io\b/g, 'draw dot I O'],
  [/\bC4\b/g, 'C four'],
  [/\bREADME\b/g, 'read-me'],
  [/\bcomposed-of\b/g, 'composed of'],
  [/\bTODO\b/g, 'to-do'],
  [/\bUI\b/g, 'U I'],
];
