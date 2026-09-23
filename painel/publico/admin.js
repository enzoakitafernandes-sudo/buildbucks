import { api, dinheiro, dataHora, grupoStatus, el, copiar, exigirSessao, barraTopo } from '/painel/comum.js';

const ROTULO_ENTREGA = { nao_entregue: 'Não entregue', realizando: 'Realizando', entregue: 'Entregue' };
let pedidos = [];
let filtro = 'todos';
let busca = '';

exigirSessao('admin', (sessao) => montar(sessao));

function montar(sessao) {
  document.body.className = '';
  document.body.innerHTML = '';

  const atualizadoEm = el('span', { class: 'quem' });
  const btAtualizar = el('button', {
    class: 'btn', text: 'Atualizar',
    onclick: (e) => carregar(true, e.target),
  });
  document.body.append(barraTopo(sessao, 'Vendas de V-Bucks', [atualizadoEm, btAtualizar]));

  const numeros = el('section', { class: 'numeros' });
  const filtros = el('div', { class: 'filtros' });
  const corpoTabela = el('tbody');
  const aviso = el('p', { class: 'aviso', hidden: 'hidden' });

  const campoBusca = el('input', {
    class: 'busca', type: 'search', placeholder: 'Buscar por cliente, e-mail ou ID',
    oninput: (e) => { busca = e.target.value.trim().toLowerCase(); desenharTabela(corpoTabela); },
  });

  for (const [chave, texto] of [['todos', 'Todos'], ['pago', 'Pagos'], ['pendente', 'Pendentes'], ['cancelado', 'Cancelados'], ['nao_entregue', 'Não entregues'], ['realizando', 'Realizando'], ['entregue', 'Entregues']]) {
    filtros.append(el('button', {
      text: texto, 'data-filtro': chave, class: chave === filtro ? 'ativo' : '',
      onclick: () => {
        filtro = chave;
        filtros.querySelectorAll('button').forEach((b) => b.classList.toggle('ativo', b.dataset.filtro === chave));
        desenharTabela(corpoTabela);
      },
    }));
  }
  filtros.append(campoBusca);

  const tabela = el('table', { class: 'tabela' }, [
    el('thead', {}, el('tr', {}, [
      el('th', { text: 'Pedido' }), el('th', { text: 'Data' }), el('th', { text: 'Cliente' }),
      el('th', { text: 'Pacote' }), el('th', { class: 'num', text: 'Valor' }),
      el('th', { text: 'Pagamento' }), el('th', { text: 'Entrega' }),
    ])),
    corpoTabela,
  ]);

  document.body.append(el('main', { class: 'conteudo' }, [numeros, aviso, filtros, el('div', { class: 'rolagem' }, tabela)]));

  const carregar = async (forcar, botao) => {
    if (botao) botao.disabled = true;
    try {
      const dados = await api('/api/painel/pedidos' + (forcar ? '?atualizar=1' : ''));
      pedidos = dados.pedidos;
      const problema = !dados.situacao.token
        ? 'Falta configurar CENTRALCART_TOKEN no servidor: os pedidos abaixo são os da última sincronização.'
        : dados.situacao.falha
          ? `A loja não respondeu na última tentativa (${dados.situacao.falha}). Mostrando o que já foi lido.`
          : '';
      aviso.textContent = problema;
      aviso.hidden = !problema;
      atualizadoEm.textContent = dados.situacao.sincronizadoEm ? 'atualizado ' + dataHora(new Date(dados.situacao.sincronizadoEm).toISOString()) : '';
      desenharNumeros(numeros);
      desenharTabela(corpoTabela);
    } catch (e) {
      aviso.textContent = e.message;
      aviso.hidden = false;
    } finally {
      if (botao) botao.disabled = false;
    }
  };
  carregar(false);
  setInterval(() => carregar(false), 60000);
}

function desenharNumeros(alvo) {
  const pagos = pedidos.filter((p) => p.status === 'APPROVED');
  const hoje = new Date().toLocaleDateString('pt-BR');
  const doDia = pagos.filter((p) => new Date(p.pagoEm || p.criadoEm).toLocaleDateString('pt-BR') === hoje);
  const desde7 = Date.now() - 7 * 86400000;
  const semana = pagos.filter((p) => new Date(p.pagoEm || p.criadoEm).getTime() >= desde7);
  const soma = (l) => l.reduce((n, p) => n + (p.valor || 0), 0);
  const pendentes = pedidos.filter((p) => p.status === 'PENDING');
  const aEntregar = pagos.filter((p) => p.entrega.estado !== 'entregue');

  alvo.innerHTML = '';
  const cartao = (rotulo, valor, nota, destaque) =>
    el('div', { class: 'numero' + (destaque ? ' destaque' : '') }, [
      el('p', { class: 'rotulo', text: rotulo }),
      el('p', { class: 'valor', text: valor }),
      el('p', { class: 'nota', text: nota }),
    ]);
  alvo.append(
    cartao('Faturado hoje', dinheiro(soma(doDia)), `${doDia.length} venda(s)`, true),
    cartao('Últimos 7 dias', dinheiro(soma(semana)), `${semana.length} venda(s)`),
    cartao('Total pago', dinheiro(soma(pagos)), `${pagos.length} venda(s)`),
    cartao('Aguardando pagamento', String(pendentes.length), dinheiro(soma(pendentes))),
    cartao('Falta entregar', String(aEntregar.length), aEntregar.length ? 'pedidos pagos na fila' : 'tudo entregue'),
  );
}

function desenharTabela(corpo) {
  corpo.innerHTML = '';
  const lista = pedidos.filter((p) => {
    const grupo = grupoStatus(p.status);
    if (['pago', 'pendente', 'cancelado'].includes(filtro) && grupo !== filtro) return false;
    if (['nao_entregue', 'realizando', 'entregue'].includes(filtro) && p.entrega.estado !== filtro) return false;
    if (busca && !`${p.cliente} ${p.email} ${p.id}`.toLowerCase().includes(busca)) return false;
    return true;
  }).reverse(); // no admin, mais recente primeiro

  if (!lista.length) {
    corpo.append(el('tr', {}, el('td', { colspan: '7', class: 'vazio', text: 'Nenhum pedido neste filtro.' })));
    return;
  }

  for (const p of lista) {
    const grupo = grupoStatus(p.status);
    const btCopiar = el('button', { class: 'copiar', text: 'copiar' });
    btCopiar.addEventListener('click', () => copiar(p.id, btCopiar));
    corpo.append(el('tr', {}, [
      el('td', {}, [el('code', { text: p.id }), btCopiar]),
      el('td', {}, [el('span', { text: dataHora(p.pagoEm || p.criadoEm) }), el('div', { class: 'sutil', text: p.pagamento || '' })]),
      el('td', {}, [el('div', { text: p.cliente || '—' }), el('div', { class: 'sutil', text: p.email || '' })]),
      el('td', {}, p.itens.map((i) => el('div', { text: `${i.quantidade}× ${i.nome}` }))),
      el('td', { class: 'num', text: dinheiro(p.valor) }),
      el('td', {}, el('span', { class: `pilula ${grupo}`, text: p.statusTexto || p.status })),
      el('td', {}, [
        el('span', { class: `pilula ${p.entrega.estado}`, text: ROTULO_ENTREGA[p.entrega.estado] }),
        p.entrega.por ? el('div', { class: 'sutil', text: `${p.entrega.por} · ${dataHora(p.entrega.em)}` }) : null,
      ]),
    ]));
  }
}
