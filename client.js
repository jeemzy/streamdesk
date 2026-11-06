(function () {
  'use strict';

  const DEMO = false; // Live GitHub Pages edition (no synthetic channel data).
  const PAGE_SIZE = 30;
  const APP_DB = 'streamdesk_history_v1';
  const TYPE_LABELS = { youtube: 'YouTube', music: 'YouTube Music', unknown: 'Не определено' };
  const ST = {
    view: 'overview', subscriptions: [], subsLoaded: false, subsLoading: false,
    selectedSubs: new Set(), subSearch: '', subSort: 'name', subPage: 0,
    history: [], hidden: new Set(), historyLoaded: false, db: null,
    selectedHistory: new Set(), hType: 'all', hSearch: '', hChannel: '',
    hFrom: '', hTo: '', hOnlySubscribed: false, hPage: 0,
    modalSubmit: null, demoNoticeDismissed: false
  };
  const $ = (id) => document.getElementById(id);
  const qs = (selector) => document.querySelector(selector);
  const qsa = (selector) => Array.from(document.querySelectorAll(selector));

  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }
  function urlSafe(raw) {
    if (!raw) return '';
    try {
      const url = new URL(String(raw));
      return /^https?:$/.test(url.protocol) ? url.href : '';
    } catch (e) { return ''; }
  }
  function formatDate(value, long = false) {
    if (!value) return 'Дата неизвестна';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return 'Дата неизвестна';
    return new Intl.DateTimeFormat('ru-RU', long ? {
      day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit'
    } : {day: '2-digit', month: 'short', year: 'numeric'}).format(date);
  }
  function numberFmt(num) { return Number(num || 0).toLocaleString('ru-RU'); }
  function normalizeText(s) { return String(s || '').trim().toLocaleLowerCase('ru-RU'); }
  function delayPaint() { return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); }
  function toast(message, type = 'success') {
    const node = document.createElement('div');
    node.className = 'toast' + (type === 'success' ? '' : ' ' + type);
    node.textContent = String(message || '');
    $('toastRegion').appendChild(node);
    setTimeout(() => node.remove(), type === 'error' ? 9000 : 6000);
  }
  function updateStats() {
    $('statSubscriptions').textContent = ST.subsLoaded ? numberFmt(ST.subscriptions.length) : '—';
    $('statHistory').textContent = numberFmt(ST.history.length);
    $('statMusic').textContent = numberFmt(ST.history.filter(x => x.type === 'music').length);
    $('statChannels').textContent = numberFmt(new Set(ST.history.filter(x => x.channel).map(x => normalizeText(x.channel))).size);
    $('navSubsCount').textContent = ST.subsLoaded ? numberFmt(ST.subscriptions.length) : '—';
    ['all','youtube','music','unknown'].forEach(type => {
      const id = {all:'typeAllCount',youtube:'typeYoutubeCount',music:'typeMusicCount',unknown:'typeUnknownCount'}[type];
      $(id).textContent = numberFmt(type === 'all' ? ST.history.length : ST.history.filter(x => x.type === type).length);
    });
  }
  function activateView(view) {
    if (!['overview', 'subscriptions', 'history', 'library'].includes(view)) return;
    ST.view = view;
    qsa('.view-page').forEach(el => el.classList.toggle('hidden', el.id !== 'view-' + view));
    qsa('.side-nav .nav-item[data-view]').forEach(el => el.classList.toggle('active', el.dataset.view === view));
    $('breadcrumbCurrent').textContent = ({overview:'Обзор',subscriptions:'Подписки',history:'История просмотров',library:'Медиатека'})[view];
    if (view === 'subscriptions' && !ST.subsLoaded && !ST.subsLoading) loadSubscriptions();
    if (view === 'history') renderHistory();
    if (view === 'library') window.StreamDeskLibrary?.enter();
    window.scrollTo({top:0,behavior:'smooth'});
  }

  function apiCall(method, ...args) {
    if (!window.StreamDeskAPI || typeof window.StreamDeskAPI[method] !== 'function') {
      return Promise.reject(new Error('YouTube API не настроен. Проверьте загрузку oauth.js.'));
    }
    return window.StreamDeskAPI[method](...args);
  }

  function updateAuthUI() {
    const connected = !!window.StreamDeskAPI?.isAuthorized();
    const authButton = $('authButton');
    authButton.textContent = connected ? 'Отключиться' : 'Войти через Google';
    authButton.dataset.action = connected ? 'google-logout' : 'google-login';
    authButton.classList.toggle('logged-in', connected);
    $('modeText').textContent = connected ? 'YouTube подключён' : 'Google не подключён';
    $('modeChip').classList.toggle('is-demo', !connected);
    $('channelAvatar').title = connected ? 'Авторизация активна' : 'Аккаунт не подключён';
    if (connected) $('demoNotice').classList.add('hidden');
    else if (!ST.demoNoticeDismissed) $('demoNotice').classList.remove('hidden');
  }

  function showSigninPlaceholder() {
    ST.subsLoaded = false;
    $('subsList').innerHTML = '<div class="empty-state"><span>🔑</span><h3>Подключи YouTube</h3><p>Нажми «Войти через Google», чтобы загрузить свои подписки. Доступ будет запрошен Google.</p><button class="btn primary" type="button" data-action="google-login">Войти через Google</button></div>';
    $('subsResultCaption').textContent = 'Ожидаем авторизацию';
    $('subsPaginator').classList.add('hidden');
    $('subsBulkBar').classList.add('hidden');
    $('selectAllSubs').checked = false;
  }

  async function signInAction(btn) {
    // The OAuth popup must be requested directly inside the click gesture.
    const promise = window.StreamDeskAPI.signIn();
    btn.disabled = true;
    try {
      await promise;
      updateAuthUI();
      toast('Google подключён. Загружаем подписки.');
      await loadSubscriptions();
      window.StreamDeskLibrary?.authChanged();
      window.StreamDeskAPI.getCurrentChannel().then(info => {
        if (info?.title) {
          $('modeText').textContent = 'Канал: ' + info.title;
          $('channelAvatar').textContent = info.title.slice(0, 1).toUpperCase();
          $('channelAvatar').title = info.title;
        }
      }).catch(() => {});
    } catch(error) { toast(error.message || String(error), 'error'); }
    finally { btn.disabled = false; updateAuthUI(); }
  }

  function signOutAction() {
    window.StreamDeskAPI.signOut();
    ST.subscriptions = [];
    ST.subsLoaded = false;
    ST.selectedSubs.clear();
    ST.subPage = 0;
    ST.demoNoticeDismissed = false;
    $('channelAvatar').textContent = 'G';
    updateStats();
    updateAuthUI();
    showSigninPlaceholder();
    renderHistory();
    window.StreamDeskLibrary?.resetLive();
    toast('Отключено. История просмотров остаётся только в этом браузере.');
  }


  const DEMO_SUBS = [
    ['Pixel Workshop','Дизайн и технологии'], ['Frontend Daily','Веб-разработка и интерфейсы'],
    ['Научная орбита','Космос и открытия'], ['Music Sessions','Музыкальные подборки'],
    ['Техно-разбор','Гаджеты и обзоры'], ['Чистый код','Программирование'],
    ['Кадр за кадром','Кино и монтаж'], ['Digital Studio','Творческие проекты'],
    ['Городские истории','Документальные видео'], ['Motion Lab','Анимация и графика'],
    ['Morning Playlist','Музыка для работы'], ['Мир путешествий','Путешествия и культура']
  ].map((pair, i) => ({
    id: 'demo-subs-' + i, channelId: 'demo-channel-' + i, title: pair[0],
    description: pair[1], subscribedAt: new Date(Date.UTC(2026 - (i%3), i%12, i+1)).toISOString(),
    avatar: '', newVideos: 0
  }));
  let demoSubscriptions = DEMO_SUBS.slice();
  const DEMO_HISTORY = [
    ['Как устроены современные интерфейсы','Pixel Workshop','youtube'],
    ['Обзор новых инструментов разработки','Frontend Daily','youtube'],
    ['Midnight Drive — Live Session','Music Sessions','music'],
    ['Тайны далёких галактик','Научная орбита','youtube'],
    ['Design systems за 20 минут','Pixel Workshop','youtube'],
    ['Lo-fi focus mix','Morning Playlist','music'],
    ['Практика JavaScript: полезные паттерны','Чистый код','youtube'],
    ['Moonlight Piano','Music Sessions','music'],
    ['Как монтировать видео быстрее','Кадр за кадром','youtube'],
    ['Ночной город: атмосферное видео','Городские истории','youtube'],
    ['Неопознанное видео из архива','Другая площадка','unknown'],
    ['Секреты анимации текста','Motion Lab','youtube'],
    ['Electronic Waves','Morning Playlist','music'],
    ['Что нового в технологиях','Техно-разбор','youtube'],
    ['Путешествие по историческим местам','Мир путешествий','youtube'],
    ['Music for Coding','Morning Playlist','music']
  ].map((parts,i) => ({
    id:'demo-watch-'+i, title:parts[0],channel:parts[1], type:parts[2],
    channelUrl:'', channelId:'', url:'',
    time:new Date(Date.UTC(2026,10,6-(i%6),20-(i%12),i%60)).toISOString(),
    originalType:parts[2]
  }));
  function demoApi(method, args) {
    return new Promise((resolve) => {
      setTimeout(() => {
        if (method === 'getSubscriptionsPage') {
          resolve({items:demoSubscriptions.slice(), nextPageToken:null, approximateTotal:demoSubscriptions.length});
        } else if (method === 'unsubscribeMany') {
          const deleted = new Set(args[0]);
          demoSubscriptions = demoSubscriptions.filter(x => !deleted.has(x.id));
          resolve(args[0].map(id => ({id,ok:true})));
        } else if (method === 'subscribeToChannel') {
          const value = args[0] || '';
          resolve({id:'demo-sub-'+Date.now(),channelId:'demo-channel-'+Date.now(),title:value.replace(/^https?:\/\//,'')});
        }
      }, 190);
    });
  }

  async function loadSubscriptions() {
    if (!window.StreamDeskAPI?.isAuthorized()) { showSigninPlaceholder(); return; }
    if (ST.subsLoading) return;
    ST.subsLoading = true;
    $('subsResultCaption').textContent = 'Загружаем подписки из YouTube…';
    $('subsList').innerHTML = '<div class="empty-state"><span>↻</span><h3>Загружаем подписки</h3><p>Получаем список каналов с твоего YouTube-аккаунта.</p></div>';
    try {
      let all = [], token = '', pages = 0;
      do {
        const result = await apiCall('getSubscriptionsPage', token);
        all.push(...(result.items || []));
        token = result.nextPageToken || '';
        pages += 1;
        $('subsResultCaption').textContent = 'Загружено каналов: ' + numberFmt(all.length);
        if (pages > 600) throw new Error('Превышен безопасный предел страниц подписок.');
      } while (token);
      ST.subscriptions = all;
      ST.subsLoaded = true;
      ST.selectedSubs.clear();
      ST.subPage = 0;
      updateStats(); renderSubscriptions(); renderHistory();
      if (!all.length) toast('Активных подписок пока нет.', 'warning');
    } catch (error) {
      $('subsList').innerHTML = '<div class="empty-state"><span>!</span><h3>Не удалось загрузить подписки</h3><p>' + escapeHtml(error.message) + '</p><button class="btn primary" type="button" data-action="reload-subs">Повторить</button></div>';
      $('subsResultCaption').textContent = 'Ошибка подключения';
      toast(error.message, 'error');
    } finally { ST.subsLoading = false; }
  }

  function filteredSubs() {
    const query = normalizeText(ST.subSearch);
    const items = ST.subscriptions.filter(x => !query || normalizeText(x.title + ' ' + x.description).includes(query));
    return items.sort((a,b) => {
      if (ST.subSort === 'date-desc') return (Date.parse(b.subscribedAt)||0)-(Date.parse(a.subscribedAt)||0);
      if (ST.subSort === 'date-asc') return (Date.parse(a.subscribedAt)||0)-(Date.parse(b.subscribedAt)||0);
      return a.title.localeCompare(b.title,'ru',{sensitivity:'base'});
    });
  }
  function renderSubscriptions() {
    if (!ST.subsLoaded) return;
    const items = filteredSubs();
    const pages = Math.max(1,Math.ceil(items.length/PAGE_SIZE));
    ST.subPage = Math.max(0,Math.min(ST.subPage,pages-1));
    const sliced = items.slice(ST.subPage*PAGE_SIZE, ST.subPage*PAGE_SIZE+PAGE_SIZE);
    $('subsResultCaption').textContent = numberFmt(items.length) + (items.length===ST.subscriptions.length?' каналов':' из '+numberFmt(ST.subscriptions.length)+' каналов');
    $('selectAllSubs').checked = items.length > 0 && items.every(x => ST.selectedSubs.has(x.id));
    $('selectAllSubs').indeterminate = items.some(x => ST.selectedSubs.has(x.id)) && !$('selectAllSubs').checked;
    $('subsList').innerHTML = sliced.length ? sliced.map(x => {
      const url = /^UC[A-Za-z0-9_-]{22}$/.test(x.channelId) ? 'https://www.youtube.com/channel/'+x.channelId : '';
      const avatar = urlSafe(x.avatar);
      const title = escapeHtml(x.title);
      return '<div class="list-row">'+
        '<label class="custom-check"><input type="checkbox" data-select-sub="'+escapeHtml(x.id)+'" '+(ST.selectedSubs.has(x.id)?'checked':'')+' aria-label="Выбрать '+title+'"><span></span></label>'+
        '<div class="channel-avatar">'+(avatar ? '<img src="'+escapeHtml(avatar)+'" alt="" loading="lazy" onerror="this.remove()">' : escapeHtml(x.title.slice(0,1).toUpperCase()))+'</div>'+
        '<div class="row-text">'+(url?'<a class="row-title" href="'+url+'" target="_blank" rel="noopener noreferrer">'+title+' ↗</a>':'<span class="row-title">'+title+'</span>')+
        '<div class="row-caption">'+escapeHtml(x.description || 'Канал YouTube')+'</div></div>'+
        '<div class="row-end"><span class="row-date">С '+escapeHtml(formatDate(x.subscribedAt))+'</span>'+
        '<button class="row-icon-btn" type="button" data-action="delete-one-sub" data-id="'+escapeHtml(x.id)+'" aria-label="Отписаться от '+title+'" title="Отписаться"><svg viewBox="0 0 24 24"><path d="M4 7h16M10 4h4M6 7l1 13h10l1-13M10 11v6M14 11v6"/></svg></button></div></div>';
    }).join('') : '<div class="empty-state"><span>⌕</span><h3>Ничего не найдено</h3><p>Попробуй другой запрос или очисти поиск.</p></div>';
    $('subsPaginator').classList.toggle('hidden', pages<=1);
    $('subsPageLabel').textContent = (ST.subPage+1)+' / '+pages;
    qs('[data-action="sub-prev"]').disabled = ST.subPage===0;
    qs('[data-action="sub-next"]').disabled = ST.subPage>=pages-1;
    $('subsBulkBar').classList.toggle('hidden', ST.selectedSubs.size===0);
    $('subsSelectedCount').textContent = ST.selectedSubs.size;
  }

  function openModal(title, bodyHtml, confirmLabel, onSubmit, danger=false) {
    $('modalTitle').textContent = title;
    $('modalBody').innerHTML = bodyHtml;
    $('modalFooter').innerHTML = '<button class="btn secondary" data-action="close-modal" type="button">Отмена</button>'+ (onSubmit ? '<button class="btn '+(danger?'danger':'primary')+'" data-action="modal-submit" type="button">'+escapeHtml(confirmLabel)+'</button>' : '');
    ST.modalSubmit = onSubmit || null;
    $('modalBackdrop').classList.remove('hidden');
    document.body.style.overflow='hidden';
    setTimeout(() => { const el = $('modalBody').querySelector('input'); if (el) el.focus(); },20);
  }
  function closeModal() {
    $('modalBackdrop').classList.add('hidden');
    document.body.style.overflow='';
    ST.modalSubmit = null;
  }
  function openAddModal() {
    openModal('Добавить канал','<p>Вставь ссылку на YouTube-канал, его <b>@handle</b> или ID, который начинается на <b>UC</b>.</p><label class="form-field"><span>Канал YouTube</span><input id="newChannel" class="modal-input" type="text" placeholder="https://www.youtube.com/@GoogleDevelopers" autocomplete="off"></label><div class="modal-help">Для ссылки вида /c/название используй @handle или ID канала.</div>','Подписаться', async()=>{
      const value = $('newChannel').value.trim();
      if (!value) return toast('Введите ссылку или @handle.', 'warning');
      const submit = qs('[data-action="modal-submit"]'); submit.disabled=true;submit.textContent='Подписываемся…';
      try {
        const item = await apiCall('subscribeToChannel', value);
        closeModal();
        toast('Подписка добавлена: '+(item.title||value));
        if (DEMO) {
          const newDemo={...item,subscribedAt:new Date().toISOString(),avatar:'',description:'Демонстрационный канал'};
          ST.subscriptions.push(newDemo);demoSubscriptions.push(newDemo);
        }
        else { await loadSubscriptions(); return; }
        updateStats();renderSubscriptions();
      } catch (error) { toast(error.message,'error');submit.disabled=false;submit.textContent='Подписаться'; }
    });
  }
  function confirmUnsubscribe(ids) {
    const uniqueIds = [...new Set(ids)].filter(id => ST.subscriptions.some(x => x.id===id));
    if (!uniqueIds.length) return;
    openModal('Подтвердить отписку','<div class="modal-note">Это действие <b>отпишет твой аккаунт YouTube от '+numberFmt(uniqueIds.length)+' канал(ов)</b>. Изменения произойдут в самом YouTube.</div><p>Введи <b>ОТПИСАТЬСЯ</b>, чтобы подтвердить:</p><label class="form-field"><input id="unsubscribePhrase" class="modal-input" type="text" placeholder="ОТПИСАТЬСЯ" autocomplete="off" spellcheck="false"></label><div class="modal-help">YouTube API расходует 50 единиц квоты на каждую отписку. При большом количестве операций лимит может закончиться.</div>','Отписаться',async()=>{
      if ($('unsubscribePhrase').value.trim()!=='ОТПИСАТЬСЯ') return toast('Введите ОТПИСАТЬСЯ точно.','warning');
      const btn=qs('[data-action="modal-submit"]');btn.disabled=true;
      let ok=0, failed=[];
      for (let i=0;i<uniqueIds.length;i+=25) {
        const batch=uniqueIds.slice(i,i+25);btn.textContent='Удалено '+ok+' / '+uniqueIds.length;
        try {
          const result=await apiCall('unsubscribeMany',batch,'ОТПИСАТЬСЯ');
          result.forEach(r=>{if(r.ok){ok++;ST.subscriptions=ST.subscriptions.filter(x=>x.id!==r.id);ST.selectedSubs.delete(r.id);}else failed.push(r.error||'Ошибка YouTube API');});
          updateStats();renderSubscriptions();
        } catch(error){failed.push(error.message);break;}
      }
      closeModal();
      updateStats();renderSubscriptions();
      if(ok) toast('Отписка выполнена для '+ok+' канал(ов).');
      if(failed.length) toast('Не удалось удалить часть подписок: '+failed[0],'error');
    },true);
  }

  // HISTORY: Takeout is parsed locally; no watch records are sent to Apps Script.
  function kindFromTakeout(raw) {
    const header = normalizeText(raw.header || '');
    const products = Array.isArray(raw.products) ? raw.products.join(' ').toLowerCase() : '';
    const link = normalizeText(raw.titleUrl || raw.url || '');
    if (/youtube\s*music/.test(header) || /youtube\s*music/.test(products) || /music\.youtube\.com/.test(link)) return 'music';
    if (/^youtube$/.test(header) || /\byoutube\b/.test(products) || /(?:www\.)?youtube\.com\//.test(link) || /youtu\.be\//.test(link)) return 'youtube';
    return 'unknown';
  }
  function extractChannelId(link) {
    const match = String(link || '').match(/\/channel\/(UC[A-Za-z0-9_-]{22})/);
    return match ? match[1] : '';
  }
  function cleanHistoryTitle(raw) {
    const text = String(raw || '').replace(/\s+/g,' ').trim();
    return text.replace(/^(Watched|Просмотрено|Смотрели|Просмотр|Obejrzano|Oglądano|Visto|Visionné|Gesehen|Angesehen|Assistiu a|視聴した)\s*:?\s*/i,'').trim() || text || 'Без названия';
  }
  function normalizeHistoryRecord(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const url = urlSafe(raw.titleUrl || raw.url || '');
    const subtitles = Array.isArray(raw.subtitles) ? raw.subtitles : [];
    const firstSub = subtitles.find(x => x && (x.name || x.url)) || {};
    const channel = String(raw.channel || firstSub.name || '').trim() || 'Канал неизвестен';
    const channelUrl = urlSafe(raw.channelUrl || firstSub.url || '');
    const timeRaw = raw.time || raw.timestamp || '';
    const parsed = timeRaw ? new Date(timeRaw) : new Date(NaN);
    const time = !Number.isNaN(parsed.getTime()) ? parsed.toISOString() : '';
    const title = cleanHistoryTitle(raw.title || 'Без названия');
    const type = ['music','youtube','unknown'].includes(raw.type) ? raw.type : kindFromTakeout(raw);
    // Exact event identity. Repeated plays at different timestamps stay separate.
    const id = [time || String(timeRaw), url, title, channel].join('\u001f');
    return {id, title, url, channel, channelUrl, channelId:extractChannelId(channelUrl),time,
      type, originalType:type};
  }
  function parseHistoryJson(text) {
    let root;
    try { root = JSON.parse(text.replace(/^\uFEFF/,'')); }
    catch (error) { throw new Error('Некорректный JSON: '+error.message); }
    const arr = Array.isArray(root) ? root : (Array.isArray(root.items) ? root.items : null);
    if (!arr) throw new Error('Этот JSON не содержит список истории просмотров.');
    return arr.map(normalizeHistoryRecord).filter(Boolean);
  }
  function parseHistoryHtml(text) {
    const doc = new DOMParser().parseFromString(text,'text/html');
    let cells = Array.from(doc.querySelectorAll('.content-cell'));
    if (!cells.length) cells = Array.from(doc.querySelectorAll('.outer-cell'));
    const records=[];
    for (const cell of cells) {
      const anchors = Array.from(cell.querySelectorAll('a[href]'));
      const videoAnchor = anchors.find(a => /(?:music\.)?youtube\.com\/(?:watch\?|shorts\/|live\/)|youtu\.be\//i.test(a.href));
      if (!videoAnchor) continue;
      const channelAnchor = anchors.find(a => a!==videoAnchor && /youtube\.com\/(?:channel\/|@|user\/)/i.test(a.href));
      // .textContent doesn't insert line breaks for <br> elements in a detached DOM.
      const clone = cell.cloneNode(true);
      Array.from(clone.querySelectorAll('br')).forEach(br=>br.replaceWith(doc.createTextNode('\n')));
      const lines = clone.textContent.split('\n').map(x=>x.replace(/\s+/g,' ').trim()).filter(Boolean);
      const maybeDate = lines.slice().reverse().find(x=>/\b(19|20)\d{2}\b/.test(x)) || '';
      const cardHeader = cell.closest('.outer-cell')?.querySelector('.header-cell')?.textContent || '';
      const record = normalizeHistoryRecord({
        title: videoAnchor.textContent || 'Без названия',
        titleUrl:videoAnchor.href,
        subtitles:channelAnchor ? [{name:channelAnchor.textContent,url:channelAnchor.href}] : [],
        header: cardHeader,
        time:maybeDate
      });
      if(record) records.push(record);
    }
    if(!records.length) throw new Error('Не удалось найти просмотры в HTML. Попробуйте экспортировать историю в JSON.');
    return records;
  }

  /** Lightweight, dependency-free ZIP reader (stored + deflate-raw).
   * Reads only watch-history.json/html; rejects Zip64 and malformed entries.
   * Browser native DecompressionStream is used. Never uploads the ZIP.
   */
  async function unzipWatchHistory(file) {
    const buf = await file.arrayBuffer();
    const dv = new DataView(buf);
    const len = buf.byteLength;
    let eocd = -1;
    for(let p=len-22;p>=Math.max(0,len-65557);p--) {
      if(dv.getUint32(p,true)===0x06054b50){eocd=p;break;}
    }
    if(eocd<0) throw new Error('Архив ZIP повреждён или имеет неподдерживаемый формат.');
    const entries=dv.getUint16(eocd+10,true);
    const offset=dv.getUint32(eocd+16,true);
    if(offset===0xffffffff || entries===0xffff) throw new Error('ZIP64 не поддерживается. Извлеките watch-history.json из архива вручную.');
    let at=offset;
    const historyEntries=[];
    for(let i=0;i<entries;i++) {
      if(at+46>len || dv.getUint32(at,true)!==0x02014b50) throw new Error('Не удалось прочитать каталог ZIP.');
      const method=dv.getUint16(at+10,true);
      const compressedSize=dv.getUint32(at+20,true);
      const uncompressedSize=dv.getUint32(at+24,true);
      const fileNameLength=dv.getUint16(at+28,true);
      const extraLength=dv.getUint16(at+30,true);
      const commentLength=dv.getUint16(at+32,true);
      const localHeaderOffset=dv.getUint32(at+42,true);
      if(at+46+fileNameLength>len) throw new Error('Архив ZIP повреждён.');
      const name = new TextDecoder('utf-8').decode(new Uint8Array(buf,at+46,fileNameLength));
      if(/(?:^|\/)watch-history\.(json|html)$/i.test(name) && !/\/__MACOSX\//i.test(name)) {
        historyEntries.push({name,method,compressedSize,uncompressedSize,localHeaderOffset});
      }
      at += 46+fileNameLength+extraLength+commentLength;
    }
    if(!historyEntries.length) throw new Error('В ZIP не найден watch-history.json или watch-history.html. Выберите экспорт с историей YouTube.');
    const output=[];
    for(const entry of historyEntries) {
      if(entry.uncompressedSize>250*1024*1024) throw new Error('Файл истории слишком большой для безопасного импорта (>250 МБ).');
      const p=entry.localHeaderOffset;
      if(p+30>len || dv.getUint32(p,true)!==0x04034b50) throw new Error('Архив ZIP содержит повреждённый файл.');
      const start=p+30+dv.getUint16(p+26,true)+dv.getUint16(p+28,true);
      if(start+entry.compressedSize>len) throw new Error('Размеры файла в ZIP некорректны.');
      const slice=buf.slice(start,start+entry.compressedSize);
      let data;
      if(entry.method===0) data=slice;
      else if(entry.method===8) {
        if(!('DecompressionStream' in window)) throw new Error('Этот браузер не поддерживает распаковку ZIP. Распакуйте архив и выберите JSON.');
        try { data=await new Response(new Blob([slice]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer(); }
        catch(error) { throw new Error('Ошибка распаковки ZIP. Извлеките watch-history.json вручную.'); }
      } else throw new Error('Этот метод ZIP-сжатия не поддерживается. Распакуйте архив вручную.');
      output.push({name:entry.name,text:new TextDecoder('utf-8').decode(data)});
    }
    return output;
  }

  function openDb() {
    return new Promise((resolve,reject)=>{
      if(!('indexedDB' in window)) return reject(new Error('IndexedDB недоступен'));
      const request=indexedDB.open(APP_DB,1);
      request.onupgradeneeded=()=>{
        const db=request.result;
        if(!db.objectStoreNames.contains('records')) db.createObjectStore('records',{keyPath:'id'});
        if(!db.objectStoreNames.contains('hidden')) db.createObjectStore('hidden',{keyPath:'id'});
      };
      request.onsuccess=()=>resolve(request.result);
      request.onerror=()=>reject(request.error || new Error('Ошибка IndexedDB'));
      request.onblocked=()=>reject(new Error('База данных заблокирована другой вкладкой'));
    });
  }
  function txReadAll(db,storeName) {
    return new Promise((resolve,reject)=>{
      const request=db.transaction(storeName,'readonly').objectStore(storeName).getAll();
      request.onsuccess=()=>resolve(request.result||[]);
      request.onerror=()=>reject(request.error||new Error('Ошибка чтения'));
    });
  }
  function txWrite(db,storeName,mode,items) {
    return new Promise((resolve,reject)=>{
      const tx=db.transaction(storeName,'readwrite');
      const store=tx.objectStore(storeName);
      try {
        for(const item of items) {
          if(mode==='put') store.put(item);
          else if(mode==='delete') store.delete(item);
        }
      } catch(e) {reject(e);return;}
      tx.oncomplete=()=>resolve();
      tx.onerror=()=>reject(tx.error||new Error('Ошибка сохранения'));
      tx.onabort=()=>reject(tx.error||new Error('Сохранение прервано'));
    });
  }
  async function initHistory() {
    try {
      ST.db=await openDb();
      const [existing,hidden]=await Promise.all([txReadAll(ST.db,'records'),txReadAll(ST.db,'hidden')]);
      ST.history=existing;
      ST.hidden=new Set(hidden.map(x=>x.id));
    } catch(error) {
      ST.db=null;
      toast('Локальное хранилище недоступно: история останется только до закрытия страницы.','warning');
    }
    if(DEMO && !ST.history.length) ST.history=DEMO_HISTORY.slice();
    ST.historyLoaded=true;
    updateStats();renderHistory();
  }
  async function importHistoryFiles(files) {
    const list=Array.from(files||[]);
    if(!list.length) return;
    let parsed=[],issues=[];
    toast('Импортируем историю локально…');
    await delayPaint();
    for(const file of list) {
      try {
        let data;
        if(/\.zip$/i.test(file.name)) data=await unzipWatchHistory(file);
        else if(/\.(?:json|html|htm)$/i.test(file.name)) data=[{name:file.name,text:await file.text()}];
        else throw new Error('Выбери ZIP, JSON или HTML из Google Takeout.');
        for(const entry of data) {
          const records=/\.json$/i.test(entry.name) ? parseHistoryJson(entry.text) : parseHistoryHtml(entry.text);
          parsed.push(...records);
        }
      } catch(error) {issues.push(file.name+': '+error.message);}
    }
    if(!parsed.length){toast(issues[0]||'В выбранных файлах не найдены просмотры.','error');return;}
    // Demo fixtures are replaced by the first real import; don't mix them.
    if (DEMO && ST.history.length && ST.history.every(x => x.id.startsWith('demo-watch-'))) ST.history=[];
    // Deduplicate exact events; don't resurrect locally removed records.
    const existing=new Map(ST.history.map(x=>[x.id,x]));
    const toSave=[];
    for(const record of parsed) {
      if(ST.hidden.has(record.id) || existing.has(record.id)) continue;
      existing.set(record.id,record);
      toSave.push(record);
    }
    ST.history=Array.from(existing.values());
    if(ST.db && toSave.length) {
      try {await txWrite(ST.db,'records','put',toSave);} catch(error){toast('Не удалось сохранить импорт в браузере: '+error.message,'warning');}
    }
    ST.hPage=0;
    refreshHistoryChannelOptions();updateStats();renderHistory();
    toast('Добавлено '+numberFmt(toSave.length)+' просмотров. Совпадения пропущены.');
    if(issues.length) toast('Некоторые файлы пропущены: '+issues[0],'warning');
    activateView('history');
  }

  function subscribedChannel(record) {
    if (!ST.subsLoaded) return false;
    if (record.channelId && ST.subscriptions.some(x => x.channelId===record.channelId)) return true;
    return ST.subscriptions.some(x => normalizeText(x.title)===normalizeText(record.channel));
  }
  function refreshHistoryChannelOptions() {
    const existing = ST.hChannel;
    const byName = new Map();
    for(const item of ST.history) {
      const key=normalizeText(item.channel);
      if(!key) continue;
      if(!byName.has(key)) byName.set(key,{name:item.channel,count:0,subscribed:false});
      const entry=byName.get(key);
      entry.count++;
      if(subscribedChannel(item)) entry.subscribed=true;
    }
    const all=[...byName.entries()].sort((a,b)=>b[1].count-a[1].count || a[1].name.localeCompare(b[1].name,'ru'));
    const subscribed=all.filter(x=>x[1].subscribed);
    const others=all.filter(x=>!x[1].subscribed);
    function optionsFor(entries) {
      return entries.map(([key,value])=>'<option value="'+escapeHtml(key)+'">'+escapeHtml(value.name)+' ('+numberFmt(value.count)+')</option>').join('');
    }
    $('historyChannel').innerHTML='<option value="">Все каналы</option>'+
      (subscribed.length?'<optgroup label="Из моих подписок">'+optionsFor(subscribed)+'</optgroup>':'')+
      (others.length?'<optgroup label="Другие каналы">'+optionsFor(others)+'</optgroup>':'');
    $('historyChannel').value=existing;
    if($('historyChannel').value!==existing){ST.hChannel='';$('historyChannel').value='';}
  }
  function filteredHistory() {
    const query=normalizeText(ST.hSearch);
    const from=ST.hFrom, to=ST.hTo;
    return ST.history.filter(x => {
      if (ST.hType!=='all' && x.type!==ST.hType) return false;
      if (ST.hChannel && normalizeText(x.channel)!==ST.hChannel) return false;
      if (query && !normalizeText(x.title+' '+x.channel).includes(query)) return false;
      if (from && (!x.time || x.time.slice(0,10)<from)) return false;
      if (to && (!x.time || x.time.slice(0,10)>to)) return false;
      if (ST.hOnlySubscribed && !subscribedChannel(x)) return false;
      return true;
    }).sort((a,b)=>(b.time||'').localeCompare(a.time||''));
  }
  function renderTopChannels() {
    const counts=new Map();
    for(const rec of ST.history){
      const key=normalizeText(rec.channel);
      if(!key) continue;
      if(!counts.has(key)) counts.set(key,{name:rec.channel,count:0});
      counts.get(key).count++;
    }
    const top=[...counts.entries()].sort((a,b)=>b[1].count-a[1].count).slice(0,6);
    const biggest=top.length?top[0][1].count:1;
    $('topChannels').innerHTML=top.length?top.map(([key,item])=>
      '<button type="button" class="top-channel-item" data-channel="'+escapeHtml(key)+'"><div class="top-channel-head"><strong>'+escapeHtml(item.name)+'</strong><span>'+numberFmt(item.count)+'</span></div><div class="bar-track"><div class="bar-fill" style="width:'+Math.round(item.count*100/biggest)+'%"></div></div></button>'
    ).join(''):'<p class="muted">Появятся после импорта истории.</p>';
  }
  function renderHistory() {
    if(!ST.historyLoaded) return;
    refreshHistoryChannelOptions();
    qsa('.type-tab').forEach(btn=>btn.classList.toggle('selected',btn.dataset.type===ST.hType));
    const items=filteredHistory();
    const pages=Math.max(1,Math.ceil(items.length/PAGE_SIZE));
    ST.hPage=Math.min(ST.hPage,pages-1);
    const sliced=items.slice(ST.hPage*PAGE_SIZE,ST.hPage*PAGE_SIZE+PAGE_SIZE);
    $('historyResultCaption').textContent=numberFmt(items.length)+' записей'+(items.length===ST.history.length?'':' из '+numberFmt(ST.history.length));
    $('selectAllHistory').checked=items.length>0 && items.every(x=>ST.selectedHistory.has(x.id));
    $('selectAllHistory').indeterminate=items.some(x=>ST.selectedHistory.has(x.id)) && !$('selectAllHistory').checked;
    $('historyList').innerHTML=sliced.length ? sliced.map(x=>{
      const safeUrl=urlSafe(x.url);
      const title=escapeHtml(x.title);
      const id=encodeURIComponent(x.id);
      const opts=['youtube','music','unknown'].map(type=>'<option value="'+type+'"'+(x.type===type?' selected':'')+'>'+TYPE_LABELS[type]+'</option>').join('');
      return '<div class="list-row history-row">'+
        '<label class="custom-check"><input type="checkbox" data-select-history="'+id+'" '+(ST.selectedHistory.has(x.id)?'checked':'')+' aria-label="Выбрать '+title+'"><span></span></label>'+
        '<div class="channel-avatar">'+(x.type==='music'?'♫':x.type==='youtube'?'▶':'?')+'</div>'+
        '<div class="row-text">'+(safeUrl?'<a class="row-title" href="'+escapeHtml(safeUrl)+'" target="_blank" rel="noopener noreferrer">'+title+' ↗</a>':'<span class="row-title">'+title+'</span>')+
        '<div class="row-caption">'+escapeHtml(x.channel||'Канал неизвестен')+'</div></div>'+
        '<div class="row-end"><select class="control-select row-type-select" data-classify-history="'+id+'" aria-label="Категория просмотра">'+opts+'</select><span class="row-date">'+escapeHtml(formatDate(x.time,true))+'</span>'+
        '<button class="row-icon-btn" type="button" data-action="delete-one-history" data-id="'+id+'" aria-label="Убрать запись из локальной истории" title="Убрать локально"><svg viewBox="0 0 24 24"><path d="M4 7h16M10 4h4M6 7l1 13h10l1-13M10 11v6M14 11v6"/></svg></button></div></div>';
    }).join(''):'<div class="empty-state"><span>◷</span><h3>'+ (ST.history.length?'По фильтрам ничего не найдено':'История пока пуста')+'</h3><p>'+ (ST.history.length?'Попробуй изменить фильтры или поиск.':'Импортируй данные из Google Takeout, чтобы увидеть свои просмотры.')+'</p>'+(ST.history.length?'':'<button class="btn primary" type="button" data-action="import-history">Импортировать историю</button>')+'</div>';
    $('historyPaginator').classList.toggle('hidden',pages<=1);
    $('historyPageLabel').textContent=(ST.hPage+1)+' / '+pages;
    qs('[data-action="history-prev"]').disabled=ST.hPage===0;
    qs('[data-action="history-next"]').disabled=ST.hPage>=pages-1;
    $('historyBulkBar').classList.toggle('hidden',ST.selectedHistory.size===0);
    $('historySelectedCount').textContent=numberFmt(ST.selectedHistory.size);
    renderTopChannels();updateStats();
  }
  async function changeHistoryTypes(ids, type, clearSelection=true) {
    if(!TYPE_LABELS[type]) return toast('Выберите тип просмотра.','warning');
    const toSave=[];
    const selected=new Set(ids);
    ST.history.forEach(x=>{if(selected.has(x.id)){x.type=type;toSave.push(x);}});
    if(ST.db && toSave.length) {
      try{await txWrite(ST.db,'records','put',toSave);}
      catch(error){toast('Не удалось сохранить изменения: '+error.message,'error');}
    }
    if(clearSelection) ST.selectedHistory.clear();
    renderHistory();
    toast('Обновлено категорий: '+toSave.length);
  }
  async function deleteLocalHistory(ids) {
    const selected=new Set(ids);
    const existing=ST.history.filter(x=>selected.has(x.id));
    if(!existing.length)return;
    const unique=existing.map(x=>x.id);
    if(ST.db){
      try{
        await txWrite(ST.db,'hidden','put',unique.map(id=>({id,deletedAt:new Date().toISOString()})));
        await txWrite(ST.db,'records','delete',unique);
      }catch(error){toast('Не удалось удалить сохранённую историю: '+error.message,'error');return;}
    }
    for(const id of unique) {ST.hidden.add(id); ST.selectedHistory.delete(id);}
    ST.history=ST.history.filter(x=>!selected.has(x.id));
    renderHistory();
    toast('Убрано локально: '+unique.length+'. История Google не изменена.');
  }
  function confirmDeleteLocalHistory(ids) {
    const actual=ids.filter(id=>ST.history.some(x=>x.id===id));
    if(!actual.length)return;
    openModal('Убрать историю локально','<div class="modal-note">'+actual.length+' запись(ей) будет скрыто в этом браузере, в том числе после повторного импорта того же архива.</div><p><b>Это не удаляет просмотры с серверов Google.</b> Чтобы удалить настоящую историю, воспользуйся My Activity.</p>','Убрать записи',async()=>{closeModal();await deleteLocalHistory(actual);},true);
  }
  async function clearLocalHistory() {
    openModal('Очистить локальную историю','<div class="modal-note">Будут удалены все локальные записи и список скрытых просмотров. Данные в Google не изменятся.</div><p>Введи <b>ОЧИСТИТЬ</b>, чтобы подтвердить:</p><label class="form-field"><input id="clearPhrase" class="modal-input" placeholder="ОЧИСТИТЬ" autocomplete="off" spellcheck="false"></label>','Очистить',async()=>{
      if($('clearPhrase').value.trim()!=='ОЧИСТИТЬ')return toast('Введите ОЧИСТИТЬ точно.','warning');
      if(ST.db){
        try{
          await Promise.all(['records','hidden'].map(storeName=>new Promise((resolve,reject)=>{
            const tx=ST.db.transaction(storeName,'readwrite');tx.objectStore(storeName).clear();
            tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);
          })));
        }catch(error){toast('Не удалось очистить IndexedDB: '+error.message,'error');return;}
      }
      ST.history=[];ST.hidden.clear();ST.selectedHistory.clear();ST.hPage=0;
      closeModal();renderHistory();toast('Локальная история очищена.');
    },true);
  }

  // CSV exports are browser-generated and protect spreadsheet apps from formula injection.
  function protectCsv(value) {
    let text=String(value==null?'':value);
    if(/^[\s\u0000-\u001f]*[=+@-]/.test(text)) text="'"+text;
    return '"'+text.replace(/"/g,'""')+'"';
  }
  function exportCsv(filename, header, rows) {
    if(!rows.length) return toast('Нет записей для экспорта.','warning');
    const csv='\uFEFF'+[header,...rows].map(row=>row.map(protectCsv).join(',')).join('\r\n');
    const blob=new Blob([csv],{type:'text/csv;charset=utf-8;'});
    const url=URL.createObjectURL(blob);
    const link=document.createElement('a');link.href=url;link.download=filename;
    document.body.appendChild(link);link.click();link.remove();
    setTimeout(()=>URL.revokeObjectURL(url),1500);
    toast('Экспортировано '+numberFmt(rows.length)+' строк в '+filename);
  }
  function exportSubscriptions(selectedOnly=false) {
    const items=selectedOnly ? ST.subscriptions.filter(x=>ST.selectedSubs.has(x.id)) : filteredSubs();
    exportCsv('youtube-subscriptions-'+new Date().toISOString().slice(0,10)+'.csv',
      ['Название канала','ID канала','ID подписки','Дата подписки','Ссылка на канал','Описание'],
      items.map(x=>[x.title,x.channelId,x.id,x.subscribedAt,x.channelId?'https://www.youtube.com/channel/'+x.channelId:'',x.description]));
  }
  function exportHistory(selectedOnly=false) {
    const items=selectedOnly ? ST.history.filter(x=>ST.selectedHistory.has(x.id)) : filteredHistory();
    exportCsv('youtube-watch-history-'+new Date().toISOString().slice(0,10)+'.csv',
      ['Дата просмотра (ISO)','Тип','Название видео','Канал','Ссылка на видео','Ссылка на канал','ID канала'],
      items.map(x=>[x.time,TYPE_LABELS[x.type]||TYPE_LABELS.unknown,x.title,x.channel,x.url,x.channelUrl,x.channelId]));
  }

  document.addEventListener('click', async event => {
    const viewButton=event.target.closest('[data-view]');
    if(viewButton){event.preventDefault();activateView(viewButton.dataset.view);return;}
    const typeButton=event.target.closest('[data-type]');
    if(typeButton){ST.hType=typeButton.dataset.type;ST.hPage=0;renderHistory();return;}
    const channelButton=event.target.closest('[data-channel]');
    if(channelButton){ST.hChannel=channelButton.dataset.channel;$('historyChannel').value=ST.hChannel;ST.hPage=0;renderHistory();return;}
    if(event.target===$('modalBackdrop')){closeModal();return;}
    const btn=event.target.closest('[data-action]');
    if(!btn)return;
    const action=btn.dataset.action;
    try {
      switch(action) {
        case 'dismiss-demo': ST.demoNoticeDismissed=true;$('demoNotice').classList.add('hidden');break;
        case 'google-login':await signInAction(btn);break;
        case 'google-logout':signOutAction();break;
        case 'open-add':openAddModal();break;
        case 'close-modal':closeModal();break;
        case 'modal-submit':if(ST.modalSubmit)await ST.modalSubmit();break;
        case 'reload-subs':await loadSubscriptions();break;
        case 'sub-prev':ST.subPage--;renderSubscriptions();break;
        case 'sub-next':ST.subPage++;renderSubscriptions();break;
        case 'delete-one-sub':confirmUnsubscribe([btn.dataset.id]);break;
        case 'delete-subs':confirmUnsubscribe([...ST.selectedSubs]);break;
        case 'clear-subs-selection':ST.selectedSubs.clear();renderSubscriptions();break;
        case 'export-subs':exportSubscriptions();break;
        case 'export-selected-subs':exportSubscriptions(true);break;
        case 'import-history':$('takeoutFile').click();break;
        case 'export-history':exportHistory();break;
        case 'export-selected-history':exportHistory(true);break;
        case 'history-prev':ST.hPage--;renderHistory();break;
        case 'history-next':ST.hPage++;renderHistory();break;
        case 'delete-one-history':confirmDeleteLocalHistory([decodeURIComponent(btn.dataset.id)]);break;
        case 'delete-history':confirmDeleteLocalHistory([...ST.selectedHistory]);break;
        case 'clear-history-selection':ST.selectedHistory.clear();renderHistory();break;
        case 'clear-history-filters':
          ST.hType='all';ST.hSearch='';ST.hChannel='';ST.hFrom='';ST.hTo='';ST.hOnlySubscribed=false;ST.hPage=0;
          $('historySearch').value='';$('historyChannel').value='';$('histDateFrom').value='';$('histDateTo').value='';$('histOnlySubscribed').checked=false;
          renderHistory();break;
        case 'apply-history-type':await changeHistoryTypes([...ST.selectedHistory],$('historyBulkType').value);$('historyBulkType').value='';break;
        case 'clear-local':await clearLocalHistory();break;
      }
    } catch(error){toast(error.message || String(error),'error');}
  });
  document.addEventListener('input',event=>{
    const target=event.target;
    if(target.id==='subSearch') {ST.subSearch=target.value;ST.subPage=0;renderSubscriptions();}
    if(target.id==='historySearch') {ST.hSearch=target.value;ST.hPage=0;renderHistory();}
  });
  document.addEventListener('change',event=>{
    const target=event.target;
    if(target.id==='subSort'){ST.subSort=target.value;ST.subPage=0;renderSubscriptions();}
    if(target.id==='selectAllSubs'){
      for(const x of filteredSubs()) {if(target.checked)ST.selectedSubs.add(x.id);else ST.selectedSubs.delete(x.id);}
      renderSubscriptions();
    }
    if(target.matches('[data-select-sub]')){
      if(target.checked)ST.selectedSubs.add(target.dataset.selectSub);else ST.selectedSubs.delete(target.dataset.selectSub);
      renderSubscriptions();
    }
    if(target.id==='historyChannel'){ST.hChannel=target.value;ST.hPage=0;renderHistory();}
    if(target.id==='histDateFrom'){ST.hFrom=target.value;ST.hPage=0;renderHistory();}
    if(target.id==='histDateTo'){ST.hTo=target.value;ST.hPage=0;renderHistory();}
    if(target.id==='histOnlySubscribed'){
      ST.hOnlySubscribed=target.checked;ST.hPage=0;
      if(target.checked && !ST.subsLoaded && !ST.subsLoading) loadSubscriptions();
      renderHistory();
    }
    if(target.id==='selectAllHistory'){
      for(const x of filteredHistory()){if(target.checked)ST.selectedHistory.add(x.id);else ST.selectedHistory.delete(x.id);}
      renderHistory();
    }
    if(target.matches('[data-select-history]')){
      const id=decodeURIComponent(target.dataset.selectHistory);
      if(target.checked)ST.selectedHistory.add(id);else ST.selectedHistory.delete(id);
      renderHistory();
    }
    if(target.matches('[data-classify-history]')){
      changeHistoryTypes([decodeURIComponent(target.dataset.classifyHistory)],target.value,false);
    }
  });
  $('takeoutFile').addEventListener('change',async event=>{
    const files=event.target.files;
    if(files && files.length) await importHistoryFiles(files);
    event.target.value='';
  });
  document.addEventListener('keydown',event=>{
    if(event.key==='Escape'&&!$('modalBackdrop').classList.contains('hidden')) closeModal();
    if(event.key==='Enter' && event.target.id==='newChannel'){
      event.preventDefault();qs('[data-action="modal-submit"]')?.click();
    }
  });

  // Supports drag-and-drop Takeout archives onto the upload panel.
  const dropCard=$('historyUploadCard');
  dropCard.addEventListener('dragover',event=>{event.preventDefault();dropCard.style.borderColor='#d7a0fd';});
  dropCard.addEventListener('dragleave',()=>{dropCard.style.borderColor='';});
  dropCard.addEventListener('drop',async event=>{
    event.preventDefault();dropCard.style.borderColor='';
    await importHistoryFiles(event.dataTransfer.files);
  });

  if(DEMO){
    ST.subscriptions=DEMO_SUBS.slice();ST.subsLoaded=true;
    $('modeChip').classList.add('is-demo');$('modeText').textContent='Демо-режим';
    $('demoNotice').classList.remove('hidden');
  }
  updateStats();renderSubscriptions();
  updateAuthUI();
  initHistory();
})();