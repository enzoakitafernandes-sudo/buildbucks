/* ===== LOJA / CHECKOUT =========================================================
   Cada botão COMPRAR abre a página do pacote na loja CentralCart, onde o cliente
   escolhe Pix ou cartão e recebe os dados de pagamento.

   Para ligar um pacote, copie o final do link do produto na loja
   (ex.: buildscrims.centralcart.ai/package/800-vbucks  ->  '800-vbucks')
   e cole ao lado do número correspondente. Pacote sem link continua
   mandando o cliente para o ticket no Discord.
   ============================================================================ */
const LOJA = 'https://visioninc.centralcart.ai';
const LOJA_DOMINIO = 'visioninc.centralcart.ai';
const API = 'https://api.centralcart.io/v1/webstore';
const PACOTES = {
  800: { id: 911680, slug: '800-vbucks-build-bucks' },
  2400: { id: 911681, slug: '2.400-vbucks-build-bucks' },
  4500: { id: 911682, slug: '4.500-vbucks-build-bucks' },
  9000: { id: 911684, slug: '9.000-vbucks-build-bucks' },
  12500: { id: 911685, slug: '12.500-vbucks-build-bucks' },
  25000: { id: 911686, slug: '25.000-vbucks-build-bucks' },
  37500: { id: 911688, slug: '37.500-v-bucks-%2B-magnata' },
  50000: { id: 911689, slug: '50.000-v-bucks-%2B-magnata' },
};

// O link continua apontando para a loja: serve de reserva se o painel falhar,
// e mantém "abrir em nova aba" funcionando.
document.querySelectorAll('.vbucks-product-action[data-package]').forEach((botao) => {
  const pacote = PACOTES[botao.dataset.package];
  if (!pacote) return;
  botao.href = `${LOJA}/package/${pacote.slug}`;
  botao.dataset.destino = 'loja';
});

/* Painel de compra: o cliente informa nome e e-mail e o Pix (QR + copia e cola)
   é gerado aqui mesmo, sem sair da página. */
