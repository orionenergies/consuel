import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface MockEvent {
  type: string;
  [key: string]: unknown;
}

/**
 * Faux site "monespaceconsuel" qui reproduit les sélecteurs du workflow
 * (formcontrolname, classes, ids) avec des composants façon Ionic :
 * popovers, listes en cascade, cases à cocher personnalisées, upload caché.
 */
const PAGE = /* html */ `<!doctype html><html><head><meta charset="utf-8"><title>mock</title>
<style>
  ion-button,button,.btn{display:inline-block;padding:6px 12px;border:1px solid #333;cursor:pointer;margin:4px}
  ion-select-popover{position:fixed;top:100px;left:300px;background:#eee;border:1px solid #000;padding:4px;z-index:10}
  ion-item{display:block;padding:4px;cursor:pointer}
  ion-radio,ion-checkbox{display:inline-block;width:20px;height:20px;border:1px solid #000;margin:4px;vertical-align:middle}
  .radio-checked,.checkbox-checked{background:#080}
  [formcontrolname=ville],#typologieTypeId,#selectedSiteId,#typeProductionIdId{display:block;border:1px solid #999;min-height:24px;min-width:200px;cursor:pointer;margin:4px}
</style></head><body><div id="app"></div>
<script>
const app = document.getElementById('app');
const log = (type, data) => fetch('/__log', {method:'POST', body: JSON.stringify({type, ...data})});
const state = { selects: {}, fields: {}, checks: {} };
let hybrid = false;

function h(html){ app.innerHTML = html; }
function bindBtn(sel, fn){ const e = document.querySelector(sel); if (e) e.addEventListener('click', fn); }

function openPopover(host, name, levels, onDone){
  document.querySelectorAll('ion-select-popover').forEach(e => e.remove());
  const pop = document.createElement('ion-select-popover');
  const render = (lvl) => {
    pop.innerHTML = '';
    levels[lvl].forEach(label => {
      const it = document.createElement('ion-item'); it.textContent = label;
      it.addEventListener('click', () => {
        (state.selects[name] ||= []).push(label);
        if (lvl + 1 < levels.length) render(lvl + 1);
        else { pop.remove(); host.textContent = label; log('select', {name, path: state.selects[name]}); onDone && onDone(); }
      });
      pop.appendChild(it);
    });
  };
  state.selects[name] = [];
  render(0); document.body.appendChild(pop);
}

function checkbox(el, name){
  el.addEventListener('click', () => {
    el.checked = !el.checked; el.classList.toggle('checkbox-checked', el.checked); el.classList.toggle('radio-checked', el.checked);
    log('check', {name, checked: el.checked});
  });
}

function inputs(names){
  names.forEach(n => {
    const i = document.querySelector('[formcontrolname='+n+'] input'); if (!i) return;
    i.addEventListener('input', () => { state.fields[n] = i.value; });
    i.addEventListener('blur', () => log('field', {name:n, value:i.value}));
  });
}

const views = {
  login(){
    h('<h1>Connexion</h1><ion-input formcontrolname="identifiant"><input type="text"></ion-input>'
    + '<ion-input formcontrolname="password"><input type="password"></ion-input>'
    + '<ion-button class="connexion"><span>Connexion</span></ion-button>'
    + '<div id="axeptio"><button>Non merci</button></div>');
    bindBtn('#axeptio button', () => document.getElementById('axeptio').remove());
    bindBtn('.connexion', () => {
      const id = document.querySelector('[formcontrolname=identifiant] input').value;
      const pw = document.querySelector('[formcontrolname=password] input').value;
      log('login', {id, pw});
      history.pushState({}, '', '/accueil'); go('home');
    });
  },
  home(){
    h('<ion-button class="creer_dossier"><span>Créer un dossier</span></ion-button>');
    bindBtn('.creer_dossier', () => go('type'));
  },
  type(){
    const col = (color) => '<ion-col class="consuel-attestation-'+color+' md hydrated">'
      + '<div class="ion-text-center"><ion-input><input type="text" maxlength="3" value="0"></ion-input></div>'
      + '<ion-buttons>'
      + '<ion-button class="button-has-icon-only"><ion-icon slot="icon-only" name="24-moins" aria-label="24 moins" role="img"></ion-icon></ion-button>'
      + '<ion-button class="button-has-icon-only"><ion-icon slot="icon-only" name="24-plus" aria-label="24 plus" role="img"></ion-icon></ion-button>'
      + '</ion-buttons></ion-col>';
    h(col('bleu') + col('violet')
    + '<ion-button disabled aria-disabled="true" class="button-disabled"><span>Étape suivante</span></ion-button>');
    const next = document.querySelector('ion-button.button-disabled');
    document.querySelectorAll('ion-col').forEach(column => {
      const icon = column.querySelector('ion-icon[name="24-plus"]');
      const host = icon.closest('ion-button');
      icon.addEventListener('click', (ev) => ev.stopPropagation());
      const shadow = host.attachShadow({ mode: 'open' });
      const native = document.createElement('button');
      native.type = 'button';
      native.appendChild(document.createElement('slot')).name = 'icon-only';
      shadow.appendChild(native);
      native.addEventListener('click', () => {
        hybrid = column.className.includes('violet');
        log('type', {hybrid});
        next.removeAttribute('disabled');
        next.setAttribute('aria-disabled', 'false');
        next.classList.remove('button-disabled');
      });
    });
    next.addEventListener('click', () => { if (!next.hasAttribute('disabled')) go('site'); });
  },
  site(){
    h(['nomSite','proprietaireName','numAffaire','numRue','nomRue','codePostal'].map(n => '<ion-input formcontrolname="'+n+'"><input type="text"></ion-input>').join('')
    + '<div formcontrolname="ville">Choisir</div>'
    + '<div class="geolocalization-validation-container">Valider la géolocalisation</div>'
    + '<ion-button><span>Étape suivante</span></ion-button>');
    inputs(['nomSite','proprietaireName','numAffaire','numRue','nomRue','codePostal']);
    document.querySelector('[formcontrolname=ville]').addEventListener('click', () => {
      const cp = state.fields.codePostal;
      setTimeout(() => openPopover(document.querySelector('[formcontrolname=ville]'), 'ville', [[
        'MONTPELLIER (34170)',
        'AIX EN PROVENCE (13100)',
        'MONTPELLIER (34000)',
        'CASTELNAU-LE-LEZ (34170)',
      ]]), 100);
    });
    document.querySelector('.geolocalization-validation-container').addEventListener('click', () => log('geoloc', {}));
    document.querySelector('ion-button').addEventListener('click', () => go('create'));
  },
  create(){
    h('<ion-button class="btn"><span>Créer le dossier</span></ion-button>');
    document.querySelector('.btn').addEventListener('click', () => { log('create', {}); setTimeout(() => go('menu'), 300); });
  },
  menu(){
    h('<ion-item class="m1"><ion-label>Mes dossiers</ion-label></ion-item><ion-item class="m2"><ion-label>Mes attestations à envoyer</ion-label></ion-item>');
    document.querySelector('.m2').addEventListener('click', () => go('list'));
  },
  list(){
    const rows = ['AUTRE-PLANT','PV001'].map((c,i) => '<div class="row"><div class="pagination-liste-element--checkbox"><ion-checkbox></ion-checkbox></div>'
      + '<div class="pagination-liste-element--ligne">Dossier ' + c + '</div></div>').join('');
    h(rows + '<ion-button class="envoyer"><span>Envoyer au consuel</span></ion-button>');
    document.querySelectorAll('.pagination-liste-element--ligne').forEach((e,i) => e.addEventListener('click', () => { if (!state.edited) { log('open', {row:e.textContent}); go('form'); } }));
    document.querySelectorAll('.pagination-liste-element--checkbox ion-checkbox').forEach((c,i) => { checkbox(c, 'row'+i); });
    document.querySelector('.envoyer').addEventListener('click', () => { log('envoyer', {}); go('confirm'); });
  },
  form(){
    h('<div id="typologieTypeId">-</div><div id="selectedSiteId">-</div><div id="typeProductionIdId">-</div>'
    + '<ion-input formcontrolname="puissanceInstallee"><input type="number"></ion-input>'
    + '<div formcontrolname="isTensionSubMille"><ion-radio></ion-radio> &lt;= 1000V <ion-radio></ion-radio> &gt; 1000V</div>'
    + '<ion-checkbox formcontrolname="statutRapportOrganismeInspection"></ion-checkbox>'
    + '<div formarrayname="rapportOrganismeInspection"><input type="file" style="display:none"><span>Importer</span></div>'
    + '<ion-input formcontrolname="nomAttestation"><input type="text"></ion-input>'
    + '<ion-button class="save"><span>Enregistrer</span></ion-button>');
    const sel = (id, name, levels) => document.getElementById(id).addEventListener('click', () => openPopover(document.getElementById(id), name, levels));
    sel('typologieTypeId','typologie',[['Bâtiment neuf','Bâtiment existant','Sans bâtiment']]);
    sel('selectedSiteId','site',[['Sol','Autre','Toiture'],['Industriel','Agricole'],['Serre','Stockage']]);
    sel('typeProductionIdId','production',[['Photovoltaïque','Photovoltaïque avec stockage','Photovoltaïque avec protection DC']]);
    inputs(['puissanceInstallee','nomAttestation']);
    document.querySelectorAll('[formcontrolname=isTensionSubMille] ion-radio').forEach((r,i) => r.addEventListener('click', () => { r.checked = true; r.classList.add('radio-checked'); log('radio', {index:i}); }));
    checkbox(document.querySelector('[formcontrolname=statutRapportOrganismeInspection]'), 'statutRapport');
    document.querySelector('input[type=file]').addEventListener('change', e => log('file', {name: e.target.files[0].name, size: e.target.files[0].size}));
    document.querySelector('.save').addEventListener('click', () => { state.edited = true; log('save', {}); go('list'); });
  },
  confirm(){
    h('<ion-button><span>Confirmer</span></ion-button><ion-button class="reg" style="display:none"><span>Enregistrer</span></ion-button>');
    document.querySelector('ion-button').addEventListener('click', () => { log('confirmer', {}); document.querySelector('.reg').style.display = 'inline-block'; });
    document.querySelector('.reg').addEventListener('click', () => go('sign'));
  },
  sign(){
    h('<label><ion-checkbox></ion-checkbox> Je confirme</label><ion-button class="sign"><span>Signer et envoyer</span></ion-button>');
    checkbox(document.querySelector('ion-checkbox'), 'jeConfirme');
    document.querySelector('.sign').addEventListener('click', () => { log('signed', {}); go('end'); });
  },
  end(){ h('<p>Attestation envoyée</p>'); },
};
function go(v){ views[v](); }
go(location.pathname.includes('connexion') ? 'login' : 'home');
</script></body></html>`;

export async function startMockSite(): Promise<{
  url: string;
  events: MockEvent[];
  close: () => Promise<void>;
}> {
  const events: MockEvent[] = [];
  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/__log') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        events.push(JSON.parse(body));
        res.end('ok');
      });
      return;
    }
    if (req.url === '/dre.pdf') {
      res.setHeader('content-type', 'application/pdf');
      res.end(Buffer.from('%PDF-1.4 fake dre content'));
      return;
    }
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(PAGE);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    events,
    close: () => new Promise((r) => server.close(() => r())),
  };
}
