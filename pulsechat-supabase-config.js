export const supabaseUrl = "https://adccpqxkhbrnylolvcwa.supabase.co";
export const supabaseAnonKey = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFkY2NwcXhrbmJybnlsb2x2Y3dhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ1MDQxMDcsImV4cCI6MjA5MDA4MDEwN30.YU2dYtuGZDRMVsXspJOTKUTozHaqPuKUrRA9kHWlQaA";

export function isSupabaseConfigured() {
  return !supabaseUrl.startsWith("") && !supabaseAnonKey.startsWith("");
}
