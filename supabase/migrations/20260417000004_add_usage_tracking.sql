-- Monthly usage counters + widget session tracking.
-- Counters are incremented via the `increment_usage` RPC (SECURITY DEFINER,
-- atomic per (user, month, feature)) from the backend, post-success.
-- Widget sessions get their own table so we only count unique session tokens
-- per calendar month, not every chat message.

CREATE TABLE usage_counters (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  period_month date NOT NULL,
  feature text NOT NULL CHECK (feature IN ('doc_run', 'voiceover', 'try_doc', 'widget_sessions')),
  count integer NOT NULL DEFAULT 0,
  updated_at timestamptz DEFAULT now(),
  PRIMARY KEY (user_id, period_month, feature)
);

ALTER TABLE usage_counters ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users read own usage" ON usage_counters
  FOR SELECT USING (auth.uid() = user_id);

CREATE OR REPLACE FUNCTION public.increment_usage(
  p_user_id uuid,
  p_feature text,
  p_delta integer DEFAULT 1
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO usage_counters (user_id, period_month, feature, count)
  VALUES (p_user_id, date_trunc('month', now())::date, p_feature, p_delta)
  ON CONFLICT (user_id, period_month, feature)
  DO UPDATE SET
    count = usage_counters.count + EXCLUDED.count,
    updated_at = now();
END;
$$;

-- Widget sessions are deduplicated per (project, token, month).
-- Only the first insert for that tuple counts towards the monthly widget quota.
CREATE TABLE widget_sessions (
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  session_token text NOT NULL,
  period_month date NOT NULL DEFAULT date_trunc('month', now())::date,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  started_at timestamptz DEFAULT now(),
  last_seen_at timestamptz DEFAULT now(),
  PRIMARY KEY (project_id, session_token, period_month)
);

CREATE INDEX idx_widget_sessions_last_seen ON widget_sessions(last_seen_at);

ALTER TABLE widget_sessions ENABLE ROW LEVEL SECURITY;
-- Only service_role writes; owners can inspect their own sessions.
CREATE POLICY "Users read own widget sessions" ON widget_sessions
  FOR SELECT USING (auth.uid() = user_id);
