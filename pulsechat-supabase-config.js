export const supabaseUrl = "https://adccpqxknbrnylolvcwa.supabase.co";
export const supabaseAnonKey = "sb_publishable_Vg7EOnuZpwfBM_QIEkoSSQ_Giybv1oU";

export function isSupabaseConfigured() {
  return !supabaseUrl.startsWith("PASTE_YOUR_") && !supabaseAnonKey.startsWith("PASTE_YOUR_");
}
