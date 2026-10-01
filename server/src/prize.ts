/**
 * THE Puz Royale payout — what a win actually pays. Dollars. Used by PuzRoom
 * (from the number of real accounts that started the match, frozen at start).
 * Nothing a client sends ever feeds into it.
 *
 *   n = 3  → $5
 *   else   → $2 × (n − 1), floored at $0
 *            e.g. 1→$0, 2→$2, 4→$6, 5→$8, 6→$10, 8→$14, 10→$18, 16→$30
 *
 * There is no minimum player count for payouts (testing); a solo start pays
 * $0 by the formula itself.
 */
export function puzPrize(startedPlayers: number): number {
  const n = Math.floor(Number(startedPlayers) || 0);
  if (n === 3) return 5;
  return Math.max(0, 2 * (n - 1));
}

/**
 * What the LOBBY shows — the original ladder, unchanged (incl. "min 3"):
 * under 3 players it shows no prize. Display only; puzPrize decides payouts.
 */
export function puzLobbyDisplayPrize(players: number): number {
  const n = Math.floor(Number(players) || 0);
  if (n < 3) return 0;
  return puzPrize(n);
}

/** Exact numeric literal for SQL (e.g. "18.00"), never a JS float. */
export function prizeAmountString(dollars: number): string {
  return dollars.toFixed(2);
}
