-- Make the artifacts storage bucket public for read access.
-- Screenshots, videos, and audio files are documentation assets — not sensitive.
-- This fixes "InvalidJWT" errors when loading media from the frontend.

UPDATE storage.buckets SET public = true WHERE id = 'artifacts';

-- Also ensure the bucket exists (in case it wasn't created yet)
INSERT INTO storage.buckets (id, name, public)
VALUES ('artifacts', 'artifacts', true)
ON CONFLICT (id) DO UPDATE SET public = true;
