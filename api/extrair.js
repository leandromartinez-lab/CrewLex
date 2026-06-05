// CrewLex · /api/extrair  (Vercel Serverless Function)
// Recebe { imagem_base64, mime }, valida o login, chama a IA de VISÃO (Sonnet)
// com o prompt v2 e devolve o JSON da escala. PRINCÍPIOS:
//   - a chave da API fica SÓ aqui (ANTHROPIC_API_KEY)
//   - a imagem e o texto NÃO são gravados em lugar nenhum (LGPD)
//   - a IA apenas transcreve; quem julga é o motor determinístico, no cliente
//   - exige login (Supabase Auth): leitura de visão é a chamada mais cara
//
// Variáveis de ambiente (Vercel):
//   ANTHROPIC_API_KEY      (chave da Anthropic)
//   SUPABASE_URL           (https://xxxx.supabase.co)
//   SUPABASE_SERVICE_ROLE  (service_role — só backend; valida o token do usuário)
//   CLAUDE_VISION_MODEL    (opcional; default Sonnet — NÃO usa a CLAUDE_MODEL do Q&A)
//   ALLOWED_ORIGIN         (opcional; default '*')

const { readFileSync } = require('fs');
const { join } = require('path');

const SUPABASE_URL          = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
const VISION_MODEL          = process.env.CLAUDE_VISION_MODEL || 'claude-sonnet-4-6';

let PROMPT = null;
function getPrompt() {
  if (PROMPT) return PROMPT;
  // prompt_extracao_v2.txt precisa estar na RAIZ do projeto no deploy
  PROMPT = readFileSync(join(process.cwd(), 'prompt_extracao_v2.txt'), 'utf8');
  return PROMPT;
}

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
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const { imagem_base64, mime } = body;
    if (!imagem_base64 || !mime) {
      return res.status(400).json({ erro: 'envie imagem_base64 e mime' });
    }

    // ---- Login: exige token válido (protege a chamada de visão) ----
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    if (!token) {
      return res.status(401).json({ erro_login: true, erro: 'Faça login para ler a escala.' });
    }
    if (SUPABASE_URL && SUPABASE_SERVICE_ROLE) {
      let userId = null;
      try {
        const uResp = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
          headers: { 'apikey': SUPABASE_SERVICE_ROLE, 'Authorization': `Bearer ${token}` }
        });
        if (uResp.ok) { const u = await uResp.json(); userId = u && u.id; }
      } catch (e) { /* cai no 401 */ }
      if (!userId) {
        return res.status(401).json({ erro_login: true, erro: 'Sessão inválida. Faça login novamente.' });
      }
    }

    const isPdf = mime === 'application/pdf';
    const bloco = isPdf
      ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: imagem_base64 } }
      : { type: 'image',    source: { type: 'base64', media_type: mime,              data: imagem_base64 } };

    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: VISION_MODEL,
        max_tokens: 4000,
        system: getPrompt(),
        messages: [{
          role: 'user',
          content: [
            bloco,
            { type: 'text', text: 'Extraia os dados desta escala conforme as regras. Responda APENAS com o JSON, sem texto antes ou depois.' }
          ]
        }]
      })
    });

    if (!resp.ok) {
      const t = await resp.text();
      return res.status(502).json({ erro: 'falha na IA de visão', detalhe: t.slice(0, 300) });
    }

    const data = await resp.json();
    const texto = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');

    let json;
    try {
      json = JSON.parse(texto.replace(/```json/g, '').replace(/```/g, '').trim());
    } catch (e) {
      return res.status(422).json({ erro: 'a IA não devolveu JSON válido', eh_escala: false, bruto: texto.slice(0, 500) });
    }

    // privacidade: nada é persistido aqui.
    return res.status(200).json(json);

  } catch (e) {
    return res.status(500).json({ erro: 'erro interno', detalhe: String((e && e.message) || e).slice(0, 200) });
  }
};
