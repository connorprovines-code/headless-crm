import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY; // Use service key for full access

if (!supabaseUrl || !supabaseKey) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY in environment');
  process.exit(1);
}

export const supabase = createClient(supabaseUrl, supabaseKey);

// Default team/user for single-user mode
// In production, this would come from auth
export const DEFAULT_TEAM_ID = process.env.DEFAULT_TEAM_ID || null;
export const DEFAULT_USER_ID = process.env.DEFAULT_USER_ID || null;
