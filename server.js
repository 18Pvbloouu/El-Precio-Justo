// Servidor sin dependencias: sirve el juego, sincroniza salas por SSE y cachea imágenes reales (Wikipedia/Wikimedia).
const http=require('http'),https=require('https'),fs=require('fs'),path=require('path'),os=require('os');
const PORT=process.env.PORT||3000,rooms={};
const room=c=>rooms[c]||(rooms[c]={cl:new Set(),last:{}});

// ---------- Imágenes reales: se descargan UNA vez y se guardan en /cache ----------
const CACHE=process.env.CACHE_DIR||path.join(__dirname,'cache');fs.mkdirSync(CACHE,{recursive:true});
const MAX_MB=Number(process.env.CACHE_MAX_MB)||100;  // tope de espacio: al pasarlo se borran las imágenes más antiguas
const files=()=>fs.readdirSync(CACHE).map(f=>{const p=path.join(CACHE,f),s=fs.statSync(p);return{f,p,b:s.size,t:s.mtimeMs}});
const stats=()=>{const l=files().filter(x=>!x.f.endsWith('.json'));return{archivos:l.length,bytes:l.reduce((a,x)=>a+x.b,0)}};
function trim(){try{let l=files().filter(x=>!x.f.endsWith('.json')).sort((a,b)=>a.t-b.t),tot=l.reduce((a,x)=>a+x.b,0);
  if(tot<=MAX_MB*1048576)return;for(const x of l){if(tot<=MAX_MB*1048576*0.8)break;tot-=x.b;fs.unlinkSync(x.p);try{fs.unlinkSync(x.p.replace(/\.[a-z]+$/,'.json'))}catch(e){}}}catch(e){}}
let lastClear=0;
const WIKI=process.env.WIKI_BASE||'https://en.wikipedia.org';
const UA=process.env.UA||'ElPrecioJusto/1.0 (https://github.com/18Pvbloouu/El-Precio-Justo; juego personal sin fines comerciales)';
const MIME={jpg:'image/jpeg',png:'image/png',webp:'image/webp',svg:'image/svg+xml'};
const CLUBES={'1. FC Köln':'1. FC Köln','AS Mónaco':'AS Monaco FC','Ajax':'AFC Ajax','B. Dortmund':'Borussia Dortmund','B. Leverkusen':'Bayer 04 Leverkusen','Bayer Leverkusen':'Bayer 04 Leverkusen','B. Mönchengladbach':'Borussia Mönchengladbach','Bayern':'FC Bayern Munich','Benfica':'S.L. Benfica','Bologna':'Bologna FC 1909','Bournemouth':'AFC Bournemouth','Brentford':'Brentford FC','Brescia':'Brescia Calcio','Brighton':'Brighton & Hove Albion F.C.','Cagliari':'Cagliari Calcio','Chelsea':'Chelsea F.C.','Crystal Palace':'Crystal Palace F.C.','Dinamo Batumi':'FC Dinamo Batumi','Everton':'Everton F.C.','Fenerbahçe':'Fenerbahçe S.K. (football)','Fiorentina':'ACF Fiorentina','Flamengo':'CR Flamengo','Hamburgo':'Hamburger SV','Hoffenheim':'TSG 1899 Hoffenheim','Hull City':'Hull City A.F.C.','Inter':'Inter Milan','Internacional':'Sport Club Internacional','Juventus':'Juventus F.C.','Lazio':'S.S. Lazio','Leeds United':'Leeds United F.C.','Leicester':'Leicester City F.C.','Lille':'Lille OSC','Liverpool':'Liverpool F.C.','MK Dons':'Milton Keynes Dons F.C.','Man. City':'Manchester City F.C.','Manchester City':'Manchester City F.C.','Man. United':'Manchester United F.C.','Málaga':'Málaga CF','Newcastle':'Newcastle United F.C.','Nottingham Forest':'Nottingham Forest F.C.','Nápoles':'S.S.C. Napoli','Olympique Lyon':'Olympique Lyonnais','Olympique Marsella':'Olympique de Marseille','PSG':'Paris Saint-Germain F.C.','PSV':'PSV Eindhoven','Palermo':'Palermo F.C.','Palmeiras':'Sociedade Esportiva Palmeiras','Parma':'Parma Calcio 1913','Peñarol':'Club Atlético Peñarol','RB Salzburgo':'FC Red Bull Salzburg','Racing Club':'Racing Club de Avellaneda','Real Madrid':'Real Madrid CF','Rennes':'Stade Rennais F.C.','River Plate':'Club Atlético River Plate','Santos':'Santos FC','Schalke 04':'FC Schalke 04','Sevilla':'Sevilla FC','Shakhtar':'FC Shakhtar Donetsk','Sheffield United':'Sheffield United F.C.','Southampton':'Southampton F.C.','Stuttgart':'VfB Stuttgart','Tottenham':'Tottenham Hotspur F.C.','Udinese':'Udinese Calcio','Valencia':'Valencia CF','Villarreal':'Villarreal CF','Werder Bremen':'SV Werder Bremen','West Ham':'West Ham United F.C.','Wolfsburgo':'VfL Wolfsburg','Wolverhampton':'Wolverhampton Wanderers F.C.','Arsenal':'Arsenal F.C.','Aston Villa':'Aston Villa F.C.','Atalanta':'Atalanta BC','Athletic Club':'Athletic Bilbao','Al-Nassr':'Al-Nassr FC','Al-Ittihad':'Al-Ittihad Club (Jeddah)','Inter Miami':'Inter Miami CF'};
const norm=s=>s.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
const toks=s=>norm(s).split(/[^a-z0-9]+/).filter(w=>w.length>=3&&!['football','club','footballer'].includes(w));
const same=(title,name)=>{const t=norm(title);return toks(name).some(w=>t.includes(w))};
function get(url,bin,n=0){return new Promise((ok,ko)=>{
  const lib=url.startsWith('https')?https:http;
  const rq=lib.get(url,{headers:{'User-Agent':UA,Accept:bin?'image/*':'application/json'}},r=>{
    if(r.statusCode>=300&&r.statusCode<400&&r.headers.location&&n<4){r.resume();return ok(get(new URL(r.headers.location,url).href,bin,n+1))}
    if(r.statusCode!==200){r.resume();const e=new Error('HTTP '+r.statusCode);e.status=r.statusCode;return ko(e)}
    const c=[];let len=0;r.on('data',d=>{len+=d.length;if(len>3e6){r.destroy();ko(new Error('imagen demasiado grande'))}else c.push(d)});
    r.on('end',()=>ok({buf:Buffer.concat(c),type:r.headers['content-type']||''}));r.on('error',ko)});
  rq.on('error',ko);rq.setTimeout(10000,()=>rq.destroy(new Error('timeout')))})}
