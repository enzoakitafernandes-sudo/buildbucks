// Funções usadas pelos dois painéis.
export const api = async (caminho, opcoes = {}) => {
  const r = await fetch(caminho, {
    headers: opcoes.body ? { 'Content-Type': 'application/json' } : {},
    cache: 'no-store',
    ...opcoes,
  });
  const dados = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(dados.erro || `Erro ${r.status}`), { status: r.status });
  return dados;
};

export const dinheiro = (v) =>
  typeof v === 'number' ? v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }) : '—';

export const dataHora = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
};

export const espera = (iso) => {
  if (!iso) return '';
  const min = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (min < 1) return 'agora';
  if (min < 60) return `há ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `há ${h}h${String(min % 60).padStart(2, '0')}`;
  return `há ${Math.floor(h / 24)}d`;
};

export const grupoStatus = (status) => {
  if (status === 'APPROVED') return 'pago';
  if (status === 'PENDING') return 'pendente';
  return 'cancelado';
};

/** Monta elementos sem innerHTML: nada que venha da loja vira HTML. */
export const el = (tag, props = {}, filhos = []) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined && v !== false) n.setAttribute(k, v);
  }
  for (const f of [].concat(filhos)) if (f) n.append(f);
  return n;
};

export const copiar = async (texto, botao) => {
  try {
    await navigator.clipboard.writeText(texto);
    const antes = botao.textContent;
    botao.textContent = 'copiado';
    setTimeout(() => { botao.textContent = antes; }, 1600);
  } catch { /* área de transferência bloqueada */ }
};

/** Tela de login compartilhada. Chama aoEntrar() quando a sessão é válida. */
export async function exigirSessao(perfilEsperado, aoEntrar) {
  const estado = await api('/api/painel/sessao');
  const valida = estado.sessao && (perfilEsperado === 'qualquer' || estado.sessao.perfil === perfilEsperado || estado.sessao.perfil === 'admin');
  if (valida) return aoEntrar(estado.sessao, estado);

  document.body.innerHTML = '';
  const erro = el('p', { class: 'aviso', hidden: 'hidden' });
  const usuario = el('input', { name: 'usuario', autocomplete: 'username', required: 'required' });
  const senha = el('input', { name: 'senha', type: 'password', autocomplete: 'current-password', required: 'required' });
  const botao = el('button', { class: 'btn btn-principal', type: 'submit', text: 'Entrar', style: 'width:100%;padding:.75rem' });

  const form = el('form', {
    onsubmit: async (e) => {
      e.preventDefault();
      erro.hidden = true;
      botao.disabled = true;
      try {
        await api('/api/painel/login', { method: 'POST', body: JSON.stringify({ usuario: usuario.value, senha: senha.value }) });
        location.reload();
      } catch (ex) {
        erro.textContent = ex.message;
        erro.hidden = false;
        botao.disabled = false;
      }
    },
  }, [
    el('img', { src: '/assets/bd-vbucks-logo.webp', alt: 'Build V-Bucks' }),
    el('h2', { text: perfilEsperado === 'admin' ? 'Painel administrativo' : 'Painel de entregas' }),
    el('p', { text: estado.configurado ? 'Entre com seu usuário e senha.' : 'Nenhuma senha configurada no servidor. Defina ADMIN_SENHA e ENTREGADORES nas variáveis do Railway.' }),
    el('label', { class: 'campo' }, [el('span', { text: 'Usuário' }), usuario]),
    el('label', { class: 'campo' }, [el('span', { text: 'Senha' }), senha]),
    botao,
    erro,
  ]);
  document.body.className = 'login';
  document.body.append(form);
  usuario.focus();
  return null;
}

export function barraTopo(sessao, titulo, extras = []) {
  return el('header', { class: 'topo' }, [
    el('img', { src: '/assets/bd-vbucks-logo.webp', alt: 'Build V-Bucks' }),
    el('h1', { text: titulo }),
    el('span', { class: 'espaco' }),
    ...extras,
    el('span', { class: 'quem', text: sessao.usuario }),
    el('button', {
      class: 'btn',
      text: 'Sair',
      onclick: async () => { await api('/api/painel/sair', { method: 'POST' }); location.reload(); },
    }),
  ]);
}
