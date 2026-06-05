// =====================================================================
// CONFIG DO CREWLEX  — preencha os DOIS valores abaixo
// Onde achar (no painel do Supabase):
//   Project Settings (engrenagem, canto inferior esquerdo) -> API
//     • "Project URL"      -> cole em SUPABASE_URL
//     • chave "anon public"-> cole em SUPABASE_ANON_KEY
// A chave "anon public" PODE ser pública (é segura — o RLS protege os dados).
// NÃO use a "service_role" aqui (essa fica só no Vercel).
// =====================================================================
window.CREWLEX_CONFIG = {
  SUPABASE_URL: "https://SEU-PROJETO.supabase.co",
  SUPABASE_ANON_KEY: "COLE_AQUI_A_CHAVE_ANON_PUBLIC"
};
