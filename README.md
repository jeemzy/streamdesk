# StreamDesk — GitHub Pages Edition

Твоя статическая панель для подписок YouTube + Watch History Manager. Исходные файлы адаптированы из StreamDesk для Apps Script. `Code.gs` здесь НЕ используется.

## Быстрый запуск с телефона

1. [Создай public-репозиторий `streamdesk`](https://github.com/new?name=streamdesk&description=StreamDesk%20YouTube%20manager) в своём GitHub (`jeemzy`). Лучше включить README при создании репозитория, чтобы появилась ветка `main`.
2. Загрузи все файлы из **этой** папки прямо **в корень** репозитория (`index.html`, `client.js`, `oauth.js`, `styles.css`, `.nojekyll`). Если ChatGPT имеет доступ к репозиторию, можно просто попросить загрузить файлы после создания.
3. Перейди в `Settings → Pages → Build and deployment → Source: Deploy from a branch`, выбери `main` и `/(root)`, затем `Save`.
4. Открой `https://jeemzy.github.io/streamdesk/`. Публикация может занять несколько минут.
5. Нажми «Войти через Google». При первом входе выбери Google-аккаунт и разреши доступ к YouTube. Если приложение находится в тестовом режиме, добавь нужный Google-аккаунт в `Google Auth Platform → Audience → Test users`.

## Google Cloud

- Тип OAuth-клиента: **Web application**.
- OAuth Client ID уже включён в `oauth.js` (это **публичный идентификатор**, а не секрет).
- Authorized JavaScript origins: `https://jeemzy.github.io` — без `/streamdesk` и без слэша в конце.
- Authorized redirect URIs: **не нужны**, используется popup-модель Google Identity Services.
- Включи **YouTube Data API v3** через `APIs & Services → Library`. Проверь, что OAuth consent screen опубликован в нужном статусе и ты добавлен в тестовые пользователи, если Testing.
- **Client Secret не нужен. Не добавляй его ни в GitHub Secrets, ни в исходный код, ни в Actions.** GitHub Pages публично раздаёт статические файлы, а секреты Actions не делают клиентский код приватным.

## Как пользоваться

- Подписки: после входа можно искать, сортировать, добавлять (по @handle или ID `UC…`) и удалять с фразой подтверждения `ОТПИСАТЬСЯ`, а также выгружать CSV.
- История: экспортируй через [Google Takeout](https://takeout.google.com/) раздел «YouTube и YouTube Music → history», загрузи `watch-history.json`, `watch-history.html` или ZIP. Файлы разбираются локально, можно фильтровать по каналу, дате, сервису, подпискам и экспортировать CSV.
- Удаление из истории влияет **только на локальную копию** IndexedDB. Настоящее удаление просмотров находится в [Google My Activity](https://myactivity.google.com/product/youtube).

## Приватность и безопасность

- Доступ к YouTube предоставляется на странице Google, а не на StreamDesk.
- Access token хранится **только в памяти открытой вкладки** и исчезает после перезагрузки, закрытия или кнопки «Отключиться». Для следующего сеанса снова нажми «Войти», но Google обычно сохраняет ранее выданное согласие.
- Данные истории и метки удалённых записей хранятся локально в браузере через IndexedDB; на другой телефон они не синхронизируются. Не загружай историю на чужом устройстве.
- StreamDesk не отправляет содержимое Takeout на сервер. К Google API отправляются только запросы по подпискам. Внешние ресурсы: библиотека Google Identity Services и миниатюры каналов YouTube.
- Изменение/удаление подписки выполняется от имени **вошедшего пользователя**. Проверь выбранный аккаунт перед массовой отпиской. `subscriptions.insert/delete` расходуют 50 единиц квоты каждый.
- GitHub Pages — **публичный** статический сайт. Кто угодно может открыть интерфейс, но не получит доступ к твоему YouTube без авторизации Google и разрешений. Находящийся в репозитории Client ID публичен.
- Приложение со scope `youtube` может требовать проверку Google, если выйдет за пределы тестовых пользователей. В режиме `Testing` выдача доступа ограничена тестовыми пользователями; Google может периодически запрашивать новое согласие.

## Устранение проблем

| Симптом | Причина / действия |
| --- | --- |
| `origin_mismatch` | Проверь Authorized JavaScript origins = `https://jeemzy.github.io`. Изменения Google Cloud применяются не сразу. |
| `access_denied` / «app not verified» | Добавь почту в Test users и проверь OAuth consent screen. |
| `YouTube API has not been used ...` | Включи YouTube Data API v3 в том же проекте Google Cloud, где создан Client ID. |
| Снова требуется вход | Это ожидаемо после обновления страницы — токены не хранятся между сессиями. |
| Нет подписок | Проверь Google-аккаунт и используемый YouTube-канал. |
| `403 quotaExceeded` | Лимит YouTube API исчерпан, повтори позже. |
| Google popup не открывается | Открывай в обычном браузере, не во встроенном браузере Telegram/Instagram; разреши всплывающие окна. |

## Официальные документы

- [GIS token model](https://developers.google.com/identity/oauth2/web/guides/use-token-model)
- [YouTube subscriptions API](https://developers.google.com/youtube/data/reference/rest/v3/subscriptions)
- [GitHub Pages from branch](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site)