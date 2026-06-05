// CrewLex · /api/feedback  (Vercel Serverless Function)
// Recebe { mensagem, empresa, funcao }, valida o login, GRAVA no Supabase
// (tabela feedback) e, se houver RESEND_API_KEY, envia e-mail ao admin.
// O e-mail do admin fica SÓ aqui — nunca é exposto no app.
//
// Variáveis de ambiente (Vercel):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE   (já configuradas)
//   RESEND_API_KEY   (OPCIONAL — se setar, manda e-mail; senão, só grava)
//   ALLOWED_ORIGIN   (opcional)

const SUPABASE_URL          = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
const RESEND_API_KEY        = process.env.RESEND_API_KEY; // opcional
const ADMIN_EMAIL           = 'leandro_martinez@msn.com';  // destino (não aparece no app)

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ erro: 'método não permitido' });

  try {
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body || '{}'); } catch { body = {}; } }
    if (!body || typeof body !== 'object') body = {};

    const mensagem = String(body.mensagem || '').trim().slice(0, 4000);
    const empresa  = String(body.empresa  || '').slice(0, 20);
    const funcao   = String(body.funcao   || '').slice(0, 20);
    if (!mensagem) return res.status(400).json({ erro: 'mensagem vazia' });
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) return res.status(500).json({ erro: 'backend sem Supabase' });

    // ---- Login: exige token válido ----
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    if (!token) return res.status(401).json({ erro_login: true });

    let userId = null, userEmail = null;
    try {
      const uResp = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
        headers: { 'apikey': SUPABASE_SERVICE_ROLE, 'Authorization': `Bearer ${token}` }
      });
      if (uResp.ok) { const u = await uResp.json(); userId = u && u.id; userEmail = u && u.email; }
    } catch (e) { /* cai no 401 */ }
    if (!userId) return res.status(401).json({ erro_login: true });

    // ---- Grava no Supabase ----
    let salvou = false;
    try {
      const ins = await fetch(`${SUPABASE_URL}/rest/v1/feedback`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': SUPABASE_SERVICE_ROLE,
          'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE}`,
          'Prefer': 'return=minimal'
        },
        body: JSON.stringify({ user_id: userId, email: userEmail, empresa: empresa || null, funcao: funcao || null, mensagem })
      });
      salvou = ins.ok;
    } catch (e) { salvou = false; }
    if (!salvou) return res.status(502).json({ erro: 'não consegui salvar sua mensagem agora' });

    // ---- E-mail opcional (Resend), só se a chave existir ----
    if (RESEND_API_KEY) {
      try {
        await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${RESEND_API_KEY}` },
          body: JSON.stringify({
            from: 'CrewLex <onboarding@resend.dev>',
            to: [ADMIN_EMAIL],
            reply_to: userEmail || undefined,
            subject: 'CrewLex · nova mensagem de ' + (userEmail || 'usuário'),
            text: `De: ${userEmail || '(sem e-mail)'}  ·  ${empresa || '?'} / ${funcao || '?'}\n\n${mensagem}`
          })
        });
      } catch (e) { /* e-mail é best-effort; a mensagem já está gravada */ }
    }

    return res.status(200).json({ ok: true });

  } catch (e) {
    return res.status(500).json({ erro: 'erro interno' });
  }
};
