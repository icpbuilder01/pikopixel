// A classic r/place-flavored 18-color palette. Purely a display concern --
// the backend only ever stores/validates the index (0-17), see
// place/src/main.mo's own PALETTE_SIZE comment (kept in lockstep with the
// length of this array). Orange and teal fill the two remaining gaps
// (between red/yellow, and between green/blue) left after #be0039 dark
// red replaced the original #ffa800 orange slot. Shared by the canvas and
// the sponsored slots' pixel-art images.
export const PALETTE = [
  "#ffffff", "#d4d7d9", "#898d90", "#000000",
  "#be0039", "#ff4500", "#ffa800", "#ffd635",
  "#00a368", "#7eed56", "#009eaa", "#2450a4",
  "#3690ea", "#51e9f4", "#811e9f", "#b44ac0",
  "#ff99aa", "#6d482f",
];