(() => {
  const compraveis = [...document.querySelectorAll('.vbucks-product-action[data-package]')].filter(
    (b) => PACOTES[b.dataset.package],
  );
  if (!compraveis.length) return;

  const painel = document.createElement('div');
  painel.className = 'bd-checkout';
  painel.hidden = true;
  painel.innerHTML = `
    <div class="bd-checkout-card" role="dialog" aria-modal="true" aria-labelledby="bd-checkout-titulo">
      <button type="button" class="bd-checkout-close" aria-label="Fechar">&times;</button>
      <p class="bd-checkout-eyebrow">Pagamento via Pix</p>
      <h2 id="bd-checkout-titulo"></h2>
      <p class="bd-checkout-price"></p>
      <form class="bd-checkout-form" novalidate>
        <p class="bd-checkout-sub">Preencha os dados para gerar o Pix. O pagamento é confirmado automaticamente.</p>
        <label class="bd-checkout-field"><span>Seu nome</span><input name="nome" autocomplete="name" required minlength="3" maxlength="60"></label>
        <label class="bd-checkout-field"><span>Seu e-mail</span><input name="email" type="email" autocomplete="email" required maxlength="120"></label>
        <label class="bd-checkout-terms"><input type="checkbox" name="termos" required> <span>Li e aceito os <a href="#faq" class="bd-checkout-termos-link">termos de compra</a>.</span></label>
        <button type="submit" class="bd-checkout-submit">Gerar Pix</button>
      </form>
      <div class="bd-checkout-pix" hidden>
        <div class="bd-checkout-qr"><img alt="QR code do Pix"></div>
        <label class="bd-checkout-field"><span>Pix copia e cola</span><textarea class="bd-checkout-copia" rows="3" readonly></textarea></label>
        <button type="button" class="bd-checkout-copiar">Copiar código Pix</button>
        <p class="bd-checkout-status"><span></span><span class="bd-checkout-status-texto">Aguardando pagamento…</span></p>
        <div class="bd-checkout-passos">
          <strong>Depois de pagar</strong>
          <ol>
            <li>A confirmação é automática.</li>
            <li>Abra um ticket no nosso Discord com o ID da compra.</li>
            <li>Seus V-Bucks são entregues em até 10 minutos.</li>
          </ol>
          <div class="bd-checkout-id" hidden><code></code><button type="button">Copiar</button></div>
        </div>
      </div>
      <p class="bd-checkout-erro" hidden></p>
    </div>`;
  document.body.append(painel);

  const cartao = painel.querySelector('.bd-checkout-card');
  const titulo = painel.querySelector('#bd-checkout-titulo');
  const preco = painel.querySelector('.bd-checkout-price');
  const form = painel.querySelector('.bd-checkout-form');
  const nome = form.elements.nome;
  const email = form.elements.email;
  const termos = form.elements.termos;
  const enviar = form.querySelector('.bd-checkout-submit');
  const blocoPix = painel.querySelector('.bd-checkout-pix');
  const imgQr = painel.querySelector('.bd-checkout-qr img');
  const areaQr = painel.querySelector('.bd-checkout-qr');
  const copia = painel.querySelector('.bd-checkout-copia');
  const btCopiar = painel.querySelector('.bd-checkout-copiar');
  const status = painel.querySelector('.bd-checkout-status');
  const statusTexto = painel.querySelector('.bd-checkout-status-texto');
  const blocoId = painel.querySelector('.bd-checkout-id');
  const idTexto = blocoId.querySelector('code');
  const btCopiarId = blocoId.querySelector('button');
  const erro = painel.querySelector('.bd-checkout-erro');

  let pacoteAtual = null;
  let sondagem = null;
  let ultimoFoco = null;

  const mostrarErro = (msg, comLink) => {
    erro.textContent = msg;
    if (comLink && pacoteAtual) {
      erro.append(' ');
      const a = document.createElement('a');
      a.href = `${LOJA}/package/${pacoteAtual.slug}`;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = 'Comprar na loja';
      erro.append(a);
    }
    erro.hidden = false;
  };

  const fechar = () => {
    painel.hidden = true;
    document.body.classList.remove('bd-checkout-aberto');
    clearInterval(sondagem);
    sondagem = null;
    ultimoFoco?.focus();
  };

  const abrir = (botao) => {
    const dados = PACOTES[botao.dataset.package];
    if (!dados) return;
    const card = botao.closest('.vbucks-product-card');
    pacoteAtual = {
      ...dados,
      nome: card?.querySelector('h4')?.textContent.replace(/\s+/g, ' ').trim() || `${botao.dataset.package} V-Bucks`,
      preco: card?.querySelector('.vbucks-product-price strong')?.textContent.trim() || '',
    };
    ultimoFoco = botao;
    titulo.textContent = pacoteAtual.nome;
    preco.textContent = pacoteAtual.preco;
    form.hidden = false;
    blocoPix.hidden = true;
    blocoId.hidden = true;
    erro.hidden = true;
    status.classList.remove('is-pago');
    statusTexto.textContent = 'Aguardando pagamento…';
    enviar.disabled = false;
    enviar.textContent = 'Gerar Pix';
    painel.hidden = false;
    document.body.classList.add('bd-checkout-aberto');
    setTimeout(() => nome.focus(), 50);
  };

  compraveis.forEach((botao) => {
    botao.addEventListener('click', (e) => {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return; // deixa abrir em nova aba
      e.preventDefault();
      abrir(botao);
    });
  });

  painel.querySelector('.bd-checkout-close').addEventListener('click', fechar);
  painel.querySelector('.bd-checkout-termos-link').addEventListener('click', fechar);
  painel.addEventListener('click', (e) => { if (e.target === painel) fechar(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !painel.hidden) fechar(); });
  cartao.addEventListener('keydown', (e) => { if (e.key === 'Escape') fechar(); });

  const idDoPedido = (url) => {
    try { return new URL(url, LOJA).pathname.split('/').filter(Boolean).pop() || ''; } catch { return ''; }
  };

  const acompanhar = (pedido) => {
    if (!pedido) return;
    clearInterval(sondagem);
    sondagem = setInterval(async () => {
      try {
        const r = await fetch(`${API}/order_status/${encodeURIComponent(pedido)}`, {
          headers: { 'x-store-domain': LOJA_DOMINIO },
        });
        if (!r.ok) return;
        const dados = await r.json();
        const estado = String(dados?.status || dados?.data?.status || '').toUpperCase();
        if (/PAID|APPROVED|COMPLETED|PAGO/.test(estado)) {
          clearInterval(sondagem);
          sondagem = null;
          status.classList.add('is-pago');
          statusTexto.textContent = 'Pagamento confirmado! Abra um ticket no Discord com o ID da compra.';
        }
      } catch { /* sondagem é melhor-esforço */ }
    }, 6000);
  };

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    erro.hidden = true;
    if (nome.value.trim().length < 3) return mostrarErro('Escreva seu nome completo.');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.value.trim())) return mostrarErro('Digite um e-mail válido — é nele que a confirmação chega.');
    if (!termos.checked) return mostrarErro('É preciso aceitar os termos de compra.');

    enviar.disabled = true;
    enviar.textContent = 'Gerando Pix…';
    try {
      const r = await fetch(`${API}/checkout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-store-domain': LOJA_DOMINIO },
        body: JSON.stringify({
          gateway: 'PIX',
          client_name: nome.value.trim(),
          client_email: email.value.trim(),
          terms: true,
          cart: [{ package_id: pacoteAtual.id, quantity: 1 }],
        }),
      });
      const dados = await r.json().catch(() => null);
      if (!r.ok) {
        const msg = dados?.errors?.[0]?.message || dados?.message || 'Não foi possível gerar o Pix agora.';
        enviar.disabled = false;
        enviar.textContent = 'Gerar Pix';
        return mostrarErro(msg, true);
      }

      const pix = dados?.pix_code || dados?.data?.pix_code;
      const qr = dados?.qr_code || dados?.data?.qr_code;
      const destino = dados?.checkout_url || dados?.return_url || dados?.data?.checkout_url;

      if (!pix) {
        // Sem código Pix na resposta: manda o cliente para a página de pagamento da loja.
        if (destino) { window.open(destino, '_blank', 'noopener'); fechar(); return; }
        enviar.disabled = false;
        enviar.textContent = 'Gerar Pix';
        return mostrarErro('O Pix não veio na resposta da loja.', true);
      }

      copia.value = pix;
      if (qr) {
        imgQr.src = qr.startsWith('data:') || qr.startsWith('http') ? qr : `data:image/png;base64,${qr}`;
        areaQr.hidden = false;
      } else {
        areaQr.hidden = true;
      }
      const pedido = idDoPedido(destino || '');
      if (pedido) {
        idTexto.textContent = pedido;
        blocoId.hidden = false;
        acompanhar(pedido);
      }
      form.hidden = true;
      blocoPix.hidden = false;
    } catch {
      enviar.disabled = false;
      enviar.textContent = 'Gerar Pix';
      mostrarErro('Falha de conexão ao gerar o Pix.', true);
    }
  });

  const copiar = async (texto, botao, rotulo) => {
    try { await navigator.clipboard.writeText(texto); } catch { return; }
    const antes = botao.textContent;
    botao.textContent = rotulo;
    botao.classList.add('is-ok');
    setTimeout(() => { botao.textContent = antes; botao.classList.remove('is-ok'); }, 2200);
  };
  btCopiar.addEventListener('click', () => copiar(copia.value, btCopiar, 'Código copiado!'));
  btCopiarId.addEventListener('click', () => copiar(idTexto.textContent, btCopiarId, 'Copiado'));
})();

const menu=document.querySelector('button[aria-controls="mobile-menu"]');
if(menu){const panel=document.createElement('div');panel.className='local-mobile-menu';panel.id='mobile-menu';panel.hidden=true;panel.innerHTML='<a href="#campeonato">Quem Somos Nós?</a><a href="#jogos">VBUCKS</a><a href="#como-funciona">Como funciona</a><a href="#vantagens">Vantagens</a><a href="#faq">FAQ</a><a href="https://discord.gg/buildbucks" target="_blank" rel="noopener noreferrer">Discord</a>';document.body.append(panel);const close=()=>{panel.hidden=true;menu.setAttribute('aria-expanded','false');menu.setAttribute('aria-label','Abrir menu')};menu.addEventListener('click',()=>{panel.hidden=!panel.hidden;menu.setAttribute('aria-expanded',String(!panel.hidden));menu.setAttribute('aria-label',panel.hidden?'Abrir menu':'Fechar menu')});panel.querySelectorAll('a').forEach(a=>a.addEventListener('click',close));document.addEventListener('keydown',e=>{if(e.key==='Escape')close()});}
const answers=[
  '<p>Sim. Todos os V-Bucks são adquiridos de forma legítima dentro da própria Epic Games. Somos parceiros oficiais da Epic Games.</p>',
  '<p>Para adquirir os V-Bucks, selecione o pacote desejado e efetue o pagamento. Depois, abra um ticket em nosso <a href="https://discord.gg/buildbucks" target="_blank" rel="noopener noreferrer">Discord</a> e envie o comprovante de pagamento junto com o ID da compra.</p>',
  '<p>Os V-Bucks podem ser enviados diretamente para sua conta da Epic Games. Se preferir, também podemos enviá-los em uma conta criada por nossa equipe.</p>',
  '<ol><li><strong>1.0</strong> Toda compra é final. Não é possível solicitar reembolso após o envio dos V-Bucks.</li><li><strong>1.1</strong> Caso especial de reembolso: você poderá solicitar o reembolso somente se houver algum problema relacionado aos V-Bucks.</li><li><strong>1.2</strong> Qualquer tentativa de fraude contra nossa empresa resultará em bloqueio permanente em todas as nossas plataformas e proibição de futuras compras.</li></ol>',
  '<p>Atualmente, o dono da Build Scrims conta com mais de 6 mil vendas desde março deste ano, além de diversas avaliações e feedbacks. Ele possui um nome reconhecido na comunidade de Fortnite desde 2021.</p>'
];
document.querySelectorAll('[id^="faq-button-"]').forEach((button,i)=>{let panel=document.getElementById(button.getAttribute('aria-controls'));if(!panel){panel=document.createElement('div');panel.id=button.getAttribute('aria-controls');panel.className='local-faq-panel';panel.innerHTML=answers[i];button.after(panel)}panel.hidden=true;panel.setAttribute('role','region');panel.setAttribute('aria-labelledby',button.id);button.addEventListener('click',()=>{panel.hidden=!panel.hidden;button.setAttribute('aria-expanded',String(!panel.hidden));button.closest('.rounded-lg.border')?.classList.toggle('is-open',!panel.hidden)});});

// Entrada suave das seções abaixo da dobra. Sem JS ou com "reduzir movimento", tudo já nasce visível.
(()=>{
  if(!('IntersectionObserver' in window)||matchMedia('(prefers-reduced-motion: reduce)').matches)return;
  const selector='#campeonato > .relative.mx-auto, #jogos .max-w-2xl, #jogos .grid > div, .vbucks-shop-heading, .vbucks-product-card, .bd-stat, #como-funciona .max-w-2xl, #como-funciona .grid > div, #vantagens .max-w-2xl, .bd-perk, #faq > .relative > .max-w-2xl, #faq .gap-3 > div, #cta > .relative.mx-auto';
  const fold=innerHeight*0.92;
  const pending=new Set([...document.querySelectorAll(selector)].filter(el=>el.getBoundingClientRect().top>fold));
  pending.forEach(el=>el.classList.add('bd-reveal'));
  const show=el=>{
    if(!pending.has(el))return;
    pending.delete(el);io.unobserve(el);
    const group=[...el.parentElement.children].filter(c=>c.classList.contains('bd-reveal'));
    el.style.transitionDelay=`${Math.min(group.indexOf(el),7)*70}ms`;
    el.addEventListener('transitionend',function done(e){if(e.target!==el||e.propertyName!=='opacity')return;el.classList.remove('bd-reveal','is-visible');el.style.transitionDelay='';el.removeEventListener('transitionend',done)});
    el.classList.add('is-visible');
  };
  const io=new IntersectionObserver(entries=>{entries.forEach(e=>{if(e.isIntersecting)show(e.target)})},{rootMargin:'0px 0px -6% 0px',threshold:0.08});
  pending.forEach(el=>io.observe(el));
  // Rede de segurança: nada fica oculto se o usuário pular seções muito rápido (âncoras, rolagem brusca).
  let tick=false;
  addEventListener('scroll',()=>{if(tick||!pending.size)return;tick=true;requestAnimationFrame(()=>{tick=false;pending.forEach(el=>{if(el.getBoundingClientRect().top<innerHeight)show(el)})})},{passive:true});
})();

// Destaque do item ativo no menu conforme a seção visível.
(()=>{
  const links=[...document.querySelectorAll('nav[aria-label="Navegação principal"] div.p-1 > a[href^="#"]')];
  if(!links.length||!('IntersectionObserver' in window))return;
  const byId=new Map(links.map(a=>[a.getAttribute('href').slice(1),a]));
  const io=new IntersectionObserver(entries=>{entries.forEach(e=>{if(!e.isIntersecting)return;links.forEach(a=>a.classList.remove('is-active'));byId.get(e.target.id)?.classList.add('is-active')})},{rootMargin:'-35% 0px -55% 0px'});
  document.querySelectorAll('main section[id]').forEach(s=>io.observe(s));
})();