// Máx. 3 descargas a la vez y reintentos con espera si Wikipedia responde 429/5xx o tarda demasiado
const cola=[];let act=0;
function limited(fn){return new Promise((ok,ko)=>{cola.push({fn,ok,ko});bomba()})}
function bomba(){while(act<3&&cola.length){const j=cola.shift();act++;j.fn().then(j.ok,j.ko).finally(()=>{act--;bomba()})}}
const trans=e=>e&&(e.status===429||e.status>=500||/timeout|ECONN|ENOTFOUND|EAI_AGAIN|socket/i.test(e.message||''));
async function wget(url,bin){for(let i=0;;i++){try{return await limited(()=>get(url,bin))}catch(e){if(!trans(e)||i>=2)throw e;await new Promise(r=>setTimeout(r,500*(i+1)))}}}
async function wikiThumb(q,club){
  // Los escudos casi siempre son imágenes "no libres": hay que pedir pilicense=any o la API no los devuelve.
  const u=WIKI+'/w/api.php?action=query&generator=search&gsrsearch='+encodeURIComponent(q)+'&gsrlimit=1&prop=pageimages|info&inprop=url&piprop=thumbnail&pithumbsize=400'+(club?'&pilicense=any':'')+'&format=json';
  const j=JSON.parse((await wget(u)).buf.toString('utf8')),p=Object.values((j.query||{}).pages||{})[0];
  if(!p)return null;
  let src=p.thumbnail&&p.thumbnail.source;
  if(!src&&club){try{const s=JSON.parse((await wget(WIKI+'/api/rest_v1/page/summary/'+encodeURIComponent(p.title.replace(/ /g,'_')))).buf.toString('utf8'));src=s.thumbnail&&s.thumbnail.source}catch(e){}}
  return src?{src,page:p.fullurl,title:p.title}:null}
const overrides=()=>{try{return JSON.parse(fs.readFileSync(path.join(__dirname,'data','imagenes.json'),'utf8'))}catch(e){return{}}};
const pend={},miss={},fails={};
function resolve(t,n){
  const base=path.join(CACHE,t+'-'+norm(n).replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,60));
  for(const e in MIME)if(fs.existsSync(base+'.'+e))return Promise.resolve({file:base+'.'+e,type:MIME[e]});
  if(miss[base]>Date.now())return Promise.reject(new Error('sin imagen (reintento en unos minutos)'));
  if(pend[base])return pend[base];
  return pend[base]=(async()=>{try{
    let src=overrides()[t+':'+n],meta={origen_manual:true};
    if(!src){
      const qn=t==='c'?(CLUBES[n]||n+' football club'):n,qs=t==='c'?[qn]:[n+' footballer',n+' (footballer)',n+' football player'];let r=null;
      let le=null;for(const q of qs){try{r=await wikiThumb(q,t==='c')}catch(e){le=e;r=null}if(r&&same(r.title,t==='c'?qn:n))break;r=null}
      if(!r)throw (le&&trans(le))?le:new Error('sin imagen verificable para '+n+(le?' ('+le.message+')':''));
      src=r.src;meta={pagina_wikipedia:r.page,titulo:r.title,imagen_origen:src}}
    const im=await wget(src,true),ext=/png/.test(im.type)?'png':/webp/.test(im.type)?'webp':/svg/.test(im.type)?'svg':'jpg';
    fs.writeFileSync(base+'.'+ext,im.buf);fs.writeFileSync(base+'.json',JSON.stringify({tipo:t,consulta:n,...meta},null,1));delete fails[t+':'+n];trim();
    return{file:base+'.'+ext,type:MIME[ext]};
  }catch(e){miss[base]=Date.now()+(trans(e)?8e3:6e5);fails[t+':'+n]=e.message;console.log('[imagen] no disponible: '+(t==='c'?'club ':'jugador ')+n+' ('+e.message+')');throw e}finally{delete pend[base]}})()}

