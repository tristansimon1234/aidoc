-- Put approximate per-feature quotas back in the plan UI bullets.
-- Numbers are labeled with ~ so users understand they're approximations —
-- the actual budget is tokens (see monthly_tokens), and each operation has a
-- weighted cost. Lets us tune internally without changing the bullets much.

UPDATE plans SET features = CASE id
  WHEN 'free' THEN
    '["1 project","~3 doc generations / month","~3 voice-overs / month","~1 Try Doc test / month","~50 chat sessions / month","Community support"]'::jsonb
  WHEN 'startup' THEN
    '["3 projects","~50 doc generations / month","~50 voice-overs / month","~20 Try Doc tests / month","~500 chat sessions / month","Email support"]'::jsonb
  WHEN 'growth' THEN
    '["10 projects","~200 doc generations / month","~200 voice-overs / month","~80 Try Doc tests / month","~3,000 chat sessions / month","Priority email support"]'::jsonb
  WHEN 'business' THEN
    '["40 projects","~800 doc generations / month","~800 voice-overs / month","~300 Try Doc tests / month","~15,000 chat sessions / month","Pay-as-you-go overages","Dedicated support"]'::jsonb
  ELSE features
END;
