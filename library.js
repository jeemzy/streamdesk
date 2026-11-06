/* StreamDesk Media Library — playlists, liked videos, locally imported Watch Later.
 * No OAuth secrets or tokens are stored. Playlist classification and local imports
 * remain on this device. This module is distinct from Watch History Manager.
 */
(() => {
  'use strict';
  const PAGE_SIZE = 32;
  const LABELS_KEY = 'streamdesk_library_labels_v1';
  const LOCAL_DB_NAME = 'streamdesk_library_local_v1';
  const SERVICE = {youtube:'YouTube', music:'YouTube Music', unknown:'Не определено'};
  const state = {
    playlists: [], playlistRows:new Map(), likes:[], watchlater:[], metadata:new Map(),
    loaded:false, loading:false, generation:0, errors:[],
    source:'all',service:'all',playlist:'all',search:'',channelSearch:'',
    channels:new Set(),channelsOpen:false,page:0,
    playlistTypes:{},videoTypes:{},db:null
  };
  const $ = id => document.getElementById(id);
  const $$ = selector => Array.from(document.querySelectorAll(selector));
  const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
  const fmt = v => Number(v||0).toLocaleString('ru-RU');
  const norm = v => String(v||'').trim().toLocaleLowerCase('ru-RU');
  const safeUrl = value => {try {const u=new URL(String(value));return u.protocol==='https:'?u.href:'';}catch(_){return ''}};
  const validVideoId = id => typeof id==='string' && /^[A-Za-z0-9_-]{11}$/.test(id);
  const isLoggedIn = () => !!window.StreamDeskAPI?.isAuthorized();
  const api = (name,...args) => window.StreamDeskAPI[name](...args);
  const message = (text,type='success') => {
    const root=$('toastRegion');
    const node=document.createElement('div');
    node.className='toast'+(type==='success'?'':' '+type);
    node.textContent=String(text);root.appendChild(node);
    setTimeout(()=>node.remove(),type==='error'?9500:6500);
  };
  function restoreLabels(){
    try {
      const d=JSON.parse(localStorage.getItem(LABELS_KEY)||'{}');
      state.playlistTypes = d.playlistTypes && typeof d.playlistTypes==='object' ? d.playlistTypes : {};
      state.videoTypes = d.videoTypes && typeof d.videoTypes==='object' ? d.videoTypes : {};
    } catch(_) {}
  }
  function saveLabels(){
    try {localStorage.setItem(LABELS_KEY,JSON.stringify({playlistTypes:state.playlistTypes,videoTypes:state.videoTypes}));}
    catch(_) {message('Категории не удалось сохранить в этом браузере.','warning');}
  }
  function typeForSource(id){
    return ['youtube','music'].includes(state.playlistTypes[id]) ? state.playlistTypes[id] : 'unknown';
  }
  function typeForEntry(e){
    if(['youtube','music','unknown'].includes(state.videoTypes[e.videoId])) return [state.videoTypes[e.videoId]];
    const types=new Set(e.sources.map(src=>typeForSource(src.id)));
    types.delete('unknown');
    return types.size ? [...types] : ['unknown'];
  }
  function sourceLabel(s){
    if(s.kind==='likes')return '♥ Лайки';
    if(s.kind==='watchlater')return '◷ Watch Later (импорт)';
    return s.title || 'Плейлист';
  }
  function listEntries(){
    // A video may appear in several playlists. Merge by video ID, keep all memberships.
    const grouped=new Map();
    function add(row,source){
      const id=String(row.videoId||''); if(!validVideoId(id))return;
      const info=state.metadata.get(id)||{};
      if(!grouped.has(id))grouped.set(id,{
        videoId:id,title:'',channel:'',channelId:'',thumb:'',addedAt:'',sources:[]
      });
      const e=grouped.get(id);
      const title=String(info.title||row.title||'').trim();
      if(title && (!e.title || /^(deleted|private|unavailable|недоступно)/i.test(e.title))) e.title=title;
      const channel=String(info.channel||row.channel||'').trim();
      if(channel && (!e.channel || e.channel==='Канал не определён'))e.channel=channel;
      if(info.channelId || row.channelId)e.channelId=String(info.channelId||row.channelId);
      e.thumb=safeUrl(info.thumb||row.thumb)||e.thumb;
      if(!e.addedAt || (row.addedAt && row.addedAt>e.addedAt))e.addedAt=row.addedAt;
      if(!e.sources.some(s=>s.id===source.id))e.sources.push(source);
    }
    for(const p of state.playlists)for(const row of state.playlistRows.get(p.id)||[])add(row,{kind:'playlist',id:p.id,title:p.title});
    for(const row of state.likes)add(row,{kind:'likes',id:'likes',title:'Лайки'});
    for(const row of state.watchlater)add(row,{kind:'watchlater',id:'watchlater',title:'Watch Later'});
    for(const e of grouped.values()){
      if(!e.title)e.title='Видео '+e.videoId;
      if(!e.channel)e.channel='Канал не определён';
      e.channelKey=e.channelId||'name:'+norm(e.channel);
      e.types=typeForEntry(e);
      e.url='https://www.youtube.com/watch?v='+e.videoId;
    }
    return [...grouped.values()];
  }
  function bySource(rows){
    return rows.filter(e=>{
      if(state.source==='likes'&&!e.sources.some(s=>s.kind==='likes'))return false;
      if(state.source==='watchlater'&&!e.sources.some(s=>s.kind==='watchlater'))return false;
      if(state.source==='playlists'&&!e.sources.some(s=>s.kind==='playlist'))return false;
      if(state.playlist!=='all'&&!e.sources.some(s=>s.id===state.playlist))return false;
      if(state.service!=='all'&&!e.types.includes(state.service))return false;
      const query=norm(state.search);
      if(query && !norm(e.title+' '+e.channel+' '+e.sources.map(sourceLabel).join(' ')).includes(query))return false;
      return true;
    });
  }
  function filteredEntries(){
    return bySource(listEntries()).filter(e=>!state.channels.size||state.channels.has(e.channelKey));
  }
  function channelOptions(){
    const counts=new Map();
    for(const e of bySource(listEntries())){
      const existing=counts.get(e.channelKey)||{key:e.channelKey,name:e.channel,count:0};
      existing.count+=1;counts.set(e.channelKey,existing);
    }
    return [...counts.values()].sort((a,b)=>a.name.localeCompare(b.name,'ru',{sensitivity:'base'}));
  }
  function renderChannelOptions(){
    const q=norm(state.channelSearch);
    const options=channelOptions();
    const show=options.filter(ch=>!q||norm(ch.name).includes(q));
    $('libraryChannelOptionCount').textContent=fmt(show.length)+' из '+fmt(options.length)+' каналов';
    $('libraryChannelOptions').innerHTML=show.length?show.map(ch=>
      '<label class="library-channel-option"><input type="checkbox" data-library-channel="'+esc(encodeURIComponent(ch.key))+'" '+(state.channels.has(ch.key)?'checked':'')+'><span class="library-option-name">'+esc(ch.name)+'</span><small>'+fmt(ch.count)+'</small></label>'
    ).join(''):'<p class="library-no-options">Нет подходящих каналов</p>';
    $('libraryChannelToggle').innerHTML=(state.channels.size?'Выбрано каналов: '+fmt(state.channels.size):'Все каналы')+' <span>⌄</span>';
    $('libraryChannelToggle').setAttribute('aria-expanded',String(state.channelsOpen));
    $('libraryChannelMenu').classList.toggle('hidden',!state.channelsOpen);
    const existing=new Map(options.map(ch=>[ch.key,ch]));
    $('libraryChannelChips').classList.toggle('hidden',!state.channels.size);
    $('libraryChannelChips').innerHTML=[...state.channels].map(key=>
      '<button type="button" class="library-channel-chip" data-library-remove-channel="'+esc(encodeURIComponent(key))+'" title="Убрать фильтр по каналу">'+esc(existing.get(key)?.name||key.replace(/^name:/,''))+' <span>×</span></button>'
    ).join('');
  }
  function renderPlaylistOptions(){
    const select=$('libraryPlaylist');const previous=state.playlist;
    select.innerHTML='<option value="all">Все плейлисты</option>'+state.playlists.map(p=>
      '<option value="'+esc(p.id)+'">'+esc(p.title)+' ('+fmt(p.itemCount)+')</option>'
    ).join('');
    select.value=previous;
    if(select.value!==previous){state.playlist='all';select.value='all';}
    select.disabled=state.source==='likes'||state.source==='watchlater';
  }
  function renderTypeList(){
    const types=[{id:'likes',title:'♥ Лайки'},{id:'watchlater',title:'◷ Watch Later'},...state.playlists.map(p=>({id:p.id,title:p.title}))];
    $('libraryTypeList').innerHTML=types.map(src=>
      '<label class="library-type-row"><span title="'+esc(src.title)+'">'+esc(src.title)+'</span><select class="control-select" data-library-source-type="'+esc(src.id)+'" aria-label="Категория: '+esc(src.title)+'">'+
      '<option value="unknown" '+(typeForSource(src.id)==='unknown'?'selected':'')+'>Не определено</option>'+
      '<option value="youtube" '+(typeForSource(src.id)==='youtube'?'selected':'')+'>YouTube</option>'+
      '<option value="music" '+(typeForSource(src.id)==='music'?'selected':'')+'>YouTube Music</option>'+
      '</select></label>'
    ).join('');
  }
  function rowHtml(e){
    const sourceNames=e.sources.map(sourceLabel);
    const services=e.types.map(t=>'<span class="library-category '+t+'">'+esc(SERVICE[t]||SERVICE.unknown)+'</span>').join('');
    const thumb=e.thumb||('https://i.ytimg.com/vi/'+e.videoId+'/mqdefault.jpg');
    const date=e.addedAt&&Number.isFinite(Date.parse(e.addedAt)) ? new Date(e.addedAt).toLocaleDateString('ru-RU') : '';
    const edit=state.videoTypes[e.videoId]||'auto';
    return '<article class="library-video">'+
      '<a class="library-thumb" href="'+e.url+'" target="_blank" rel="noopener noreferrer" aria-label="Открыть '+esc(e.title)+'"><img src="'+esc(thumb)+'" alt="" loading="lazy"></a>'+
      '<div class="library-video-main"><a class="library-video-title" href="'+e.url+'" target="_blank" rel="noopener noreferrer">'+esc(e.title)+'</a>'+
      '<div class="library-video-sub">'+esc(e.channel)+(date?' · '+esc(date):'')+'</div>'+
      '<div class="library-video-tags">'+services+sourceNames.slice(0,3).map(n=>'<span class="library-source-tag" title="'+esc(n)+'">'+esc(n)+'</span>').join('')+(sourceNames.length>3?'<span class="library-source-tag">+'+(sourceNames.length-3)+'</span>':'')+'</div></div>'+
      '<label class="library-video-edit">Тип<select data-library-video-type="'+esc(e.videoId)+'" aria-label="Категория видео '+esc(e.title)+'"><option value="auto" '+(edit==='auto'?'selected':'')+'>По плейлисту</option><option value="youtube" '+(edit==='youtube'?'selected':'')+'>YouTube</option><option value="music" '+(edit==='music'?'selected':'')+'>Music</option><option value="unknown" '+(edit==='unknown'?'selected':'')+'>Неизвестно</option></select></label></article>';
  }
  function renderRows(filtered){
    const counts=new Map();for(const e of filtered)counts.set(e.channelKey,(counts.get(e.channelKey)||0)+1);
    const ordered=filtered.slice().sort((a,b)=>
      (counts.get(b.channelKey)-counts.get(a.channelKey)) ||
      a.channel.localeCompare(b.channel,'ru',{sensitivity:'base'}) ||
      a.title.localeCompare(b.title,'ru',{sensitivity:'base'})
    );
    const pages=Math.max(1,Math.ceil(ordered.length/PAGE_SIZE));
    state.page=Math.max(0,Math.min(state.page,pages-1));
    const slice=ordered.slice(state.page*PAGE_SIZE,(state.page+1)*PAGE_SIZE);
    let last='',html='';
    for(const e of slice){
      if(last!==e.channelKey){last=e.channelKey;html+='<div class="library-group-heading"><div class="library-group-avatar">'+esc(e.channel.slice(0,1).toUpperCase())+'</div><div><strong>'+esc(e.channel)+'</strong><span>'+fmt(counts.get(e.channelKey))+' видео в выбранных источниках</span></div></div>';}
      html+=rowHtml(e);
    }
    $('libraryList').innerHTML=html||'<div class="empty-state"><span>⌕</span><h3>Ничего не найдено</h3><p>Попробуй снять фильтры или подгрузить ещё плейлисты.</p></div>';
    $('libraryPaginator').classList.toggle('hidden',pages<=1);
    $('libraryPageLabel').textContent=(state.page+1)+' / '+pages;
    const prev=document.querySelector('[data-library-action="prev"]'),next=document.querySelector('[data-library-action="next"]');
    prev.disabled=state.page===0;next.disabled=state.page===pages-1;
  }
  function render(){
    const all=listEntries(),filtered=bySource(all).filter(e=>!state.channels.size||state.channels.has(e.channelKey));
    $('libStatVideos').textContent=fmt(all.length);
    $('libStatChannels').textContent=fmt(new Set(all.map(e=>e.channelKey)).size);
    $('libStatPlaylists').textContent=fmt(state.playlists.length);
    $('libStatLikes').textContent=fmt(state.likes.length);
    $('navLibraryCount').textContent=all.length?fmt(all.length):'—';
    $('libraryImportedCount').textContent='Локальных видео: '+fmt(state.watchlater.length);
    $('libraryResultCaption').textContent=fmt(filtered.length)+' видео'+(filtered.length!==all.length?' из '+fmt(all.length):'')+(state.loading?' · идёт загрузка…':'');
    $$('.library-service').forEach(el=>el.classList.toggle('active',el.dataset.libraryService===state.service));
    $$('.library-source').forEach(el=>el.classList.toggle('active',el.dataset.librarySource===state.source));
    renderPlaylistOptions();renderChannelOptions();renderTypeList();renderRows(filtered);
  }
  function setNotice(text,isError=false){
    $('libraryNotice').textContent=text;
    $('libraryNotice').classList.toggle('library-error',isError);
  }
  function enter(){
    render();
    if(isLoggedIn()&&!state.loaded&&!state.loading)load();
    else if(!isLoggedIn()&&!state.loaded)setNotice('Войди через Google для загрузки плейлистов и лайков. Локально импортированный Watch Later доступен без входа.');
  }
  function resetLive(){
    state.generation++;
    state.loading=false;state.loaded=false;state.playlists=[];state.playlistRows=new Map();state.likes=[];state.metadata=new Map();state.errors=[];
    setNotice('Аккаунт отключён. Локально импортированный Watch Later остаётся на этом устройстве.');render();
  }
  function authChanged(){
    if(isLoggedIn()&&$('view-library')&&!$('view-library').classList.contains('hidden'))load();
  }
  async function load(){
    if(state.loading)return;
    if(!isLoggedIn()){setNotice('Для загрузки медиатеки войди через Google.');return;}
    const gen=++state.generation;
    state.loading=true;state.loaded=false;state.errors=[];
    state.playlists=[];state.playlistRows=new Map();state.likes=[];state.metadata=new Map();
    setNotice('Загружаю список плейлистов…');render();
    try {
      let cursor='',count=0;
      do{
        const result=await api('getPlaylistsPage',cursor);
        if(gen!==state.generation)return;
        state.playlists.push(...result.items.filter(x=>x.id));
        cursor=result.nextPageToken||'';
        if(++count>100)throw new Error('Слишком много страниц плейлистов — загрузка остановлена для безопасности.');
      }while(cursor);
      render();
      // Liked videos: the API is capped to 1000 recent likes per account.
      setNotice('Плейлисты: '+fmt(state.playlists.length)+'. Загружаю лайки (до 1000)…');
      try{
        cursor='';count=0;
        do{
          const result=await api('getLikedVideosPage',cursor);
          if(gen!==state.generation)return;
          state.likes.push(...result.items);
          cursor=result.nextPageToken||'';
          count++;
          if(count>=20)cursor='';
        }while(cursor);
      }catch(e){state.errors.push('Лайки: '+String(e.message||e));}
      render();
      let total=0;
      for(let i=0;i<state.playlists.length;i++){
        if(gen!==state.generation)return;
        const p=state.playlists[i];
        setNotice('Загружаю видео: плейлист '+fmt(i+1)+' из '+fmt(state.playlists.length)+' · '+p.title);
        const rows=[];cursor='';count=0;
        try{
          do{
            const result=await api('getPlaylistItemsPage',p.id,cursor);
            if(gen!==state.generation)return;
            rows.push(...result.items.filter(x=>validVideoId(x.videoId)));
            total+=result.items.length;
            cursor=result.nextPageToken||'';
            if(++count>300){state.errors.push(p.title+': более 15 000 видео, дальнейшая загрузка остановлена');cursor='';}
            if(total>50000){state.errors.push('Общий предел в 50 000 элементов достигнут');cursor='';}
          }while(cursor);
          state.playlistRows.set(p.id,rows);
        }catch(e){state.errors.push(p.title+': '+String(e.message||e));state.playlistRows.set(p.id,rows);}
        if(i%3===0||i===state.playlists.length-1)render();
        if(total>50000)break;
      }
      // Some playlist items do not contain the uploader's channel metadata.
      await enrichMissing(gen);
      if(gen!==state.generation)return;
      state.loaded=true;
      setNotice(state.errors.length
        ? 'Загрузка завершена частично. '+state.errors.slice(0,3).join(' · ')+(state.errors.length>3?' · и ещё ошибок: '+(state.errors.length-3):'')
        : 'Загружено: '+fmt(state.playlists.length)+' плейлистов, '+fmt(state.likes.length)+' лайков. Watch Later импортируется отдельно.',state.errors.length>0);
      render();
    }catch(e){
      if(gen!==state.generation)return;
      state.errors.push(e.message||String(e));
      setNotice('Ошибка загрузки YouTube: '+String(e.message||e),true);message('Медиатека: '+String(e.message||e),'error');
    }finally{if(gen===state.generation){state.loading=false;render();}}
  }
  async function enrichMissing(gen){
    if(!isLoggedIn())return;
    const unresolved=listEntries().filter(e=>!e.channelId||e.channel==='Канал не определён'||e.title.startsWith('Видео '));
    const ids=[...new Set(unresolved.map(e=>e.videoId))].filter(validVideoId);
    if(!ids.length)return;
    setNotice('Уточняю авторов: '+fmt(ids.length)+' видео…');
    for(let i=0;i<ids.length;i+=50){
      if(gen!==state.generation)return;
      try {const rows=await api('getVideoDetails',ids.slice(i,i+50));for(const row of rows)state.metadata.set(row.videoId,row);}
      catch(e){state.errors.push('Уточнение каналов: '+String(e.message||e));break;}
    }
  }
  function csvSafe(value){
    let s=String(value==null?'':value);
    if(/^[\s\u0000-\u001f]*[=+@-]/.test(s))s="'"+s;
    return '"'+s.replace(/"/g,'""')+'"';
  }
  function exportCsv(){
    const rows=filteredEntries();if(!rows.length){message('Нет видео под текущими фильтрами.','warning');return;}
    const head=['Название видео','Канал','ID канала','ID видео','Ссылка','Категория','Источники','ID плейлистов','Дата добавления'];
    const table=[head,...rows.map(e=>[e.title,e.channel,e.channelId,e.videoId,e.url,e.types.map(t=>SERVICE[t]).join('; '),e.sources.map(sourceLabel).join('; '),e.sources.filter(x=>x.kind==='playlist').map(x=>x.id).join('; '),e.addedAt])];
    const csv='\ufeff'+table.map(row=>row.map(csvSafe).join(',')).join('\r\n');
    const url=URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8'}));
    const a=document.createElement('a');a.href=url;a.download='streamdesk-library-'+new Date().toISOString().slice(0,10)+'.csv';
    document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),3000);
    message('CSV экспортирован: '+fmt(rows.length)+' видео.');
  }
  function openLocalDb(){
    return new Promise((resolve,reject)=>{
      if(!('indexedDB'in window)){reject(new Error('IndexedDB недоступна'));return;}
      const req=indexedDB.open(LOCAL_DB_NAME,1);
      req.onupgradeneeded=()=>{if(!req.result.objectStoreNames.contains('watchlater'))req.result.createObjectStore('watchlater',{keyPath:'videoId'});};
      req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);
    });
  }
  function readLocal(){
    if(!state.db)return Promise.resolve([]);
    return new Promise((resolve,reject)=>{
      const req=state.db.transaction('watchlater').objectStore('watchlater').getAll();
      req.onsuccess=()=>resolve(req.result||[]);req.onerror=()=>reject(req.error);
    });
  }
  function saveLocal(items){
    if(!state.db)return Promise.resolve(false);
    return new Promise((resolve,reject)=>{
      const tx=state.db.transaction('watchlater','readwrite');
      const store=tx.objectStore('watchlater');store.clear();
      for(const row of items)store.put(row);
      tx.oncomplete=()=>resolve(true);tx.onerror=()=>reject(tx.error);
    });
  }
  function csvRows(text){
    // RFC4180-compatible parser (commas, semicolons, tabs, quotes and quoted newlines).
    const sample=String(text||'').split(/\r?\n/).slice(0,6).join('\n');
    const delimiter=['\t',',',';'].sort((a,b)=>sample.split(b).length-sample.split(a).length)[0];
    const out=[];let row=[],field='',quoted=false;
    text=String(text||'').replace(/^\ufeff/,'');
    for(let i=0;i<text.length;i++){
      const ch=text[i];
      if(ch==='"'){if(quoted&&text[i+1]==='"'){field+='"';i++;}else quoted=!quoted;}
      else if(ch===delimiter&&!quoted){row.push(field);field='';}
      else if((ch==='\n'||ch==='\r')&&!quoted){if(ch==='\r'&&text[i+1]==='\n')i++;row.push(field);if(row.some(x=>x.trim()))out.push(row);row=[];field='';}
      else field+=ch;
    }
    row.push(field);if(row.some(x=>x.trim()))out.push(row);
    return out;
  }
  function idFrom(value){
    const s=String(value||'').trim();if(validVideoId(s))return s;
    try {const u=new URL(s);if(['www.youtube.com','youtube.com','m.youtube.com','music.youtube.com'].includes(u.hostname))return u.searchParams.get('v')||'';if(['youtu.be','www.youtu.be'].includes(u.hostname))return u.pathname.replace(/^\//,'').split('/')[0];}catch(_){}
    return '';
  }
  function normalizeImported(v){
    const id=idFrom(v.videoId||v['Video ID']||v.id||v.url||v.URL||v.link||v['Video URL']||'');
    if(!validVideoId(id))return null;
    return {videoId:id,title:String(v.title||v.Title||v['Video Title']||'').trim(),
      channel:String(v.channel||v.Channel||v['Channel Title']||'').trim(),
      channelId:String(v.channelId||v['Channel ID']||''),
      addedAt:String(v.addedAt||v['Time Added']||v['Added At']||''),thumb:''};
  }
  function parseImport(text,filename){
    let candidates=[];
    if(/\.json$/i.test(filename)){
      const data=JSON.parse(text);const arr=Array.isArray(data)?data:(data.items||data.videos||data.entries||[]);
      if(!Array.isArray(arr))throw new Error('JSON должен содержать массив видео.');
      candidates=arr.map(x=>typeof x==='string'?{videoId:x}:x);
    }else{
      const rows=csvRows(text);
      // Google Takeout playlist CSV may start with metadata before the Video ID header.
      let headIndex=rows.findIndex(r=>r.some(v=>/^(video\s*id|video\s*url|video\s*link|id видео|videoid|url|title|название|channel)$/i.test(String(v).trim())));
      if(headIndex>=0){
        const cols=rows[headIndex].map(v=>String(v||'').trim());
        candidates=rows.slice(headIndex+1).map(r=>Object.fromEntries(cols.map((col,i)=>[col,r[i]||''])));
      }else{
        candidates=rows.map(r=>({videoId:r[0]||'',title:r[1]||'',channel:r[2]||''}));
      }
    }
    const byId=new Map();for(const v of candidates){if(!v||typeof v!=='object')continue;const item=normalizeImported(v);if(item)byId.set(item.videoId,item);}
    return [...byId.values()];
  }
  async function importWatchLater(file){
    if(!file)return;
    if(file.size>25*1024*1024)throw new Error('Максимальный размер файла 25 МБ.');
    const rows=parseImport(await file.text(),file.name);
    if(!rows.length)throw new Error('Не найдено ID видео. Нужен CSV/JSON/TXT со столбцом Video ID или URL.');
    const seen=new Map(state.watchlater.map(x=>[x.videoId,x]));for(const item of rows)seen.set(item.videoId,{...seen.get(item.videoId),...item});
    state.watchlater=[...seen.values()];
    try {await saveLocal(state.watchlater);}catch(e){message('Импорт выполнен, но браузер не сохранил локальную копию.','warning');}
    state.page=0;render();message('Импорт Watch Later: '+fmt(rows.length)+' видео (локально).');
    if(isLoggedIn()){
      const gen=state.generation;await enrichMissing(gen);render();
    }
  }
  function clearFilters(){
    state.source='all';state.service='all';state.playlist='all';state.search='';state.channels.clear();state.channelSearch='';state.page=0;
    $('librarySearch').value='';$('libraryChannelSearch').value='';render();
  }
  function setFilters(){state.page=0;render();}
  async function init(){
    restoreLabels();
    try {state.db=await openLocalDb();state.watchlater=await readLocal();}catch(_){/* local import still works in-memory */}
    render();
  }
  document.addEventListener('click',async e=>{
    if(state.channelsOpen && !e.target.closest('#libraryChannelSelector')) {state.channelsOpen=false;renderChannelOptions();}
    const svc=e.target.closest('[data-library-service]');
    if(svc){state.service=svc.dataset.libraryService;setFilters();return;}
    const source=e.target.closest('[data-library-source]');
    if(source){state.source=source.dataset.librarySource;if(state.source!=='playlists')state.playlist='all';setFilters();return;}
    const chip=e.target.closest('[data-library-remove-channel]');
    if(chip){state.channels.delete(decodeURIComponent(chip.dataset.libraryRemoveChannel));setFilters();return;}
    const act=e.target.closest('[data-library-action]');
    if(act){
      switch(act.dataset.libraryAction){
        case 'refresh':await load();break;
        case 'export':exportCsv();break;
        case 'toggle-channels':state.channelsOpen=!state.channelsOpen;renderChannelOptions();if(state.channelsOpen)$('libraryChannelSearch').focus();break;
        case 'clear-channels':state.channels.clear();setFilters();break;
        case 'clear-filters':clearFilters();break;
        case 'prev':state.page=Math.max(0,state.page-1);render();break;
        case 'next':state.page++;render();break;
        case 'import-watchlater':$('libraryWatchLaterFile').click();break;
      }
      return;
    }
  });
  document.addEventListener('input',e=>{
    if(e.target.id==='librarySearch'){state.search=e.target.value;setFilters();}
    if(e.target.id==='libraryChannelSearch'){state.channelSearch=e.target.value;renderChannelOptions();}
  });
  document.addEventListener('change',e=>{
    const el=e.target;
    if(el.id==='libraryPlaylist') {state.playlist=el.value;state.source='playlists';setFilters();}
    else if(el.matches('[data-library-channel]')){
      const id=decodeURIComponent(el.dataset.libraryChannel);
      if(el.checked)state.channels.add(id);else state.channels.delete(id);
      setFilters();
    }else if(el.matches('[data-library-source-type]')){
      state.playlistTypes[el.dataset.librarySourceType]=el.value;saveLabels();setFilters();
    }else if(el.matches('[data-library-video-type]')){
      if(el.value==='auto')delete state.videoTypes[el.dataset.libraryVideoType];
      else state.videoTypes[el.dataset.libraryVideoType]=el.value;
      saveLabels();setFilters();
    }
  });
  $('libraryWatchLaterFile').addEventListener('change',async e=>{
    try{await importWatchLater(e.target.files?.[0]);}catch(err){message(String(err.message||err),'error');}
    e.target.value='';
  });
  document.addEventListener('keydown',e=>{
    if(e.key==='Escape'&&state.channelsOpen){state.channelsOpen=false;renderChannelOptions();$('libraryChannelToggle').focus();}
  });
  window.StreamDeskLibrary=Object.freeze({enter,authChanged,resetLive});
  init();
})();