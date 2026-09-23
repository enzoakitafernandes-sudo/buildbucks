import { api, dataHora, espera, el, copiar, exigirSessao, barraTopo } from '/painel/comum.js';

const COLUNAS = [
  { estado: 'nao_entregue', titulo: 'Não entregue', vazio: 'Nenhum pedido esperando.' },
  { estado: 'realizando', titulo: 'Realizando pedido', vazio: 'Nada em andamento.' },
  { estado: 'entregue', titulo: 'Conta entregue', vazio: 'Nenhuma entrega registrada hoje.' },
];
const ACOES = {
  nao_entregue: [{ para: 'realizando', texto: 'Iniciar', cor: 'laranja' }],
  realizando: [{ para: 'entregue', texto: 'Entreguei', cor: 'verde' }, { para: 'nao_entregue', texto: 'Voltar', cor: 'vermelho' }],
  entregue: [{ para: 'realizando', texto: 'Reabrir', cor: 'laranja' }],
};

let pedidos = [];
let ocupado = false;

exigirSessao('entregador', (sessao) => montar(sessao));

function montar(sessao) {
  document.body.className = '';
  document.body.innerHTML = '';
  const aviso = el('p', { class: 'aviso', hidden: 'hidden' });
  const quadro = el('section', { class: 'quadro' });
  const btAtualizar = el('button', { class: 'btn', text: 'Atualizar', onclick: (e) => carregar(true, e.target) });

  document.body.append(barraTopo(sessao, 'Fila de entregas', [btAtualizar]));
  document.body.append(el('main', { class: 'conteudo' }, [aviso, quadro]));

  const carregar = async (forcar, botao) => {
    if (botao) botao.disabled = true;
    try {
      const dados = await api('/api/painel/pedidos' + (forcar ? '?atualizar=1' : ''));
      pedidos = dados.pedidos;
      const problema = !dados.situacao.token
        ? 'O servidor está sem a chave da loja: pedidos novos podem não aparecer.'
        : dados.situacao.falha
          ? 'A loja não respondeu na última atualização. A fila abaixo pode estar desatualizada.'
          : '';
      aviso.textContent = problema;
      aviso.hidden = !problema;
      desenhar(quadro, carregar);
    } catch (e) {
      aviso.textContent = e.message;
      aviso.hidden = false;
    } finally {
      if (botao) botao.disabled = false;
    }
  };

  carregar(false);
  // Atualiza sozinho, mas nunca no meio de um clique.
  setInterval(() => { if (!ocupado) carregar(false); }, 30000);
}

function desenhar(quadro, carregar) {
  quadro.innerHTML = '';
  for (const coluna of COLUNAS) {
    // A fila já vem do servidor do mais antigo para o mais novo.
    let lista = pedidos.filter((p) => p.entrega.estado === coluna.estado);
    if (coluna.estado === 'entregue') lista = lista.slice(-40).reverse(); // as últimas entregas bastam

    const corpo = el('div', { class: 'lista' });
    if (!lista.length) corpo.append(el('p', { class: 'vazio', text: coluna.vazio }));

    lista.forEach((p, indice) => {
      const primeiro = coluna.estado === 'nao_entregue' && indice === 0;
      const btEmail = el('button', { class: 'copiar', text: 'copiar' });
      btEmail.addEventListener('click', () => copiar(p.email, btEmail));
      const btId = el('button', { class: 'copiar', text: 'copiar' });
      btId.addEventListener('click', () => copiar(p.id, btId));

      const acoes = el('div', { class: 'acoes' }, ACOES[coluna.estado].map((a) =>
        el('button', {
          class: a.cor, text: a.texto,
          onclick: async (e) => {
            ocupado = true;
            e.target.disabled = true;
            try {
              await api('/api/painel/entrega', { method: 'POST', body: JSON.stringify({ id: p.id, estado: a.para }) });
              await carregar(false);
            } catch (ex) {
              alert(ex.message);
              e.target.disabled = false;
            } finally {
              ocupado = false;
            }
          },
        })));

      corpo.append(el('article', { class: 'pedido' + (primeiro ? ' primeiro' : '') }, [
        primeiro ? el('span', { class: 'selo-prioridade', text: 'Atender primeiro' }) : null,
        el('div', { class: 'linha1' }, [
          el('span', { class: 'pacote', text: p.itens.map((i) => `${i.quantidade}× ${i.nome}`).join(' + ') }),
          el('span', { class: 'espera', text: espera(p.pagoEm || p.criadoEm) }),
        ]),
        el('div', { class: 'dado' }, [el('b', { text: 'Cliente: ' }), document.createTextNode(p.cliente || '—')]),
        el('div', { class: 'dado' }, [el('b', { text: 'E-mail: ' }), document.createTextNode(p.email || '—'), btEmail]),
        el('div', { class: 'dado' }, [el('b', { text: 'Pedido: ' }), document.createTextNode(p.id), btId]),
        el('div', { class: 'dado', text: `Pago em ${dataHora(p.pagoEm || p.criadoEm)}` }),
        p.entrega.por ? el('div', { class: 'dado', text: `${p.entrega.estado === 'entregue' ? 'Entregue' : 'Em atendimento'} por ${p.entrega.por} · ${dataHora(p.entrega.em)}` }) : null,
        acoes,
      ]));
    });

    quadro.append(el('div', { class: 'coluna', 'data-estado': coluna.estado }, [
      el('header', {}, [el('b', { text: coluna.titulo }), el('span', { class: 'contagem', text: String(lista.length) })]),
      corpo,
    ]));
  }
}
