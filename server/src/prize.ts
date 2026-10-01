/**
 * THE Puz Royale prize ladder — the single source of truth for what a win
 * pays. Dollars. Used by PuzRoom to pay (from the number of real accounts
 * that started the match, frozen at start) and by PuzGameLobby to display.
 * Nothing a client sends ever feeds into it.
 *
 *   n < 3  → $0 (no prize: under-3-player games never pay, incl. SOLO_TEST)
 *   n = 3  → $5
 *   n ≥ 4  → $2 × (n − 1)      e.g. 4→$6, 5→$8, 6→$10, 8→$14, 10→$18, 16→$30
 *
 * Same formula the lobby has always shown (rooms.html prizeForCount) and the
 * tenten.run homepage card lists (3p $5 · 4p $6 · 5p $8 · 6p $10 · 8p $14 · 10p $18).
 */
export function puzPrize(startedPlayers: number): number {
  const n = Math.floor(Number(startedPlayers) || 0);
  if (n < 3) return 0;
  if (n === 3) return 5;
  return 2 * (n - 1);
}

/** Exact numeric literal for SQL (e.g. "18.00"), never a JS float. */
export function prizeAmountString(dollars: number): string {
  return dollars.toFixed(2);
}
