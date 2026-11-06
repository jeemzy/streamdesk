/* StreamDesk | public OAuth Client ID (not a secret). No server, no refresh token. */
(function () {
  'use strict';

  const CLIENT_ID = "311838120618-r9r8e6v5f8nil8ght4cklqtmi7ja3opo.apps.googleusercontent.com";
  const SCOPE = 'https://www.googleapis.com/auth/youtube';
  const API_BASE = 'https://www.googleapis.com/youtube/v3';
  const AUTH_LEEWAY_MS = 30 * 1000;
  let tokenClient = null;
  let pendingSignIn = null;
  let accessToken = '';
  let expiresAt = 0;

  function isAuthorized() {
    if (accessToken && Date.now() < expiresAt - AUTH_LEEWAY_MS) return true;
    if (accessToken) { accessToken = ''; expiresAt = 0; }
    return false;
  }

  function ensureLibrary() {
    if (!window.google || !window.google.accounts || !window.google.accounts.oauth2) {
      throw new Error('Библиотека Google Identity Services не загрузилась. Отключите блокировщик скриптов и обновите страницу.');
    }
  }

  function onTokenResponse(response) {
    const promise = pendingSignIn;
    pendingSignIn = null;
    if (!promise) return;
    if (!response || response.error || !response.access_token) {
      promise.reject(new Error('Google не выдал токен: ' + (response?.error_description || response?.error || 'доступ не предоставлен')));
      return;
    }
    if (!window.google.accounts.oauth2.hasGrantedAllScopes(response, SCOPE)) {
      promise.reject(new Error('Для управления подписками необходимо разрешение YouTube.'));
      return;
    }
    accessToken = response.access_token;
    expiresAt = Date.now() + Math.max(60, Number(response.expires_in) || 3600) * 1000;
    promise.resolve();
  }

  function onPopupError(error) {
    if (!pendingSignIn) return;
    const promise = pendingSignIn;
    pendingSignIn = null;
    promise.reject(new Error(error?.type === 'popup_failed_to_open'
      ? 'Браузер заблокировал вход через Google. Разрешите всплывающие окна для сайта.'
      : 'Окно авторизации закрыто или вход прерван.'));
  }

  function signIn() {
    // Always invoke from a click handler; Google requires a user gesture to open the popup.
    if (pendingSignIn) return Promise.reject(new Error('Авторизация уже запущена.'));
    try { ensureLibrary(); } catch (error) { return Promise.reject(error); }
    if (!tokenClient) {
      tokenClient = window.google.accounts.oauth2.initTokenClient({
        client_id: CLIENT_ID,
        scope: SCOPE,
        callback: onTokenResponse,
        error_callback: onPopupError,
      });
    }
    return new Promise((resolve, reject) => {
      pendingSignIn = {resolve, reject};
      try {
        tokenClient.requestAccessToken({prompt:'select_account'});
      } catch (error) {
        pendingSignIn = null;
        reject(error);
      }
    });
  }

  function signOut() {
    // Only ends this browser session. Does not revoke the grant on the Google account.
    accessToken = '';
    expiresAt = 0;
  }

  async function request(method, pathname, query, payload) {
    if (!isAuthorized()) throw new Error('Сессия Google истекла. Нажми «Войти через Google» ещё раз.');
    const url = new URL(API_BASE + pathname);
    for (const [key, value] of Object.entries(query || {})) {
      if (value != null && value !== '') url.searchParams.set(key, String(value));
    }
    let response;
    try {
      response = await fetch(url.href, {
        method,
        headers: {'Authorization': 'Bearer ' + accessToken, ...(payload ? {'Content-Type':'application/json'} : {})},
        ...(payload ? {body:JSON.stringify(payload)} : {}),
        cache: 'no-store'
      });
    } catch (error) {
      throw new Error('Не удалось связаться с YouTube API. Проверь интернет и доступность Google.');
    }
    if (response.status === 204) return {};
    const content = await response.text();
    let parsed;
    try { parsed = content ? JSON.parse(content) : {}; } catch (_) { parsed = {}; }
    if (response.ok) return parsed;
    if (response.status === 401) signOut();
    const code = parsed?.error?.errors?.[0]?.reason || parsed?.error?.status || '';
    const message = parsed?.error?.message || '';
    const known = {
      subscriptionDuplicate: 'На этот канал уже есть подписка.',
      quotaExceeded: 'Исчерпана дневная квота YouTube API. Попробуй завтра.',
      dailyLimitExceeded: 'Исчерпана дневная квота YouTube API. Попробуй завтра.',
      insufficientPermissions: 'Google не предоставил необходимое разрешение YouTube.',
      insufficientScopes: 'Google не предоставил необходимое разрешение YouTube.',
      subscriptionNotFound: 'Подписка не найдена (возможно, уже удалена).',
      subscriptionForbidden: 'YouTube запретил изменение этой подписки.',
      accessNotConfigured: 'Включи YouTube Data API v3 в Google Cloud Console.',
    };
    if (response.status === 401) throw new Error('Токен Google недействителен или истёк. Войди заново.');
    if (response.status === 403 && /not.*enabled|accessNotConfigured|disabled/i.test(message + code)) {
      throw new Error('YouTube Data API v3 выключен в проекте Google Cloud. Включи его в библиотеке API.');
    }
    throw new Error(known[code] || ('YouTube API: ' + (message || 'HTTP ' + response.status) + (code ? ' [' + code + ']' : '')));
  }

  function normalizeChannelInput(value) {
    if (typeof value !== 'string' || !value.trim() || value.length > 500) {
      throw new Error('Укажи ссылку youtube.com/@имя, @handle или ID канала UC…');
    }
    let input = value.trim();
    if (/^https?:\/\//i.test(input)) {
      const url = new URL(input);
      if (!['youtube.com','www.youtube.com','m.youtube.com'].includes(url.hostname.toLowerCase())) {
        throw new Error('Ссылка должна вести на youtube.com.');
      }
      const parts = url.pathname.split('/').filter(Boolean);
      if (parts.length === 2 && parts[0].toLowerCase() === 'channel') input = parts[1];
      else if (parts.length === 1 && parts[0].startsWith('@')) input = parts[0];
      else throw new Error('Используй ссылку вида youtube.com/@имя или youtube.com/channel/UC…');
    }
    try { input = decodeURIComponent(input); } catch (_) { /* ignored */ }
    if (/^UC[A-Za-z0-9_-]{22}$/.test(input)) return {id: input};
    if (/^@[A-Za-z0-9._-]{3,100}$/.test(input)) return {forHandle: input};
    throw new Error('Некорректный @handle или ID YouTube-канала.');
  }

  async function getSubscriptionsPage(pageToken) {
    if (pageToken != null && (typeof pageToken !== 'string' || pageToken.length > 512)) {
      throw new Error('Некорректный токен страницы.');
    }
    const response = await request('GET','/subscriptions',{
      part:'snippet,contentDetails',mine:'true',maxResults:50,pageToken:pageToken || ''
    });
    return {
      items:(response.items || []).map(item => ({
        id:String(item.id || ''),
        channelId:String(item.snippet?.resourceId?.channelId || ''),
        title:String(item.snippet?.title || 'Канал без названия'),
        description:String(item.snippet?.description || ''),
        subscribedAt:String(item.snippet?.publishedAt || ''),
        avatar:String((item.snippet?.thumbnails?.medium || item.snippet?.thumbnails?.default || {}).url || ''),
        newVideos:Number(item.contentDetails?.newItemCount || 0)
      })),
      nextPageToken:response.nextPageToken || null,
      approximateTotal:Number(response.pageInfo?.totalResults || 0)
    };
  }

  async function getCurrentChannel() {
    const response=await request('GET','/channels',{part:'snippet',mine:'true',maxResults:1});
    const channel=response.items?.[0];
    return channel ? {id:channel.id,title:channel.snippet?.title || ''} : null;
  }

  async function subscribeToChannel(value) {
    const query=normalizeChannelInput(value);
    const response=await request('GET','/channels',{part:'snippet',...query,maxResults:1});
    const channel=response.items?.[0];
    if(!channel?.id) throw new Error('Канал не найден. Проверь ссылку или @handle.');
    const result=await request('POST','/subscriptions',{part:'snippet'},{
      snippet:{resourceId:{kind:'youtube#channel',channelId:channel.id}}
    });
    return {id:String(result.id || ''),channelId:String(channel.id),title:String(channel.snippet?.title || '')};
  }

  async function unsubscribeMany(ids, confirmation) {
    if (confirmation !== 'ОТПИСАТЬСЯ') throw new Error('Для отписки введи ОТПИСАТЬСЯ.');
    if(!Array.isArray(ids) || ids.length < 1 || ids.length > 25) throw new Error('Можно удалить до 25 подписок за запрос.');
    if(ids.some(x=>typeof x!=='string' || !/^[A-Za-z0-9_-]{10,200}$/.test(x))) throw new Error('Некорректный ID подписки.');
    const results=[];
    for(const id of new Set(ids)) {
      try {
        await request('DELETE','/subscriptions',{id});
        results.push({id,ok:true});
      } catch(error) {
        results.push({id,ok:false,error:error.message});
        if (!isAuthorized()) break;
      }
    }
    return results;
  }

  // User playlists (excluding system-managed Watch Later).
  async function getPlaylistsPage(pageToken) {
    const d = await request('GET', '/playlists', {
      part:'snippet,contentDetails,status', mine:true, maxResults:50, pageToken:pageToken || ''
    });
    return {items:(d.items || []).map(x => ({
      id:String(x.id || ''),
      title:String(x.snippet?.title || 'Без названия'),
      itemCount:Number(x.contentDetails?.itemCount || 0),
      privacy:String(x.status?.privacyStatus || ''),
      thumb:String((x.snippet?.thumbnails?.medium || x.snippet?.thumbnails?.default || {}).url || '')
    })),nextPageToken:d.nextPageToken || null};
  }
  // Entries in a single user-owned playlist; videoOwnerChannel* refer to the actual uploader.
  async function getPlaylistItemsPage(playlistId, pageToken) {
    if(typeof playlistId !== 'string' || !/^[A-Za-z0-9_-]{2,200}$/.test(playlistId)) throw new Error('Некорректный ID плейлиста.');
    const d = await request('GET', '/playlistItems', {
      part:'snippet,contentDetails', playlistId, maxResults:50, pageToken:pageToken || ''
    });
    return {items:(d.items || []).map(x => ({
      videoId:String(x.contentDetails?.videoId || x.snippet?.resourceId?.videoId || ''),
      playlistItemId:String(x.id || ''),
      title:String(x.snippet?.title || ''),
      channel:String(x.snippet?.videoOwnerChannelTitle || ''),
      channelId:String(x.snippet?.videoOwnerChannelId || ''),
      addedAt:String(x.snippet?.publishedAt || ''),
      thumb:String((x.snippet?.thumbnails?.medium || x.snippet?.thumbnails?.default || {}).url || '')
    })),nextPageToken:d.nextPageToken || null};
  }
  // The liked-video endpoint supports up to the newest 1000 liked videos.
  async function getLikedVideosPage(pageToken) {
    const d = await request('GET', '/videos', {
      part:'snippet', myRating:'like', maxResults:50, pageToken:pageToken || ''
    });
    return {items:(d.items || []).map(x => ({
      videoId:String(x.id || ''),title:String(x.snippet?.title || ''),
      channel:String(x.snippet?.channelTitle || ''),channelId:String(x.snippet?.channelId || ''),
      addedAt:'',thumb:String((x.snippet?.thumbnails?.medium || x.snippet?.thumbnails?.default || {}).url || '')
    })),nextPageToken:d.nextPageToken || null};
  }
  // Resolve uploader metadata (not available in every Takeout / playlist entry).
  async function getVideoDetails(ids) {
    if(!Array.isArray(ids) || !ids.length || ids.length > 50 || ids.some(x=>typeof x!=='string' || !/^[A-Za-z0-9_-]{11}$/.test(x))) {
      throw new Error('Некорректные ID видео.');
    }
    const d = await request('GET', '/videos', {part:'snippet', id:ids.join(',')});
    return (d.items || []).map(x => ({
      videoId:String(x.id || ''),title:String(x.snippet?.title || ''),
      channel:String(x.snippet?.channelTitle || ''),channelId:String(x.snippet?.channelId || ''),
      thumb:String((x.snippet?.thumbnails?.medium || x.snippet?.thumbnails?.default || {}).url || '')
    }));
  }
  window.StreamDeskAPI = Object.freeze({
    signIn,signOut,isAuthorized,getSubscriptionsPage,getCurrentChannel,subscribeToChannel,unsubscribeMany,
    getPlaylistsPage,getPlaylistItemsPage,getLikedVideosPage,getVideoDetails
  });
})();