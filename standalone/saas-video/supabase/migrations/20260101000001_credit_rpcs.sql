-- Atomic credit-balance RPCs. Run-of-the-mill UPDATE without these is racy
-- under concurrency: two concurrent generate calls could each see
-- balance=1, both decrement, and both succeed even though only one credit
-- was available. Putting the read + decrement in a single SQL statement
-- with a WHERE balance >= 1 predicate makes it impossible for both to win.

CREATE OR REPLACE FUNCTION public.spend_credit(p_user_id uuid)
  RETURNS integer
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public
AS $$
DECLARE
  new_balance integer;
BEGIN
  UPDATE user_credits
  SET balance = balance - 1
  WHERE user_id = p_user_id AND balance >= 1
  RETURNING balance INTO new_balance;
  RETURN new_balance;  -- null when the predicate didn't match (no credits)
END;
$$;

CREATE OR REPLACE FUNCTION public.refund_credit(p_user_id uuid)
  RETURNS void
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public
AS $$
BEGIN
  UPDATE user_credits
  SET balance = balance + 1
  WHERE user_id = p_user_id;
END;
$$;

-- Restrict execution to authenticated callers — the RPCs are SECURITY
-- DEFINER (bypass RLS) so we don't want them callable from anon.
REVOKE EXECUTE ON FUNCTION public.spend_credit(uuid) FROM public;
REVOKE EXECUTE ON FUNCTION public.refund_credit(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.spend_credit(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.refund_credit(uuid) TO authenticated, service_role;
