// Rotas dos painéis: /admin, /entregas e a API usada pelos dois.
const fs = require('node:fs');
const path = require('node:path');
const dados = require('./dados');
const acesso = require('./acesso');

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
    // Entregador só vê o que já foi pago — não se entrega pedido sem pagamento.
    if (sessao.perfil === 'entregador') {
      lista = lista.filter((p) => p.status === 'APPROVED').map((p) => ({ ...p, valor: undefined, email: p.email }));
    }
    json(res, 200, { pedidos: lista, situacao: dados.situacao(), sessao });
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
