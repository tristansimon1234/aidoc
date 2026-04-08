ALTER TABLE projects ALTER COLUMN context TYPE jsonb USING
  CASE
    WHEN context IS NOT NULL THEN jsonb_build_object('audience', '', 'workflow', '', 'quirks', context)
    ELSE NULL
  END;
