import { pool } from "./db";

/**
 * Puz Royale win credit — same pattern as FIFA's payouts.ts (itself Pong
 * solo's recordWin made transactional): ONE database transaction, so a crash
 * mid-credit can never leave a win "claimed" without the money landing.
 *
 * Dedupe key: game_wins.stripe_payment_id = 'puz:<match room id>' (that
 * column has a plain UNIQUE index). `ON CONFLICT DO NOTHING` makes the claim
 * exactly-once per match: a retry, a reconnect, or two end-of-match paths
 * racing all hit the same key, and concurrent claimers block on the unique
 * index until the first commits. The 'puz:' prefix keeps these keys disjoint
 * from real Stripe payment_intent ids and from FIFA's 'fifa:' keys.
 *
 * The amount is the prize FROZEN at match start (prize.ts, from the real
 * accounts that started) — passed in as dollars, written as an exact numeric.
 */
export const PUZ_GAME = "puz";
const PUZ_MATCH_NUMBER = 0; // NOT NULL in game_wins/ledger/match_results; Puz has no Pong-style cycle position

export function puzCreditKey(matchId: string) {
  return `puz:${matchId}`;
}

export type CreditOutcome =
  | { status: "credited"; amount: string; balanceBefore: string; balanceAfter: string }
  | { status: "already_credited" };

export async function creditPuzWin(opts: {
  matchId: string;
  winnerUserId: number;
  loserUserIds: number[];
  amount: string;        // dollars, e.g. "18.00" — the frozen prize
  startedPlayers: number;
}): Promise<CreditOutcome> {
  const key = puzCreditKey(opts.matchId);
  const tier = `${opts.startedPlayers}P`;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // 1. Claim the match. If this key exists, the win was already credited.
    const claim = await client.query(
      `INSERT INTO game_wins (player_id, game, match_number, stripe_payment_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (stripe_payment_id) DO NOTHING RETURNING id`,
      [opts.winnerUserId, PUZ_GAME, PUZ_MATCH_NUMBER, key]
    );
    if (!claim.rowCount) {
      await client.query("ROLLBACK");
      return { status: "already_credited" };
    }

    // 2. Lock the winner's row, then credit. COALESCE: balance is nullable.
    const before = await client.query(`SELECT COALESCE(balance, 0) AS balance FROM users WHERE id = $1 FOR UPDATE`, [opts.winnerUserId]);
    if (!before.rowCount) throw new Error(`winner user ${opts.winnerUserId} not found`);
    const after = await client.query(
      `UPDATE users SET balance = COALESCE(balance, 0) + $2::numeric WHERE id = $1 RETURNING balance`,
      [opts.winnerUserId, opts.amount]
    );

    // 3. Ledger row — same shape recordWin / FIFA write.
    await client.query(
      `INSERT INTO balance_ledger (player_id, game, match_number, reason, delta, balance_before, balance_after, stripe_payment_id)
       VALUES ($1, $2, $3, 'win_credit', $4::numeric, $5, $6, $7)`,
      [opts.winnerUserId, PUZ_GAME, PUZ_MATCH_NUMBER, opts.amount, before.rows[0].balance, after.rows[0].balance, key]
    );

    // 4. Match audit rows: the credited win, and a loss for every other account
    // that played. Never block a credit (the game_wins claim is the real guard).
    await client.query(
      `INSERT INTO match_results (player_id, game, stripe_payment_id, outcome, tier, match_number, credited)
       VALUES ($1, $2, $3, 'win', $4, $5, true) ON CONFLICT (stripe_payment_id) DO NOTHING`,
      [opts.winnerUserId, PUZ_GAME, key, tier, PUZ_MATCH_NUMBER]
    );
    for (const loserId of opts.loserUserIds) {
      await client.query(
        `INSERT INTO match_results (player_id, game, stripe_payment_id, outcome, tier, match_number, credited)
         VALUES ($1, $2, $3, 'loss', $4, $5, false) ON CONFLICT (stripe_payment_id) DO NOTHING`,
        [loserId, PUZ_GAME, `${key}:loss:${loserId}`, tier, PUZ_MATCH_NUMBER]
      );
    }

    await client.query("COMMIT");
    return {
      status: "credited",
      amount: opts.amount,
      balanceBefore: Number(before.rows[0].balance).toFixed(2),
      balanceAfter: Number(after.rows[0].balance).toFixed(2),
    };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}
