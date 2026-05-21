import { createClient } from '@supabase/supabase-js'
import { env } from '../config/env.js'

/**
 * Service-role Supabase client — server-side only. RLS is bypassed for this
 * key by design (we still gate access via the auth middleware + per-feature
 * ownership checks). Never instantiate from anything imported into the
 * browser bundle.
 */
export const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY)
