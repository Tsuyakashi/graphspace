# Десктоп-оболочка

Окно Electron с Graphspace. Ресурс с `http(s)`-ссылкой (git — репозиторий на GitHub) открывается справа
настоящим сайтом в webview, а не карточкой: запреты на iframe webview не касаются.
Сессия сайтов одна на все ресурсы и сохраняется (`persist:web`), так что в GitHub входишь один раз.

```bash
cd desktop && npm install
npm start                                   # http://127.0.0.1:4680
npm start -- https://graphspace.workd.online # прод, вход Cloudflare Access прямо в окне
```

- Webview рисуется поверх страницы. Пока открыто меню или диалог Graphspace, оболочка его прячет.
- «Свойства» в шапке узла переключают на форму ресурса.
- Управлять webview может только главный фрейм с origin Graphspace. Craft в iframe моста не видит.
- В браузере всё как раньше: у ресурса форма со ссылкой «Открыть».
