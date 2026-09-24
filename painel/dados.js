// Leitura dos pedidos na CentralCart + estado de entrega (arquivo em disco).
//
// A CentralCart pagina os pedidos de 15 em 15 e não diz quais produtos foram
// comprados na listagem — só no detalhe. Como a loja tem milhares de pedidos de
// outros produtos, a sincronização é incremental: varre da página mais nova para
// a mais antiga, busca o detalhe só de pedido desconhecido e para quando chega a
// pedidos anteriores ao início da venda de V-Bucks. O que já foi classificado
// nunca é consultado de novo.
const fs = require('node:fs');
const path = require('node:path');

const API = 'https://api.centralcart.io/v1';
const TOKEN = process.env.CENTRALCART_TOKEN || '';
const PASTA = process.env.DATA_DIR || path.join(__dirname, '..', 'dados');
const ARQUIVO = path.join(PASTA, 'painel.json');
// Pedidos anteriores a esta data não são varridos (V-Bucks entrou na loja em 22/09/2026).
const DESDE = Date.parse(process.env.VBUCKS_DESDE || '2026-09-20T00:00:00-03:00');
const IDS_VBUCKS = new Set(
  (process.env.VBUCKS_IDS || '911680,911681,911682,911684,911685,911686,911688,911689')
    .split(',').map((s) => Number(s.trim())).filter(Boolean),
);

const ESTADOS = ['nao_entregue', 'realizando', 'entregue'];
const INTERVALO_SYNC_MS = 30_000;

let estado = { pedidos: {}, entregas: {}, ignorados: {}, sincronizadoEm: 0 };
let sincronizando = null;
let ultimaFalha = null;

function carregar() {
  try {
    fs.mkdirSync(PASTA, { recursive: true });
    if (fs.existsSync(ARQUIVO)) estado = { ignorados: {}, ...JSON.parse(fs.readFileSync(ARQUIVO, 'utf8')) };
  } catch (e) {
    console.error('[painel] não consegui ler o arquivo de dados:', e.message);
  }
}
carregar();

// Conta as partidas num arquivo à parte. Se o disco guarda mesmo os dados, a
// contagem sobe a cada reinício; se voltar sempre a 1, o volume não está ligado
// e tudo que os entregadores marcarem some no próximo deploy.
const PARTIDAS = path.join(PASTA, 'partidas.json');
let partidas = 1;
try {
  fs.mkdirSync(PASTA, { recursive: true });
  if (fs.existsSync(PARTIDAS)) partidas = Number(JSON.parse(fs.readFileSync(PARTIDAS, 'utf8')).contagem) + 1 || 1;
  fs.writeFileSync(PARTIDAS, JSON.stringify({ contagem: partidas, ultima: new Date().toISOString() }));
} catch (e) {
  console.error('[painel] não consegui contar as partidas:', e.message);
}
console.log(`[painel] partida nº ${partidas} · ${Object.keys(estado.pedidos).length} pedidos lidos de ${ARQUIVO}`);

let gravacaoPendente = null;
function gravar() {
  // Agrupa gravações próximas e escreve de forma atômica (temporário + rename).
  if (gravacaoPendente) return;
  gravacaoPendente = setTimeout(() => {
    gravacaoPendente = null;
    try {
      fs.mkdirSync(PASTA, { recursive: true });
      const tmp = ARQUIVO + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(estado));
      fs.renameSync(tmp, ARQUIVO);
    } catch (e) {
      console.error('[painel] não consegui gravar o arquivo de dados:', e.message);
    }
  }, 400);
}

const temToken = () => TOKEN.length > 0;

