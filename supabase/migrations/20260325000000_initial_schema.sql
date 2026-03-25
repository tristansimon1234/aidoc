-- runs
CREATE TABLE runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  feature_name text NOT NULL,
  start_url text NOT NULL,
  goal text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  token_usage integer DEFAULT 0,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- run_steps
CREATE TABLE run_steps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  step_index integer NOT NULL,
  url text,
  title text,
  action text,
  observation text,
  screenshot_path text,
  status text DEFAULT 'completed',
  created_at timestamptz DEFAULT now()
);

-- run_questions
CREATE TABLE run_questions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  step_id uuid REFERENCES run_steps(id) ON DELETE SET NULL,
  question text NOT NULL,
  answer text,
  answered_at timestamptz,
  created_at timestamptz DEFAULT now()
);

-- generated_docs
CREATE TABLE generated_docs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL UNIQUE REFERENCES runs(id) ON DELETE CASCADE,
  markdown_content text,
  json_content jsonb,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- artifacts
CREATE TABLE artifacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  type text NOT NULL,
  path text NOT NULL,
  created_at timestamptz DEFAULT now()
);

-- Indexes
CREATE INDEX idx_run_steps_run_id ON run_steps(run_id);
CREATE INDEX idx_run_questions_run_id ON run_questions(run_id);
CREATE INDEX idx_artifacts_run_id ON artifacts(run_id);
