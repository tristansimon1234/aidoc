import { supabase } from '../../shared/db/supabase.client.js'
import { DatabaseError } from '../../shared/middleware/error.middleware.js'

export interface UserCredits {
  userId: string
  balance: number
  totalBought: number
  stripeCustomerId: string | null
  updatedAt: Date
}

interface UserCreditsRow {
  user_id: string
  balance: number
  total_bought: number
  stripe_customer_id: string | null
  updated_at: string
}

function mapRow(row: UserCreditsRow): UserCredits {
  return {
    userId: row.user_id,
    balance: row.balance,
    totalBought: row.total_bought,
    stripeCustomerId: row.stripe_customer_id,
    updatedAt: new Date(row.updated_at),
  }
}

/** Read the user's credit row. The trigger on auth.users seeds this so the
 *  row always exists for an authed user — never returns null in practice,
 *  but the type allows it just in case (e.g. a row was manually deleted). */
export async function findCreditsForUser(userId: string): Promise<UserCredits | null> {
  const { data, error } = await supabase
    .from('user_credits')
    .select('*')
    .eq('user_id', userId)
    .maybeSingle()
  if (error) throw new DatabaseError(error.message)
  return data ? mapRow(data as UserCreditsRow) : null
}

/** Atomically decrement the user's balance by 1. Returns the new balance,
 *  or null if the user had no credits (no decrement happens in that case).
 *
 *  The `balance >= 1` predicate inside the UPDATE guarantees we never go
 *  negative under concurrency — two parallel spend calls can't both win
 *  on a last credit, the second sees 0 rows affected and gets null back. */
export async function spendCredit(userId: string): Promise<number | null> {
  const { data, error } = await supabase
    .rpc('spend_credit', { p_user_id: userId })
  if (error) {
    // If the RPC doesn't exist (fresh dev DB before the migration that
    // ships it), fall back to a non-atomic select-then-update so the
    // app boots. The migration installs the proper version.
    if (error.code === '42883') {
      return spendCreditFallback(userId)
    }
    throw new DatabaseError(error.message)
  }
  return typeof data === 'number' ? data : null
}

async function spendCreditFallback(userId: string): Promise<number | null> {
  const current = await findCreditsForUser(userId)
  if (!current || current.balance < 1) return null
  const { data, error } = await supabase
    .from('user_credits')
    .update({ balance: current.balance - 1 })
    .eq('user_id', userId)
    .gte('balance', 1) // safety net against the race
    .select('balance')
    .single()
  if (error) {
    if (error.code === 'PGRST116') return null
    throw new DatabaseError(error.message)
  }
  return (data as { balance: number }).balance
}

/** Refund a credit — used when a generation pipeline fails after the spend.
 *  Best-effort: callers wrap in try/catch and continue if it fails, since
 *  the user-facing error matters more than the internal accounting. */
export async function refundCredit(userId: string): Promise<void> {
  const { error } = await supabase.rpc('refund_credit', { p_user_id: userId })
  if (error) {
    if (error.code === '42883') {
      // Fallback for the same fresh-dev case.
      const current = await findCreditsForUser(userId)
      if (!current) return
      const { error: upErr } = await supabase
        .from('user_credits')
        .update({ balance: current.balance + 1 })
        .eq('user_id', userId)
      if (upErr) throw new DatabaseError(upErr.message)
      return
    }
    throw new DatabaseError(error.message)
  }
}

/** Top up after a successful Stripe credit-pack purchase. Server-side only
 *  — called from the webhook handler after Stripe signature verification. */
export async function addCredits(userId: string, amount: number, stripeCustomerId?: string): Promise<void> {
  if (amount <= 0) throw new DatabaseError('addCredits called with non-positive amount')
  const current = await findCreditsForUser(userId)
  if (!current) {
    // Bootstrap row should already exist via the auth trigger; if it doesn't
    // for whatever reason, create it here so the purchase isn't lost.
    const { error } = await supabase
      .from('user_credits')
      .insert({
        user_id: userId,
        balance: amount,
        total_bought: amount,
        stripe_customer_id: stripeCustomerId ?? null,
      })
    if (error) throw new DatabaseError(error.message)
    return
  }
  const { error } = await supabase
    .from('user_credits')
    .update({
      balance: current.balance + amount,
      total_bought: current.totalBought + amount,
      ...(stripeCustomerId && !current.stripeCustomerId ? { stripe_customer_id: stripeCustomerId } : {}),
    })
    .eq('user_id', userId)
  if (error) throw new DatabaseError(error.message)
}

export async function setStripeCustomerId(userId: string, stripeCustomerId: string): Promise<void> {
  const { error } = await supabase
    .from('user_credits')
    .update({ stripe_customer_id: stripeCustomerId })
    .eq('user_id', userId)
  if (error) throw new DatabaseError(error.message)
}
