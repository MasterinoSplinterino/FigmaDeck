# Ewento Slides — draft answers for Figma's data security disclosure

> Черновик ответов для необязательной формы «Data security» в окне публикации. Форма на английском, поэтому и
> ответы на английском. Точный список вопросов формы из этого окружения увидеть не удалось (help.figma.com
> заблокирован) — ниже ответы сгруппированы по темам, которые форма, по результатам поиска, покрывает: сеть,
> какие данные читаются и хранятся, передача третьим лицам, аккаунты, безопасность разработки. При заполнении
> берите подходящий абзац под каждый вопрос. Форму проверяют отдельно от плагина (по результатам поиска — до
> двух недель); после одобрения на странице плагина появляется метка «Data security info available».
>
> Все факты ниже проверены по коду репозитория (ссылки на файлы — в скобках) на момент подготовки. Если код
> изменится (сеть, аналитика, лицензии, оплата), ответы нужно обновить и подать форму заново.

## Summary (for a free-text "overview" field)

Ewento Slides exports frames to PowerPoint (.pptx) and PDF entirely inside Figma. It has no network access
(`networkAccess.allowedDomains: ["none"]` in the manifest), no backend, no analytics, no third-party services and no
user accounts. The design data it reads is converted into a file in the plugin's own iframe and handed to the user as
a normal browser download. Nothing is transmitted anywhere.

## Network access

- **Does the plugin make network requests?** No. The manifest declares `"networkAccess": { "allowedDomains":
  ["none"] }`, so Figma blocks any request from the plugin. The code contains no `fetch`, `XMLHttpRequest`,
  `WebSocket` or `sendBeacon` calls.
- **External resources in the UI?** None. Scripts, styles, icons and the image-compression Web Worker are inlined
  into one HTML file at build time (`scripts/build.mjs` → `dist/ui.html`); no CDN, web fonts or remote images.
- **Domains contacted:** none.
- **Encryption in transit:** not applicable — no data is transmitted.

## Data the plugin reads

- The frames the user adds to the deck and their layers (text, fonts, geometry, fills, effects, images) via the
  Figma Plugin API, only while the user exports or previews slides.
- The Figma file name, used as the default deck title and file name.
- The plugin does **not** read the user's identity (`figma.currentUser` is not used), comments, version history,
  other files or team/organization data.

## Data the plugin stores

| What | Where | Why | Lifetime |
|---|---|---|---|
| Export settings (mode, raster scale, compression, slide size, font naming and font mapping, author / company for file metadata, UI language) | `figma.clientStorage` — local to the user's Figma client, not shared | Remember the user's preferences | Until the user resets them or clears Figma's local data |
| Deck slide list (node IDs of the frames added as slides) and deck title | Plugin data on the document root (`figma.root.setPluginData`, keys `figmadeck.slides`, `figmadeck.title`), private to this plugin | Keep the deck in the file between sessions | Stored in the Figma file; removed if the user clears the deck or deletes the file |
| Temporary layers: clones of a frame or layer used to render one picture (e.g. the frame with its texts hidden for "Exact look", a layer clipped like its parent) and a hidden text layer used to measure line height | The current page, named as temporary and marked with plugin data key `figmadeck.temp` | Needed by some export steps; the user's own layers are never modified | Removed right after use, and on cancel, error or plugin close; any leftovers are removed the next time the plugin starts |

(Code: `src/shared/settings.ts`, `src/extract/selection.ts` `STORAGE_KEYS`, `src/main.ts`, `src/extract/raster.ts`
`TempNodes`.)

No personal data is stored. The optional "author" and "company" fields are typed by the user and written only into
the exported file's metadata.

## Data the plugin produces

- The .pptx / .pdf file is assembled inside the plugin iframe (PptxGenJS, JSZip, pdf-lib — bundled) and saved with a
  standard browser download to the user's computer. The plugin never sees where the file is saved.
- File metadata: title (deck title or Figma file name), author and company from settings, application name
  "Ewento Slides".
- "Copy report" copies a plain-text export report to the clipboard, only when the user clicks it.
- Image compression runs in a Web Worker created from inlined code in the same iframe; images are not uploaded.

## Third parties

- **Shares data with third parties?** No.
- **Uses third-party services, SDKs, analytics, crash reporting, ads or AI/LLM APIs?** No.
- **Bundled open-source libraries** (run locally, no network): PptxGenJS, JSZip, pdf-lib, pako, Preact.

## Accounts and authentication

- No sign-in, no account, no API keys, no license server. The plugin is free.

## Data retention and deletion

- The developer holds no user data, so there is nothing to retain or delete on our side.
- Users can remove what the plugin keeps: "Clear all" empties the deck list; "Reset to defaults" in Settings
  restores default settings; deleting the Figma file removes its plugin data.

## Security practices (for "development / vulnerability" questions)

- Minimal permissions: `documentAccess: "dynamic-page"`, `editorType: ["figma"]`, no network, no extra
  permissions.
- Dependencies are pinned in `package-lock.json` and installed with `npm ci`; the published build is produced from
  the repository with `npm run build`.
- Automated tests (`npm test`) cover extraction, PPTX/PDF building and the UI.
- Security contact: **support@ewento.app** (please confirm this mailbox is monitored).

## To confirm before submitting

- [ ] The developer / company name and website to show in the form (Ewento; website URL — to be provided).
- [ ] Whether you want a privacy policy URL. The form may ask for one; a short page stating the above
      ("no data collected, no network") is enough — none exists yet.
- [ ] That no later change added network access, telemetry or payments. If payments are added (`figma.payments`),
      update "Accounts" and "Third parties" (checkout is handled by Figma).
