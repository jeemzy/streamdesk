/* StreamDesk — public Google OAuth client. Do not add a client secret. */
(() => {
  'use strict';
  const CLIENT_ID = '311838120618-r9r8e6v5f8nil8ght4cklqtmi7ja3opo.apps.googleusercontent.com';
  const SCOPE = 'https://www.googleapis.com/auth/youtube';
  const API = 'https://www.googleapis.com/youtube/v3';
  let tokenClient = null, token = '', expires = 0, waiting = null;

  function isAuthorized() {
    if (token && Date.now() < expires - 30000) return true;
    token = ''; expires = 0; return false;
  }
  function signOut() { token = ''; expires = 0; }
  function signIn() {
    if (waiting) return Promise.reject(new Error('Авторизация уже выполняется.'));
    if (!window.google?.accounts?.oauth2) return Promise.reject(
      new Error('Не удалось загрузить Google Identity Services. Отключи блокировку скриптов и обнови страницу.')
    );
    if (!tokenClient) tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: CLIENT_ID, scope: SCOPE,
      callback(response) {
        const p = waiting; waiting = null;
        if (!p) return;
        if (!response?.access_token || response.error) {
          p.reject(new Error(response?.error_description || response?.error || 'Google не предоставил доступ.'));
          return;
        }
        if (!google.accounts.oauth2.hasGrantedAllScopes(response, SCOPE)) {
          p.reject(new Error('Для управления подписками требуется разрешение YouTube.'));
          return;
        }
        token = response.access_token;
        expires = Date.now() + (Number(response.expires_in) || 3600) * 1000;
        p.resolve();
      },
      error_callback(error) {
        const p = waiting; waiting = null;
        if (p) p.reject(new Error(error?.type === 'popup_failed_to_open'
          ? 'Разреши всплывающие окна Google для этого сайта.'
          : 'Вход был прерван или окно авторизации закрыто.'));
      }
    });
    return new Promise((resolve,reject) => {
      waiting = {resolve,reject};
      try { tokenClient.requestAccessToken({prompt:'select_account'}); }
      catch (e) { waiting=null; reject(e); }
    });
  }
  async function request(method,path,params={},body) {
    if (!isAuthorized()) throw new Error('Google-сессия истекла. Войди снова.');
    const url = new URL(API + path);
    for (const [k,v] of Object.entries(params)) if (v!=='' && v!=null) url.searchParams.set(k,String(v));
    let res;
    try {
      res = await fetch(url, {
        method, cache:'no-store',
        headers: {Authorization:'Bearer '+token,...(body?{'Content-Type':'application/json'}:{})},
        ...(body?{body:JSON.stringify(body)}:{})
      });
    } catch (_) { throw new Error('Ошибка сети при обращении к YouTube API.'); }
    if (res.status===204) return {};
    const t = await res.text();
    let data={}; try { data=t?JSON.parse(t):{}; } catch (_) {}
    if (res.ok) return data;
    if (res.status===401) {signOut();throw new Error('Авторизация Google истекла. Войди снова.');}
    const code = data?.error?.errors?.[0]?.reason || data?.error?.status || '';
    const msg = data?.error?.message || '';
    if (/quotaExceeded|dailyLimitExceeded/i.test(code+msg)) throw new Error('Превышена дневная квота YouTube API.');
    if (/accessNotConfigured|not.*enabled|disabled/i.test(code+msg)) throw new Error('Включи YouTube Data API v3 в Google Cloud.');
    if (/subscriptionDuplicate/i.test(code+msg)) throw new Error('Ты уже подписан на этот канал.');
    if (/subscriptionNotFound/i.test(code+msg)) throw new Error('Подписка уже удалена или не найдена.');
    if (/insufficientPermissions|insufficientScopes/i.test(code+msg)) throw new Error('Не хватает разрешений Google.');
    throw new Error('YouTube API: '+(msg || 'HTTP '+res.status));
  }
  function normalizeChannelInput(raw) {
    if (typeof raw !== 'string' || !raw.trim() || raw.length>500) throw new Error('Нужна ссылка на канал или @handle.');
    let s = raw.trim();
    if (/^https?:\/\//i.test(s)) {
      const u = new URL(s);
      if (!['youtube.com','www.youtube.com','m.youtube.com'].includes(u.hostname.toLowerCase())) throw new Error('Ссылка должна вести на youtube.com.');
      const p=u.pathname.split('/').filter(Boolean);
      if (p.length===2 && p[0]==='channel') s=p[1];
      else if(p.length===1 && p[0].startsWith('@')) s=p[0];
      else throw new Error('Используй youtube.com/@имя или youtube.com/channel/UC…');
    }
    try{s=decodeURIComponent(s)}catch(_){}
    if (/^UC[A-Za-z0-9_-]{22}$/.test(s)) return {id:s};
    if (/^@[A-Za-z0-9._-]{3,100}$/.test(s)) return {forHandle:s};
    throw new Error('Неверный ID канала или @handle.');
  }
  async function getSubscriptionsPage(pageToken) {
    if(pageToken && (typeof pageToken!=='string'||pageToken.length>512)) throw new Error('Некорректная страница.');
    const d=await request('GET','/subscriptions',{
      part:'snippet,contentDetails',mine:true,maxResults:50,pageToken:pageToken||''
    });
    return {
      items:(d.items||[]).map(x=>({
        id:String(x.id||''),
        channelId:String(x.snippet?.resourceId?.channelId||''),
        title:String(x.snippet?.title||'Канал без названия'),
        description:String(x.snippet?.description||''),
        subscribedAt:String(x.snippet?.publishedAt||''),
        avatar:String((x.snippet?.thumbnails?.medium || x.snippet?.thumbnails?.default || {}).url||''),
        newVideos:Number(x.contentDetails?.newItemCount||0)
      })),
      nextPageToken:d.nextPageToken||null,
      approximateTotal:Number(d.pageInfo?.totalResults||0)
    };
  }
  async function getCurrentChannel() {
    const d=await request('GET','/channels',{part:'snippet',mine:true,maxResults:1});
    const x=d.items?.[0];
    return x?{id:x.id,title:x.snippet?.title||''}:null;
  }
  async function subscribeToChannel(raw) {
    const d=await request('GET','/channels',{part:'snippet',...normalizeChannelInput(raw),maxResults:1});
    const x=d.items?.[0]; if(!x?.id)throw new Error('YouTube-канал не найден.');
    const sub=await request('POST','/subscriptions',{part:'snippet'},{
      snippet:{resourceId:{kind:'youtube#channel',channelId:x.id}}
    });
    return {id:String(sub.id||''),channelId:String(x.id),title:String(x.snippet?.title||'')};
  }
  async function unsubscribeMany(ids,confirmation) {
    if (confirmation!=='ОТПИСАТЬСЯ')throw new Error('Подтверди действие словом ОТПИСАТЬСЯ.');
    if (!Array.isArray(ids)||!ids.length||ids.length>25)throw new Error('За раз — до 25 подписок.');
    if(ids.some(x=>typeof x!=='string'||!/^[A-Za-z0-9_-]{10,200}$/.test(x)))throw new Error('Некорректный ID подписки.');
    const result=[];
    for (const id of new Set(ids)) {
      try{await request('DELETE','/subscriptions',{id});result.push({id,ok:true});}
      catch(e){result.push({id,ok:false,error:e.message});if(!isAuthorized())break;}
    }
    return result;
  }
  window.StreamDeskAPI=Object.freeze({
    isAuthorized, signIn, signOut, getSubscriptionsPage, getCurrentChannel, subscribeToChannel, unsubscribeMany
  });
})();
