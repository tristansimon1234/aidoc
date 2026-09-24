-- La voix off se choisit parmi plusieurs voix : on stocke son identifiant
-- ("none", "gemini:<nom>" ou "elevenlabs:<id>") au lieu de standard / premium.
alter table public.sops drop constraint if exists sops_voice_check;
alter table public.sops
  add constraint sops_voice_check
  check (voice = 'none' or voice like 'gemini:%' or voice like 'elevenlabs:%' or voice in ('standard', 'premium'));
alter table public.sops alter column voice set default 'gemini:Kore';

-- Ton de la voix off (friendly, professional, energetic, calm, playful).
alter table public.sops add column if not exists tone text not null default 'friendly';
