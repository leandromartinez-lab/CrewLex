// =====================================================================
// CrewLex · /api/perguntar  (Vercel Serverless Function)
// Fluxo: recebe {pergunta, empresa, funcao} -> busca as cláusulas certas
// no Supabase (função buscar_clausulas) -> pede ao Claude (Haiku) uma
// resposta fundamentada SÓ nessas cláusulas, citando as fontes.
// DNA: "sem dado fantasma" — se não houver base, responde que não achou.
//
// Variáveis de ambiente (configurar no Vercel):
//   SUPABASE_URL            (ex.: https://xxxx.supabase.co)
//   SUPABASE_SERVICE_ROLE   (service_role key do Supabase — fica SÓ no backend)
//   ANTHROPIC_API_KEY       (chave da API da Anthropic)
//   CLAUDE_MODEL            (opcional; default Haiku)
//   ALLOWED_ORIGIN          (opcional; default '*' — em produção, a URL do app)
// =====================================================================

const ALLOWED_ORIGIN        = process.env.ALLOWED_ORIGIN || '*';
const SUPABASE_URL          = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
const ANTHROPIC_API_KEY     = process.env.ANTHROPIC_API_KEY;
const CLAUDE_MODEL          = process.env.CLAUDE_MODEL || 'claude-haiku-4-5-20251001';

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

module.exports = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ erro: 'Use POST' });

  try {
    // ---- 1) Ler entrada -------------------------------------------------
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body || '{}'); } catch { body = {}; } }
    if (!body || typeof body !== 'object') body = {};

    const pergunta = String(body.pergunta || '').trim();
    const empresa  = String(body.empresa  || 'GOL').toUpperCase();
    const funcao   = String(body.funcao   || 'piloto').toLowerCase();

    if (!pergunta) return res.status(400).json({ erro: 'Pergunta vazia.' });
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
      return res.status(500).json({ erro: 'Backend sem Supabase configurado.' });
    }

    // ---- 2) Buscar cláusulas (RAG) via RPC do Supabase ------------------
    const rpcResp = await fetch(`${SUPABASE_URL}/rest/v1/rpc/buscar_clausulas`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_SERVICE_ROLE,
        'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE}`
      },
      body: JSON.stringify({ termo: pergunta, p_empresa: empresa, p_funcao: funcao, limite: 8 })
    });

    if (!rpcResp.ok) {
      const t = await rpcResp.text();
      return res.status(502).json({ erro: 'Falha ao buscar cláusulas.', detalhe: t.slice(0, 300) });
    }
    const clausulas = await rpcResp.json();

    // ---- 3) Sem cláusulas? Resposta honesta, sem gastar IA -------------
    if (!Array.isArray(clausulas) || clausulas.length === 0) {
      return res.status(200).json({
        encontrou: false,
        resposta: 'Não encontrei, na base jurídica do CrewLex, uma cláusula que responda diretamente a essa pergunta para o seu contexto (empresa e função). Tente reformular com outras palavras ou consulte o SNA.',
        fontes: []
      });
    }

    if (!ANTHROPIC_API_KEY) {
      // Tem base, mas não dá pra redigir: devolve as fontes mesmo assim.
      return res.status(200).json({
        encontrou: true,
        resposta: 'Encontrei cláusulas relacionadas, mas a redação automática está indisponível no momento. Veja as fontes abaixo.',
        fontes: clausulas.map(toFonte)
      });
    }

    // ---- 4) Montar contexto e pedir resposta fundamentada ao Claude ----
    const contexto = clausulas.map((c, i) =>
      `[${i + 1}] (${c.fonte} · ${c.documento} · ${c.identificador || 's/ id'})\n` +
      `${c.titulo ? c.titulo + ': ' : ''}${c.texto}`
    ).join('\n\n');

    const system = [
      'Você é o assistente jurídico do CrewLex, especializado em legislação trabalhista e de gerenciamento de fadiga de aeronautas brasileiros.',
      'Responda SOMENTE com base nas CLÁUSULAS fornecidas pelo usuário. NÃO invente, não use conhecimento externo e não suponha valores, prazos ou limites que não estejam no texto.',
      'Se as cláusulas não responderem à pergunta, diga claramente que não encontrou base suficiente e sugira procurar o SNA. Nunca preencha lacunas com estimativas.',
      'Cite sempre as fontes que usar, pelo identificador e documento (ex.: "Art. 51 da Lei 13.475/2017", "Cláusula 5.19 do ACT GOL Pilotos", "RBAC 117, 117.17").',
      'Conflito de normas: em matéria trabalhista, prevalece a condição mais favorável ao tripulante (em regra o ACT sobre CCT e Lei); em matéria de segurança/fadiga, prevalece o limite mais restritivo (RBAC).',
      'Escreva em português do Brasil, de forma direta e objetiva. Apresente o que a norma diz; não forneça aconselhamento jurídico definitivo.'
    ].join(' ');

    const userMsg =
      `Contexto do usuário: empresa = ${empresa}, função = ${funcao}.\n\n` +
      `Pergunta: ${pergunta}\n\n` +
      `CLÁUSULAS DISPONÍVEIS (use apenas estas):\n${contexto}`;

    const aiResp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: CLAUDE_MODEL,
        max_tokens: 700,
        system,
        messages: [{ role: 'user', content: userMsg }]
      })
    });

    if (!aiResp.ok) {
      const t = await aiResp.text();
      // Ex.: crédito esgotado / rate limit. Degrada com elegância.
      return res.status(200).json({
        encontrou: true,
        erro: 'consulta_indisponivel',
        resposta: 'A consulta inteligente está temporariamente indisponível. As cláusulas relacionadas estão listadas abaixo; tente novamente mais tarde.',
        fontes: clausulas.map(toFonte),
        detalhe: t.slice(0, 200)
      });
    }

    const data = await aiResp.json();
    const resposta = (data.content || []).map(b => b.text || '').join('\n').trim();

    return res.status(200).json({
      encontrou: true,
      resposta: resposta || 'Não consegui redigir uma resposta. Veja as fontes abaixo.',
      fontes: clausulas.map(toFonte)
    });

  } catch (e) {
    return res.status(500).json({ erro: 'Erro interno.', detalhe: (e && e.message) || String(e) });
  }
};

function toFonte(c) {
  return { fonte: c.fonte, documento: c.documento, identificador: c.identificador, titulo: c.titulo };
}