http.createServer((q,s)=>{
  const u=new URL(q.url,'http://x'),c=(u.searchParams.get('room')||'').toUpperCase().slice(0,8);
  if(u.pathname==='/img'){
    const t=u.searchParams.get('t'),n=(u.searchParams.get('n')||'').slice(0,60);
    if(!['p','c'].includes(t)||!n){s.writeHead(400);return s.end('?')}
    return resolve(t,n).then(r=>fs.readFile(r.file,(e,d)=>{if(e){s.writeHead(404);return s.end()}s.writeHead(200,{'Content-Type':r.type,'Cache-Control':'public, max-age=604800'});s.end(d)}))
      .catch(()=>{s.writeHead(404,{'Cache-Control':'no-store'});s.end('sin imagen')})}
  if(u.pathname==='/salud'){s.writeHead(200,{'Content-Type':'text/plain'});return s.end('ok')}
  if(u.pathname==='/cache/info'){s.writeHead(200,{'Content-Type':'application/json'});return s.end(JSON.stringify({...stats(),max_mb:MAX_MB}))}
  if(u.pathname==='/cache/borrar'&&q.method==='POST'){
    s.writeHead(200,{'Content-Type':'application/json'});
    if(Date.now()-lastClear<30000)return s.end(JSON.stringify({error:'Espera unos segundos antes de volver a borrar.'}));
    lastClear=Date.now();const st=stats();let n=0;
    for(const x of files()){try{fs.unlinkSync(x.p);if(!x.f.endsWith('.json'))n++}catch(e){}}
    for(const k in miss)delete miss[k];for(const k in fails)delete fails[k];
    return s.end(JSON.stringify({borradas:n,bytes:st.bytes}))}
  if(u.pathname==='/imagenes-auditoria'){
    const l=fs.readdirSync(CACHE).filter(f=>f.endsWith('.json')).map(f=>JSON.parse(fs.readFileSync(path.join(CACHE,f),'utf8')));
    s.writeHead(200,{'Content-Type':'application/json; charset=utf-8'});return s.end(JSON.stringify({resueltas:l,fallidas:fails},null,1))}
  if(u.pathname==='/events'){
    s.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache',Connection:'keep-alive'});
    const r=room(c);r.cl.add(s);
    for(const k in r.last)s.write('data: '+r.last[k]+'\n\n');
    const ka=setInterval(()=>s.write(':\n\n'),20000);
    q.on('close',()=>{clearInterval(ka);r.cl.delete(s)});return;
  }
  if(u.pathname==='/emit'&&q.method==='POST'){
    let b='';q.on('data',d=>{b+=d;if(b.length>2e4)q.destroy()});
    q.on('end',()=>{try{const m=JSON.parse(b),r=room(c);r.last[m.data.me]=b;r.cl.forEach(x=>x.write('data: '+b+'\n\n'))}catch(e){}s.end('ok')});return;
  }
  // Archivos para instalar como app / generar APK (lista cerrada, sin rutas libres)
  const ST={'/manifest.webmanifest':['manifest.webmanifest','application/manifest+json'],'/sw.js':['sw.js','text/javascript'],'/icon-192.png':['icon-192.png','image/png'],'/icon-512.png':['icon-512.png','image/png'],'/icon-maskable-512.png':['icon-maskable-512.png','image/png'],'/.well-known/assetlinks.json':['.well-known/assetlinks.json','application/json']};
  if(ST[u.pathname])return fs.readFile(path.join(__dirname,'public',ST[u.pathname][0]),(e,d)=>{if(e){s.writeHead(404);return s.end('no existe')}s.writeHead(200,{'Content-Type':ST[u.pathname][1],'Cache-Control':u.pathname==='/sw.js'?'no-cache':'public, max-age=86400'});s.end(d)});
  fs.readFile(path.join(__dirname,'public','index.html'),(e,d)=>{
    if(e){s.writeHead(500);return s.end('Falta public/index.html')}
    s.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});s.end(d)});
}).listen(PORT,'0.0.0.0',()=>{
  console.log('EL PRECIO JUSTO\n  Este equipo: http://localhost:'+PORT);
  for(const l of Object.values(os.networkInterfaces()).flat())
    if(l.family==='IPv4'&&!l.internal)console.log('  Misma red wifi: http://'+l.address+':'+PORT);
});
