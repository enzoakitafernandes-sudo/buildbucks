// Rotas dos painéis: /admin, /entregas e a API usada pelos dois.
const fs = require('node:fs');
const path = require('node:path');
const dados = require('./dados');
const acesso = require('./acesso');
const financeiro = require('./financeiro');

const PUBLICO = path.join(__dirname, 'publico');
const TIPOS = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };

const ip = (req) => String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'local';
const seguro = (req) => String(req.headers['x-forwarded-proto'] || '') === 'https';

function json(res, status, corpo, cabecalhos = {}) {
  const texto = JSON.stringify(corpo);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...cabecalhos });
  res.end(texto);
}

function arquivo(res, nome) {
  const caminho = path.join(PUBLICO, nome);
  if (!caminho.startsWith(PUBLICO + path.sep) || !fs.existsSync(caminho)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Não encontrado');
  }
  res.writeHead(200, { 'Content-Type': TIPOS[path.extname(caminho)] || 'text/plain', 'Cache-Control': 'no-cache' });
  fs.createReadStream(caminho).pipe(res);
}

function corpo(req, limite = 4096) {
  return new Promise((resolve, reject) => {
    let texto = '';
    let excedeu = false;
    req.on('data', (p) => {
      if (excedeu) return;
      texto += p;
      if (texto.length > limite) {
        // Descarta o resto sem derrubar a conexão, para conseguir responder o erro.
        excedeu = true;
        req.resume();
        reject(Object.assign(new Error('Requisição grande demais.'), { grande: true }));
      }
    });
    req.on('end', () => {
      try { resolve(texto ? JSON.parse(texto) : {}); } catch { reject(new Error('json inválido')); }
    });
    req.on('error', reject);
  });
}

const mesmoDia = (iso, referencia) =>
  !!iso && new Date(iso).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' }) === referencia;

/** Quem mais entregou: hoje e no total. Só conta pedido concluído. */
function rankingEntregadores(lista) {
  const hoje = new Date().toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  const por = new Map();
  for (const p of lista) {
    const { estado, por: quem, em } = p.entrega || {};
    if (estado !== 'entregue' || !quem) continue;
    const reg = por.get(quem) || { entregador: quem, hoje: 0, total: 0, ultima: null };
    reg.total++;
    if (mesmoDia(em, hoje)) reg.hoje++;
    if (!reg.ultima || Date.parse(em) > Date.parse(reg.ultima)) reg.ultima = em;
    por.set(quem, reg);
  }
  // Empate no dia decide pelo total, depois por quem entregou mais recentemente.
  return [...por.values()].sort((a, b) => b.hoje - a.hoje || b.total - a.total || Date.parse(b.ultima) - Date.parse(a.ultima));
}

/** Quanto cada entregador tem a receber pelas entregas concluídas. */
function comissoesPorEntregador(lista) {
  const hoje = new Date().toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  const por = new Map();
  for (const p of lista) {
    const { estado, por: quem, em } = p.entrega || {};
    if (estado !== 'entregue' || !quem || p.status !== 'APPROVED') continue;
    const reg = por.get(quem) || { entregador: quem, entregas: 0, comissao: 0, entregasHoje: 0, comissaoHoje: 0 };
    reg.entregas++;
    reg.comissao += p.financeiro.comissao;
    if (mesmoDia(em, hoje)) { reg.entregasHoje++; reg.comissaoHoje += p.financeiro.comissao; }
    por.set(quem, reg);
  }
  return [...por.values()]
    .map((r) => ({ ...r, comissao: Math.round(r.comissao * 100) / 100, comissaoHoje: Math.round(r.comissaoHoje * 100) / 100 }))
    .sort((a, b) => b.comissao - a.comissao);
}

/** Trata a requisição se for dos painéis. Devolve true quando tratou. */
async function tratar(req, res, caminho) {
  // Páginas
  if (caminho === '/admin' || caminho === '/admin/') { arquivo(res, 'admin.html'); return true; }
  if (caminho === '/entregas' || caminho === '/entregas/') { arquivo(res, 'entregas.html'); return true; }
  if (caminho.startsWith('/painel/') && /\.(css|js)$/.test(caminho)) { arquivo(res, path.basename(caminho)); return true; }
  if (!caminho.startsWith('/api/painel/')) return false;

  const sessao = acesso.sessao(req);

  if (caminho === '/api/painel/sessao' && req.method === 'GET') {
    json(res, 200, {
      sessao,
      configurado: acesso.configurado(),
      entregadores: acesso.entregadores(),
      loja: dados.situacao(),
    });
    return true;
  }

  if (caminho === '/api/painel/login' && req.method === 'POST') {
    const endereco = ip(req);
    if (!acesso.podeTentar(endereco)) { json(res, 429, { erro: 'Muitas tentativas. Espere 10 minutos.' }); return true; }
    let dadosLogin;
    try { dadosLogin = await corpo(req); } catch (e) { json(res, e.grande ? 413 : 400, { erro: e.grande ? e.message : 'Requisição inválida.' }); return true; }
    const nova = acesso.autenticar(dadosLogin.usuario, dadosLogin.senha);
    if (!nova) {
      acesso.registrarErro(endereco);
      json(res, 401, { erro: 'Usuário ou senha incorretos.' });
      return true;
    }
    acesso.limparTentativas(endereco);
    json(res, 200, { sessao: nova }, { 'Set-Cookie': acesso.cookieSessao(acesso.emitir(nova.perfil, nova.usuario), seguro(req)) });
    return true;
  }

  if (caminho === '/api/painel/sair' && req.method === 'POST') {
    json(res, 200, { ok: true }, { 'Set-Cookie': acesso.cookieSaida(seguro(req)) });
    return true;
  }

  if (!sessao) { json(res, 401, { erro: 'Faça login.' }); return true; }

  if (caminho === '/api/painel/pedidos' && req.method === 'GET') {
    // Sem token só não dá para buscar pedidos novos; o que já foi salvo continua à vista.
    const url = new URL(req.url, 'http://local');
    if (dados.temToken()) await dados.sincronizar({ forcar: url.searchParams.get('atualizar') === '1' });
    let lista = dados.pedidos();
    const ranking = rankingEntregadores(lista);

    if (sessao.perfil === 'entregador') {
      // Entregador só vê o que já foi pago, e sem valores: precisa do que entregar.
      lista = lista
        .filter((p) => p.status === 'APPROVED')
        .map(({ valor, ...resto }) => resto);
      json(res, 200, { pedidos: lista, ranking, situacao: dados.situacao(), sessao });
      return true;
    }

    lista = lista.map((p) => ({ ...p, financeiro: financeiro.calcular(p) }));
    json(res, 200, {
      pedidos: lista,
      ranking,
      comissoes: comissoesPorEntregador(lista),
      config: financeiro.configuracao(),
      situacao: dados.situacao(),
      sessao,
    });
    return true;
  }

  if (caminho === '/api/painel/entrega' && req.method === 'POST') {
    let pedido;
    try { pedido = await corpo(req); } catch (e) { json(res, e.grande ? 413 : 400, { erro: e.grande ? e.message : 'Requisição inválida.' }); return true; }
    try {
      const entrega = dados.marcarEntrega(pedido.id, pedido.estado, sessao.usuario);
      json(res, 200, { ok: true, entrega });
    } catch (e) {
      json(res, 400, { erro: e.message });
    }
    return true;
  }

  json(res, 404, { erro: 'Rota não encontrada.' });
  return true;
}

module.exports = { tratar };