async function api(caminho) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const r = await fetch(`${API}${caminho}`, {
      headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/json' },
      signal: ctrl.signal,
    });
    if (!r.ok) throw new Error(`CentralCart respondeu ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

// Um pedido só interessa se tiver algum pacote de V-Bucks.
function itensVbucks(detalhe) {
  const pacotes = detalhe?.packages || [];
  return pacotes
    .filter((p) => IDS_VBUCKS.has(Number(p.package_id)))
    .map((p) => ({ nome: p.name, quantidade: p.quantity || 1, valor: p.price, pacoteId: Number(p.package_id) }));
}

function resumir(pedido, itens) {
  return {
    id: pedido.internal_id,
    criadoEm: pedido.created_at,
    pagoEm: pedido.paid_at || null,
    status: pedido.status,
    statusTexto: pedido.status_display || pedido.status,
    valor: pedido.price,
    pagamento: pedido.gateway_display || pedido.gateway,
    cliente: pedido.client_name || '',
    email: pedido.client_email || '',
    itens,
  };
}

async function sincronizar({ forcar = false } = {}) {
  if (!temToken()) return { ok: false, erro: 'sem_token' };
  if (sincronizando) return sincronizando;
  if (!forcar && Date.now() - estado.sincronizadoEm < INTERVALO_SYNC_MS) return { ok: true, cache: true };

  sincronizando = (async () => {
    let novos = 0, detalhes = 0, atualizados = 0;
    try {
      for (let pagina = 1; pagina <= 200; pagina++) {
        const resposta = await api(`/app/order?page=${pagina}`);
        const lista = resposta?.data || [];
        if (!lista.length) break;
        let todosAntigos = true;

        for (const pedido of lista) {
          const criado = Date.parse(pedido.created_at);
          if (Number.isFinite(criado) && criado >= DESDE) todosAntigos = false;
          if (Number.isFinite(criado) && criado < DESDE) continue;

          const id = pedido.internal_id;
          if (estado.ignorados[id]) continue;

          const conhecido = estado.pedidos[id];
          if (conhecido) {
            // Já sei que é de V-Bucks: só atualizo o que muda (status/pagamento).
            if (conhecido.status !== pedido.status || conhecido.pagoEm !== (pedido.paid_at || null)) {
              conhecido.status = pedido.status;
              conhecido.statusTexto = pedido.status_display || pedido.status;
              conhecido.pagoEm = pedido.paid_at || null;
              conhecido.valor = pedido.price;
              atualizados++;
            }
            continue;
          }

          const detalhe = await api(`/app/order/${encodeURIComponent(id)}`);
          detalhes++;
          const itens = itensVbucks(detalhe);
          if (!itens.length) {
            estado.ignorados[id] = 1; // não é V-Bucks: nunca mais consulto
            continue;
          }
          estado.pedidos[id] = resumir({ ...pedido, client_name: detalhe.client_name, client_email: detalhe.client_email }, itens);
          if (!estado.entregas[id]) estado.entregas[id] = { estado: 'nao_entregue', por: null, em: null };
          novos++;
        }

        // Página inteira anterior ao início das vendas de V-Bucks: pode parar.
        if (todosAntigos) break;
        const meta = resposta?.meta;
        if (meta && meta.current_page >= meta.last_page) break;
      }
      estado.sincronizadoEm = Date.now();
      ultimaFalha = null;
      gravar();
      return { ok: true, novos, detalhes, atualizados };
    } catch (e) {
      ultimaFalha = e.message;
      console.error('[painel] falha ao sincronizar:', e.message);
      return { ok: false, erro: e.message };
    } finally {
      sincronizando = null;
    }
  })();
  return sincronizando;
}

function pedidos() {
  return Object.values(estado.pedidos)
    .map((p) => ({ ...p, entrega: estado.entregas[p.id] || { estado: 'nao_entregue', por: null, em: null } }))
    // Mais antigo primeiro: quem comprou antes é atendido antes.
    .sort((a, b) => Date.parse(a.pagoEm || a.criadoEm) - Date.parse(b.pagoEm || b.criadoEm));
}

function marcarEntrega(id, novoEstado, quem) {
  if (!ESTADOS.includes(novoEstado)) throw new Error('estado inválido');
  if (!estado.pedidos[id]) throw new Error('pedido não encontrado');
  estado.entregas[id] = { estado: novoEstado, por: quem, em: new Date().toISOString() };
  gravar();
  return estado.entregas[id];
}

const situacao = () => ({
  token: temToken(),
  pasta: PASTA,
  partidas, // continua 1 depois de vários deploys = o disco está sendo zerado
  sincronizadoEm: estado.sincronizadoEm,
  falha: ultimaFalha,
  total: Object.keys(estado.pedidos).length,
});

module.exports = { sincronizar, pedidos, marcarEntrega, situacao, ESTADOS, temToken };
