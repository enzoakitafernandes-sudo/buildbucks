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

const FUSO = 'America/Sao_Paulo';
const centavos = (v) => Math.round(v * 100) / 100;
/** Data no fuso de São Paulo no formato 2026-09-23, que ordena como texto. */
const diaDe = (iso) => (iso ? new Date(iso).toLocaleDateString('en-CA', { timeZone: FUSO }) : '');

/** Começo do dia, da semana (segunda) e do mês corrente, em São Paulo. */
function marcos() {
  const hoje = diaDe(Date.now());
  const [ano, mes, dia] = hoje.split('-').map(Number);
  const base = Date.UTC(ano, mes - 1, dia);
  const diaDaSemana = new Date(base).getUTCDay(); // 0 = domingo
  const segunda = new Date(base - ((diaDaSemana + 6) % 7) * 86400000).toISOString().slice(0, 10);
  return { hoje, segunda, mes: hoje.slice(0, 7) };
}

/** Em quais períodos essa data entra. */
function periodosDe(iso, m) {
  const dia = diaDe(iso);
  if (!dia) return { hoje: false, semana: false, mes: false };
  return { hoje: dia === m.hoje, semana: dia >= m.segunda, mes: dia.startsWith(m.mes) };
}

/** Quem mais entregou no período todo, com o recorte de semana e mês. */
function rankingEntregadores(lista) {
  const m = marcos();
  const por = new Map();
  for (const p of lista) {
    const { estado, por: quem, em } = p.entrega || {};
    if (estado !== 'entregue' || !quem) continue;
    const reg = por.get(quem) || { entregador: quem, total: 0, hoje: 0, semana: 0, mes: 0, ultima: null };
    const onde = periodosDe(em, m);
    reg.total++;
    if (onde.hoje) reg.hoje++;
    if (onde.semana) reg.semana++;
    if (onde.mes) reg.mes++;
    if (!reg.ultima || Date.parse(em) > Date.parse(reg.ultima)) reg.ultima = em;
    por.set(quem, reg);
  }
  // Ranking do período todo; empate decide pelo mês, depois por quem entregou por último.
  return [...por.values()].sort((a, b) => b.total - a.total || b.mes - a.mes || Date.parse(b.ultima) - Date.parse(a.ultima));
}

/** Quanto cada entregador tem a receber, por período. */
function comissoesPorEntregador(lista) {
  const m = marcos();
  const por = new Map();
  for (const p of lista) {
    const { estado, por: quem, em } = p.entrega || {};
    if (estado !== 'entregue' || !quem || p.status !== 'APPROVED') continue;
    const reg = por.get(quem) || {
      entregador: quem, entregas: 0, comissao: 0,
      entregasSemana: 0, comissaoSemana: 0, entregasMes: 0, comissaoMes: 0,
    };
    const onde = periodosDe(em, m);
    reg.entregas++;
    reg.comissao += p.financeiro.comissao;
    if (onde.semana) { reg.entregasSemana++; reg.comissaoSemana += p.financeiro.comissao; }
    if (onde.mes) { reg.entregasMes++; reg.comissaoMes += p.financeiro.comissao; }
    por.set(quem, reg);
  }
  return [...por.values()]
    .map((r) => ({ ...r, comissao: centavos(r.comissao), comissaoSemana: centavos(r.comissaoSemana), comissaoMes: centavos(r.comissaoMes) }))
    .sort((a, b) => b.comissao - a.comissao);
}

/** Faturamento, custo, lucro e comissões de cada período (só pedidos pagos). */
function resumoPorPeriodo(lista) {
  const m = marcos();
  const vazio = () => ({ vendas: 0, faturamento: 0, custo: 0, taxas: 0, lucro: 0, comissao: 0, entregues: 0 });
  const r = { hoje: vazio(), semana: vazio(), mes: vazio(), total: vazio() };
  for (const p of lista) {
    if (p.status !== 'APPROVED') continue;
    const f = p.financeiro;
    const onde = periodosDe(p.pagoEm || p.criadoEm, m);
    const entregue = p.entrega?.estado === 'entregue';
    for (const faixa of ['total', ...(onde.hoje ? ['hoje'] : []), ...(onde.semana ? ['semana'] : []), ...(onde.mes ? ['mes'] : [])]) {
      r[faixa].vendas++;
      r[faixa].faturamento += f.venda;
      r[faixa].custo += f.custo;
      r[faixa].taxas += f.taxa;
      r[faixa].lucro += f.lucro;
      if (entregue) { r[faixa].comissao += f.comissao; r[faixa].entregues++; }
    }
  }
  for (const faixa of Object.values(r)) {
    for (const campo of ['faturamento', 'custo', 'taxas', 'lucro', 'comissao']) faixa[campo] = centavos(faixa[campo]);
    faixa.lucroLiquido = centavos(faixa.lucro - faixa.comissao);
  }
  return { ...r, referencia: m };
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
    // Sem sessão a resposta é mínima: a tela de login só precisa saber se o
    // servidor tem senha configurada. O resto é assunto de quem já entrou.
    json(res, 200, sessao
      ? { sessao, configurado: true, cadastros: acesso.cadastros(), loja: dados.situacao() }
      : { sessao: null, configurado: acesso.configurado() });
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
      periodos: resumoPorPeriodo(lista),
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
