/**
 * UI strings (English + Russian). Every visible string of the plugin UI lives here.
 *
 * - `t(key, vars)` interpolates `{name}` placeholders; `{product}` is always available
 *   (CONFIG.meta.productName).
 * - Plural keys (`*.count`-style, marked with `|`) hold one form per plural category:
 *   en `one|other`, ru `one|few|many` — use `tp(key, n, vars)`; `{n}` is always available.
 * - The language follows Settings → General → Language (`resolveLang`): `auto` picks Russian only
 *   when the system language is Russian (`ru*`), English otherwise. App switches it live (`setLang`).
 * - Toasts from the main thread carry a `code`: the UI shows `toast.<code>` (`toastText`), main's
 *   English `message` is the fallback for unknown codes.
 *
 * Environment-neutral (no DOM access at module load) so tests can import it in Node.
 */
import { CONFIG } from '../config';
import type { RasterReason } from '../ir/types';
import type { UiLanguage } from '../shared/settings';

export type Lang = 'en' | 'ru';

const en = {
  // Generic
  'common.cancel': 'Cancel',
  'common.close': 'Close',
  'common.done': 'Done',
  'common.loading': 'Loading…',
  'common.retry': 'Try again',

  // Startup / unexpected errors
  'boot.timeoutTitle': 'Can’t connect to Figma',
  'boot.timeoutText': 'The plugin didn’t get a response from Figma. Try again, or close and reopen the plugin.',
  'crash.title': 'Something went wrong',
  'crash.text': 'The plugin ran into an unexpected error. Your frames are not affected. Try again, or close and reopen the plugin.',

  // Empty state
  'empty.title': 'No slides yet',
  'empty.text': 'Select frames on the canvas and click Add slides to export them as an editable PowerPoint or PDF.',
  'empty.hintNoFrames': 'Select one or more frames or a section on the canvas.',
  'empty.hintAllInDeck': 'The selected frames are already in the deck.',

  // Add slides
  'add.button': 'Add slides',
  'add.buttonSidebar': 'Add slides',
  'add.buttonN': 'Add {n} slide|Add {n} slides',
  'add.buttonSidebarN': 'Add {n} slide|Add {n} slides',

  // Sidebar
  'sidebar.title': 'Slides',
  'sidebar.sort': 'Sort by canvas position',
  'sidebar.remove': 'Remove from deck',
  'sidebar.missing': 'This frame no longer exists and will be skipped on export.',
  'sidebar.missingName': 'Missing frame',
  'sidebar.thumbFailed': 'Thumbnail unavailable',
  'sidebar.slideTooltip': '{name} · {w}×{h} · {page}',
  'sidebar.dragHint': 'Drag to reorder · Double-click to show on canvas',

  // Top bar
  'top.titlePlaceholder': 'Untitled deck',
  'top.titleEdit': 'Rename deck',
  'top.settings': 'Settings',
  'top.clearAll': 'Clear all',
  'top.export': 'Export',
  'top.exportTitle': 'Export as {format}',
  'top.exportMenu': 'More export formats',
  'export.pptx': 'PowerPoint — editable',
  'export.pptxHint': 'Editable text, shapes and images',
  'export.pptxHintExact': 'Exact look: flattened background, editable text',
  'export.pptxImage': 'PowerPoint — images (JPEG)',
  'export.pptxImageHint': 'Looks exactly like Figma; not editable, small file',
  'export.pdf': 'PDF — vector',
  'export.pdfHint': 'Figma’s built-in PDF export; files can be large',
  'export.pdfImage': 'PDF — images (JPEG)',
  'export.pdfImageHint': 'One JPEG per page; small file',
  'export.irJson': 'IR JSON (debug)',
  'export.irJsonHint': 'Debug data for bug reports',
  'export.noSlides': 'Add slides to the deck before exporting.',

  // Clear all
  'clear.title': 'Clear the deck?',
  'clear.text': 'Remove {n} slide from the deck?|Remove all {n} slides from the deck?',
  'clear.note': 'Your frames on the canvas won’t change.',
  'clear.confirm': 'Clear all',

  // Preview
  'preview.counter': '{i}/{n}',
  'preview.focusHint': 'Double-click to show the frame on the canvas',
  'preview.missing': 'This frame no longer exists',
  'preview.missingHint': 'It was deleted or is no longer a frame. Remove it from the deck, or undo the change in Figma.',
  'preview.loading': 'Rendering preview…',
  'preview.failed': 'Preview unavailable',
  'preview.failedHint': 'Figma couldn’t render this frame.',

  // Settings
  'settings.title': 'Settings',
  'settings.reset': 'Reset to defaults',
  'settings.section.general': 'General',
  'settings.language': 'Language',
  'settings.languageHint': 'Auto follows your system language.',
  'settings.language.auto': 'Auto',
  'settings.language.en': 'English',
  'settings.language.ru': 'Русский',
  'settings.section.mode': 'PowerPoint — editable',
  'settings.mode.editable': 'Editable',
  'settings.mode.editableHint': 'Native text, shapes, images and groups; other layers are rasterized one by one.',
  'settings.mode.exact': 'Exact look',
  'settings.mode.exactHint': 'Everything except text is flattened into one background image; text stays editable.',
  'settings.modeNote': 'Image exports (PowerPoint or PDF — images) always flatten each slide into a single JPEG.',
  'settings.section.images': 'Images',
  'settings.scale': 'Raster scale',
  'settings.scaleHint': 'Resolution of rasterized layers, backgrounds and image exports.',
  'settings.compression': 'Image compression',
  'settings.compressionHint': 'Runs on your computer; nothing is uploaded.',
  'settings.compression.off': 'Off',
  'settings.compression.offHint': 'Images stay exactly as Figma exports them.',
  'settings.compression.balanced': 'Balanced (recommended)',
  'settings.compression.balancedHint': 'Visually lossless: optimized palettes for PNGs, JPEG for opaque photos. Typically 70% smaller.',
  'settings.compression.strong': 'Strong',
  'settings.compression.strongHint': 'Smaller files with a slight quality loss: fewer colors, JPEG quality up to {q}.',
  'settings.jpegQuality': 'JPEG quality',
  'settings.jpegQualityHint': 'For opaque photos, backgrounds and image exports.',
  'settings.imageFills': 'Image fills',
  'settings.imageFills.original': 'Original + crop',
  'settings.imageFills.rasterize': 'Rasterize',
  'settings.imageFillsHint': 'Original keeps the full image, so you can re-crop it in PowerPoint.',
  'settings.svg': 'SVG for vectors',
  'settings.svgHint': 'Icons stay sharp in PowerPoint 365; a PNG fallback is always included.',
  'settings.section.text': 'Text',
  'settings.textCase': 'Uppercase text',
  'settings.textCase.cap': 'All Caps effect',
  'settings.textCase.transform': 'Convert to capitals',
  'settings.textCaseHint': 'All Caps keeps the text as typed and displays it in capitals; Convert rewrites it in capitals.',
  'settings.widthSlack': 'Extra text width',
  'settings.widthSlackHint': 'Widens auto-width text boxes so PowerPoint doesn’t wrap the last word.',
  'settings.clippedText': 'Partially clipped text',
  'settings.clippedText.rasterize': 'Rasterize',
  'settings.clippedText.keep': 'Keep editable',
  'settings.section.layers': 'Shapes and layers',
  'settings.groups': 'Keep groups',
  'settings.groupsHint': 'Figma groups and frames become PowerPoint groups.',
  'settings.gradients': 'Native gradients',
  'settings.gradientsHint': 'Linear gradients stay editable instead of being rasterized.',
  'settings.section.slide': 'Slide size',
  'settings.slideSize.frame': 'Frame size',
  'settings.slideSize.custom': 'Custom',
  'settings.slideSize.frameHint': 'Slides match the frame size, scaled down to fit PowerPoint’s 56-inch limit.',
  'settings.slideSize.customHint': 'Each frame is scaled to fit and centered on the slide.',
  'settings.slideSize.pdfNote': 'PowerPoint only; PDF pages keep the frame size.',
  'settings.slideSize.presets': 'Presets',
  'settings.slideSize.preset.widescreen': '16:9',
  'settings.slideSize.preset.standard': '4:3',
  'settings.slideSize.preset.led': 'LED wide 3.25:1',
  'settings.slideSize.preset.agency': 'Agency template',
  'settings.slideSize.slide': 'Slide',
  'settings.slideSize.frames': 'Frame',
  'settings.slideSize.scale': 'Scale',
  'settings.slideSize.scaleValue': '{p} · 1 px = {pt} pt',
  'settings.slideSize.otherSizes': '+{n} other size|+{n} other sizes',
  'settings.slideSize.letterboxX': 'Frames are {frame} and the slide is {slide}: frames are scaled to fit, with {bar} {unit} bars on the left and right.',
  'settings.slideSize.letterboxY': 'Frames are {frame} and the slide is {slide}: frames are scaled to fit, with {bar} {unit} bars at the top and bottom.',
  'settings.slideSize.mixed':
    '{n} of {total} frames has a different aspect ratio and will be letterboxed|{n} of {total} frames have a different aspect ratio and will be letterboxed',
  'settings.width': 'Width',
  'settings.height': 'Height',
  'settings.unit': 'Units',
  'settings.unitIn': 'in',
  'settings.unitCm': 'cm',
  'settings.section.meta': 'Document properties',
  'settings.author': 'Author',
  'settings.company': 'Company',
  'settings.metaHint': 'The document title is the deck name.',
  'settings.section.fonts': 'Fonts',
  'settings.fonts.count': '{n} font|{n} fonts',
  'settings.fonts.naming': 'Font names in PowerPoint',
  'settings.fonts.naming.ribbi': 'RIBBI (Windows standard)',
  'settings.fonts.naming.ribbiHint': 'Regular, Bold, Italic and Bold Italic use the family name plus B / I; other weights are separate families.',
  'settings.fonts.naming.full': 'Full style names',
  'settings.fonts.naming.fullHint': 'One family per weight (“Family Bold”, no B attribute), as in many agency templates.',
  'settings.fonts.naming.example': 'Example: {figma} → {face}',
  'settings.fonts.mapping': 'Font mapping',
  'settings.fonts.figma': 'Figma font',
  'settings.fonts.face': 'PowerPoint font',
  'settings.fonts.bold': 'Bold attribute',
  'settings.fonts.italic': 'Italic attribute',
  'settings.fonts.resetRow': 'Reset to automatic',
  'settings.fonts.missing': 'missing in Figma',
  'settings.fonts.overridden': 'custom',
  'settings.fonts.uses': '{n} use|{n} uses',
  'settings.fonts.empty': 'No text in the deck yet.',
  'settings.fonts.failed': 'Couldn’t load the fonts. Close and reopen Settings to try again.',
  'settings.fonts.ribbiTitle': 'What is RIBBI?',
  'settings.fonts.ribbiText':
    'Windows groups up to four styles under one family name: Regular, Bold, Italic and Bold Italic (RIBBI). They are written as the family name plus the Bold / Italic attributes. Every other style (Light, Medium, Semibold, Black…) is a separate family named “Family Style”. Override a row if the fonts are installed differently on the recipient’s computer.',

  // Settings → About
  'settings.section.about': 'About',
  'about.version': 'Version {version}',
  'about.privacy': 'Runs entirely on your computer. No data leaves Figma — the plugin has no network access.',
  'about.support': 'Help and feedback',
  'about.emailTitle': 'Write to {email}',
  'about.licenses': 'Open-source licenses',
  'about.licensesIntro': '{product} includes the following open-source software.',

  // Progress
  'progress.title.pptx': 'Exporting to PowerPoint',
  'progress.title.pdf': 'Exporting to PDF',
  'progress.title.json': 'Exporting IR JSON',
  'progress.starting': 'Preparing…',
  'progress.extract': 'Processing slide {i} of {n}',
  'progress.pdfPages': 'Exporting page {i} of {n}',
  'progress.images': 'Compressing images {i} of {n}',
  'progress.imageSize': '{w} × {h} px',
  'progress.mainThread': 'no background worker; the plugin may pause',
  'progress.build': 'Building slide {i} of {n}',
  'progress.package': 'Writing the PowerPoint file',
  'progress.merge': 'Merging PDF pages',
  'progress.render': 'Creating PDF pages',
  'progress.serialize': 'Writing JSON',
  'progress.layers': '{n} layer|{n} layers',
  'progress.jobs': 'rasterizing {done} of {total}',
  'progress.cancel': 'Cancel',
  'progress.cancelling': 'Cancelling…',

  // Report
  'report.title': 'Export complete',
  'report.slides': 'Slides',
  'report.size': 'File size',
  'report.duration': 'Time',
  'report.texts': 'Text boxes',
  'report.shapes': 'Shapes',
  'report.images': 'Images',
  'report.groups': 'Groups',
  'report.imagesLine': 'Images: {n} · {before} → {after} ({pct})',
  'report.method.palette-lossy': '{n} palette',
  'report.method.palette-exact': '{n} exact palette',
  'report.method.jpeg': '{n} JPEG',
  'report.method.lossless': '{n} lossless',
  'report.method.original': '{n} unchanged',
  'report.imagesDownscaled': '{n} downscaled',
  'report.imagesFailed': '{n} failed',
  'report.imagesCompressionOff': 'compression off',
  'report.imagesMainThread': 'Images were compressed without a background worker (not available here), so the plugin may have paused.',
  'report.pdfDedupe': 'Repeated images and fonts stored once: {n} objects, {size} saved',
  'report.downloadAgain': 'Download again',
  'report.downloadHint': 'Didn’t get the file? Click Download again.',
  'report.copy': 'Copy report',
  'report.copied': 'Report copied to the clipboard',
  'report.copyFailed': 'Couldn’t copy the report',
  'report.fonts': 'Fonts',
  'report.fontsWarning': 'Fonts aren’t embedded. Install them on every computer that opens the file, or PowerPoint will substitute them.',
  'report.fontFigma': 'Figma',
  'report.fontFace': 'In PowerPoint',
  'report.fontOverridden': 'custom mapping',
  'report.noFonts': 'No text in the exported slides.',
  'report.raster': 'Rasterized layers',
  'report.rasterNone': 'Nothing was rasterized.',
  'report.moreItems': 'and {n} more',
  'report.skipped': 'Skipped layers',
  'report.skippedCount': '{n} layer outside the slide or its clipping frame|{n} layers outside the slide or their clipping frames',
  'report.warnings': 'Warnings',
  'report.notes': 'Notes',
  'report.slideLabel': 'Slide {i}: {name}',
  'report.textHeader': '{product} export report',

  // Report entry codes (localized short descriptions; unknown codes fall back to the English message)
  'code.missing-frame': 'The frame no longer exists and was skipped',
  'code.missing-font': 'Uses a font that’s missing in Figma; the text may not match',
  'code.export-failed': 'Couldn’t be exported and was skipped',
  'code.slide-scaled': 'Slide was scaled to fit the presentation size',
  'code.group-flattened': 'Group couldn’t be kept and was flattened',
  'code.text-truncated': 'Truncated text is exported in full',
  'code.text-leading-trim': 'Vertical trim isn’t supported by PowerPoint',
  'code.exact-text-in-background': 'Text is part of the background image',
  'code.outside-clip': 'Outside the slide or its clipping frame',
  'code.image-unreadable': 'Image fill couldn’t be read; the layer was rasterized instead',
  'code.root-effect-dropped': 'Slide frame effect couldn’t be reproduced exactly (e.g. a layer blur on the whole slide)',
  'code.root-effect-ignored': 'Slide frame effect ignored (drop shadow or background blur outside the slide)',
  'code.pdf-page-scaled': 'Page scaled down to the PDF limit of 200 inches per side',
  'code.pdf-image-skipped': 'Elements that aren’t images were left out of the image PDF',

  // Raster reasons
  'reason.exact-mode': 'Exact look mode',
  'reason.image-mode': 'Slide as image',
  'reason.vector': 'Vector',
  'reason.boolean-operation': 'Boolean operation',
  'reason.gradient': 'Gradient',
  'reason.gradient-text': 'Gradient or image text',
  'reason.image-fill-mode': 'Image fill mode',
  'reason.image-filters': 'Image filters',
  'reason.image-format': 'Image format',
  'reason.multiple-fills': 'Multiple fills',
  'reason.mixed-radii': 'Mixed corner radii',
  'reason.blend-mode': 'Blend mode',
  'reason.mask': 'Mask',
  'reason.blur': 'Blur',
  'reason.effects': 'Effects',
  'reason.stroke': 'Stroke',
  'reason.transform': 'Skew or flip',
  'reason.clip': 'Clipped by a frame',
  'reason.group-opacity': 'Group opacity',
  'reason.unsupported-node': 'Unsupported layer type',
  'reason.unsupported-paint': 'Unsupported fill type',
  'reason.setting': 'Export setting',
  'reason.text-feature': 'Unsupported text feature',

  // Toasts sent by the main thread (`toast` messages with a `code`)
  'toast.no-frames-selected': 'Select frames or a section on the canvas to add them as slides.',
  'toast.already-in-deck': 'The selected frames are already in the deck.',
  'toast.slides-added': 'Added {n} slide to the deck|Added {n} slides to the deck',
  'toast.frame-missing': 'This frame no longer exists.',
  'toast.export-busy': 'An export is already running.',
  'toast.fonts-failed': 'Couldn’t read the fonts used in the deck.',
  'toast.error': 'Something went wrong: {message}',

  // Errors
  'error.export': 'Export failed: {message}',
  'error.exportUnknown': 'Export failed. Try again, or close and reopen the plugin.',
  'error.cancelled': 'Export cancelled',
  'error.busy': 'An export is already running.',
  'error.noPages': 'No pages were exported.',
  'error.noSlides': 'No slides could be exported.',

  // Units
  'unit.bytes': '{n} B',
  'unit.kb': '{n} KB',
  'unit.mb': '{n} MB',
  'unit.seconds': '{n} s',
  'unit.minutes': '{m} min {s} s',

  // Window
  'window.resize': 'Drag to resize',
} as const;

export type MessageKey = keyof typeof en;
export type Dictionary = Record<MessageKey, string>;

const ru: Dictionary = {
  'common.cancel': 'Отмена',
  'common.close': 'Закрыть',
  'common.done': 'Готово',
  'common.loading': 'Загрузка…',
  'common.retry': 'Повторить',

  'boot.timeoutTitle': 'Нет связи с Figma',
  'boot.timeoutText': 'Плагин не получил ответа от Figma. Повторите попытку или закройте и снова откройте плагин.',
  'crash.title': 'Что-то пошло не так',
  'crash.text': 'В плагине произошла непредвиденная ошибка. Ваши фреймы не затронуты. Повторите попытку или закройте и снова откройте плагин.',

  'empty.title': 'Слайдов пока нет',
  'empty.text': 'Выделите фреймы на холсте и нажмите «Добавить слайды», чтобы экспортировать их в редактируемый PowerPoint или PDF.',
  'empty.hintNoFrames': 'Выделите на холсте один или несколько фреймов или секцию.',
  'empty.hintAllInDeck': 'Выделенные фреймы уже есть в презентации.',

  'add.button': 'Добавить слайды',
  'add.buttonSidebar': 'Добавить слайды',
  'add.buttonN': 'Добавить {n} слайд|Добавить {n} слайда|Добавить {n} слайдов',
  'add.buttonSidebarN': 'Ещё {n} слайд|Ещё {n} слайда|Ещё {n} слайдов',

  'sidebar.title': 'Слайды',
  'sidebar.sort': 'Упорядочить по положению на холсте',
  'sidebar.remove': 'Убрать из презентации',
  'sidebar.missing': 'Этого фрейма больше нет, при экспорте он будет пропущен.',
  'sidebar.missingName': 'Фрейм не найден',
  'sidebar.thumbFailed': 'Миниатюра недоступна',
  'sidebar.slideTooltip': '{name} · {w}×{h} · {page}',
  'sidebar.dragHint': 'Перетащите, чтобы изменить порядок · Двойной клик — показать на холсте',

  'top.titlePlaceholder': 'Без названия',
  'top.titleEdit': 'Переименовать презентацию',
  'top.settings': 'Настройки',
  'top.clearAll': 'Очистить',
  'top.export': 'Экспорт',
  'top.exportTitle': 'Экспорт: {format}',
  'top.exportMenu': 'Другие форматы экспорта',
  'export.pptx': 'PowerPoint — редактируемый',
  'export.pptxHint': 'Редактируемые текст, фигуры и картинки',
  'export.pptxHintExact': 'Точный вид: фон картинкой, текст редактируется',
  'export.pptxImage': 'PowerPoint — картинки (JPEG)',
  'export.pptxImageHint': 'Выглядит точно как в Figma; не редактируется, файл маленький',
  'export.pdf': 'PDF — векторный',
  'export.pdfHint': 'Встроенный PDF-экспорт Figma; файлы бывают большими',
  'export.pdfImage': 'PDF — картинки (JPEG)',
  'export.pdfImageHint': 'По JPEG на страницу; файл маленький',
  'export.irJson': 'IR JSON (отладка)',
  'export.irJsonHint': 'Отладочные данные для баг-репортов',
  'export.noSlides': 'Сначала добавьте слайды в презентацию.',

  'clear.title': 'Очистить презентацию?',
  'clear.text': 'Убрать из презентации {n} слайд?|Убрать из презентации все {n} слайда?|Убрать из презентации все {n} слайдов?',
  'clear.note': 'Фреймы на холсте не изменятся.',
  'clear.confirm': 'Очистить',

  'preview.counter': '{i}/{n}',
  'preview.focusHint': 'Двойной клик — показать фрейм на холсте',
  'preview.missing': 'Этого фрейма больше нет',
  'preview.missingHint': 'Он удалён или больше не является фреймом. Уберите его из презентации или отмените изменение в Figma.',
  'preview.loading': 'Готовим превью…',
  'preview.failed': 'Превью недоступно',
  'preview.failedHint': 'Figma не смогла отрисовать этот фрейм.',

  'settings.title': 'Настройки',
  'settings.reset': 'Сбросить настройки',
  'settings.section.general': 'Общие',
  'settings.language': 'Язык',
  'settings.languageHint': '«Авто» — как в системе.',
  'settings.language.auto': 'Авто',
  'settings.language.en': 'English',
  'settings.language.ru': 'Русский',
  'settings.section.mode': 'PowerPoint — редактируемый',
  'settings.mode.editable': 'Редактируемый',
  'settings.mode.editableHint': 'Нативные текст, фигуры, картинки и группы; остальные слои растеризуются по одному.',
  'settings.mode.exact': 'Точный вид',
  'settings.mode.exactHint': 'Всё, кроме текста, сводится в одну фоновую картинку; текст остаётся редактируемым.',
  'settings.modeNote': 'Экспорт картинками (PowerPoint или PDF — картинки) всегда сводит каждый слайд в один JPEG.',
  'settings.section.images': 'Изображения',
  'settings.scale': 'Масштаб растра',
  'settings.scaleHint': 'Разрешение растеризованных слоёв, фонов и экспорта картинками.',
  'settings.compression': 'Сжатие изображений',
  'settings.compressionHint': 'Выполняется на вашем компьютере, ничего не загружается.',
  'settings.compression.off': 'Выключено',
  'settings.compression.offHint': 'Картинки остаются такими, как их экспортирует Figma.',
  'settings.compression.balanced': 'Сбалансированное (рекомендуется)',
  'settings.compression.balancedHint': 'Без видимых потерь: оптимальная палитра для PNG, JPEG для непрозрачных фото. Обычно на 70 % меньше.',
  'settings.compression.strong': 'Сильное',
  'settings.compression.strongHint': 'Файлы меньше, небольшие потери: меньше цветов, качество JPEG не выше {q}.',
  'settings.jpegQuality': 'Качество JPEG',
  'settings.jpegQualityHint': 'Для непрозрачных фото, фонов и экспорта картинками.',
  'settings.imageFills': 'Заливки картинкой',
  'settings.imageFills.original': 'Оригинал + кроп',
  'settings.imageFills.rasterize': 'Растеризовать',
  'settings.imageFillsHint': 'Оригинал сохраняет картинку целиком — кроп можно поправить в PowerPoint.',
  'settings.svg': 'SVG для векторов',
  'settings.svgHint': 'Иконки остаются чёткими в PowerPoint 365; PNG-копия добавляется всегда.',
  'settings.section.text': 'Текст',
  'settings.textCase': 'Текст прописными',
  'settings.textCase.cap': 'Эффект «Все прописные»',
  'settings.textCase.transform': 'Заменить на прописные',
  'settings.textCaseHint': 'Эффект сохраняет набранный текст и показывает его прописными; замена переписывает текст прописными буквами.',
  'settings.widthSlack': 'Запас ширины текста',
  'settings.widthSlackHint': 'Расширяет текстбоксы с автошириной, чтобы PowerPoint не переносил последнее слово.',
  'settings.clippedText': 'Частично обрезанный текст',
  'settings.clippedText.rasterize': 'Растеризовать',
  'settings.clippedText.keep': 'Оставить текстом',
  'settings.section.layers': 'Фигуры и слои',
  'settings.groups': 'Сохранять группы',
  'settings.groupsHint': 'Группы и фреймы Figma становятся группами PowerPoint.',
  'settings.gradients': 'Нативные градиенты',
  'settings.gradientsHint': 'Линейные градиенты остаются редактируемыми, а не растеризуются.',
  'settings.section.slide': 'Размер слайда',
  'settings.slideSize.frame': 'Как у фрейма',
  'settings.slideSize.custom': 'Свой',
  'settings.slideSize.frameHint': 'Слайды повторяют размер фрейма и уменьшаются до лимита PowerPoint в 56 дюймов.',
  'settings.slideSize.customHint': 'Каждый фрейм вписывается в слайд и центрируется.',
  'settings.slideSize.pdfNote': 'Только для PowerPoint; страницы PDF сохраняют размер фрейма.',
  'settings.slideSize.presets': 'Шаблоны',
  'settings.slideSize.preset.widescreen': '16:9',
  'settings.slideSize.preset.standard': '4:3',
  'settings.slideSize.preset.led': 'LED-экран 3,25:1',
  'settings.slideSize.preset.agency': 'Шаблон агентства',
  'settings.slideSize.slide': 'Слайд',
  'settings.slideSize.frames': 'Фрейм',
  'settings.slideSize.scale': 'Масштаб',
  'settings.slideSize.scaleValue': '{p} · 1 px = {pt} пт',
  'settings.slideSize.otherSizes': '+{n} другой размер|+{n} других размера|+{n} других размеров',
  'settings.slideSize.letterboxX': 'Фреймы {frame}, слайд {slide}: фреймы вписываются с полями по {bar} {unit} слева и справа.',
  'settings.slideSize.letterboxY': 'Фреймы {frame}, слайд {slide}: фреймы вписываются с полями по {bar} {unit} сверху и снизу.',
  'settings.slideSize.mixed':
    '{n} из {total} фреймов с другими пропорциями — по краям будут поля|{n} из {total} фреймов с другими пропорциями — по краям будут поля|{n} из {total} фреймов с другими пропорциями — по краям будут поля',
  'settings.width': 'Ширина',
  'settings.height': 'Высота',
  'settings.unit': 'Единицы',
  'settings.unitIn': 'дюйм',
  'settings.unitCm': 'см',
  'settings.section.meta': 'Свойства документа',
  'settings.author': 'Автор',
  'settings.company': 'Организация',
  'settings.metaHint': 'Заголовок документа — название презентации.',
  'settings.section.fonts': 'Шрифты',
  'settings.fonts.count': '{n} шрифт|{n} шрифта|{n} шрифтов',
  'settings.fonts.naming': 'Имена шрифтов в PowerPoint',
  'settings.fonts.naming.ribbi': 'RIBBI (стандарт Windows)',
  'settings.fonts.naming.ribbiHint': 'Regular, Bold, Italic и Bold Italic — имя семейства + атрибуты B / I; остальные начертания — отдельные семейства.',
  'settings.fonts.naming.full': 'Полные имена начертаний',
  'settings.fonts.naming.fullHint': 'Отдельное семейство на каждое начертание («Семейство Bold», без атрибута B), как во многих шаблонах агентств.',
  'settings.fonts.naming.example': 'Например: {figma} → {face}',
  'settings.fonts.mapping': 'Соответствие шрифтов',
  'settings.fonts.figma': 'Шрифт в Figma',
  'settings.fonts.face': 'Шрифт в PowerPoint',
  'settings.fonts.bold': 'Атрибут «Полужирный»',
  'settings.fonts.italic': 'Атрибут «Курсив»',
  'settings.fonts.resetRow': 'Вернуть автоматическое соответствие',
  'settings.fonts.missing': 'нет в Figma',
  'settings.fonts.overridden': 'вручную',
  'settings.fonts.uses': '{n} раз|{n} раза|{n} раз',
  'settings.fonts.empty': 'В презентации пока нет текста.',
  'settings.fonts.failed': 'Не удалось загрузить шрифты. Закройте и снова откройте настройки, чтобы повторить.',
  'settings.fonts.ribbiTitle': 'Что такое RIBBI?',
  'settings.fonts.ribbiText':
    'Windows объединяет под одним именем семейства не больше четырёх начертаний: Regular, Bold, Italic и Bold Italic (RIBBI). Они записываются именем семейства с атрибутами «полужирный» / «курсив». Любое другое начертание (Light, Medium, Semibold, Black…) — отдельное семейство с именем «Семейство Начертание». Переопределите строку, если у получателя шрифты установлены иначе.',

  'settings.section.about': 'О плагине',
  'about.version': 'Версия {version}',
  'about.privacy': 'Работает только на вашем компьютере. Данные не покидают Figma — у плагина нет доступа к сети.',
  'about.support': 'Помощь и обратная связь',
  'about.emailTitle': 'Написать на {email}',
  'about.licenses': 'Лицензии открытого ПО',
  'about.licensesIntro': '{product} использует следующее открытое программное обеспечение.',

  'progress.title.pptx': 'Экспорт в PowerPoint',
  'progress.title.pdf': 'Экспорт в PDF',
  'progress.title.json': 'Экспорт IR JSON',
  'progress.starting': 'Подготовка…',
  'progress.extract': 'Обработка слайда {i} из {n}',
  'progress.pdfPages': 'Экспорт страницы {i} из {n}',
  'progress.images': 'Сжатие изображений {i} из {n}',
  'progress.imageSize': '{w} × {h} px',
  'progress.mainThread': 'без фонового потока, плагин может подвисать',
  'progress.build': 'Сборка слайда {i} из {n}',
  'progress.package': 'Запись файла PowerPoint',
  'progress.merge': 'Склейка страниц PDF',
  'progress.render': 'Сборка страниц PDF',
  'progress.serialize': 'Запись JSON',
  'progress.layers': '{n} слой|{n} слоя|{n} слоёв',
  'progress.jobs': 'растеризация {done} из {total}',
  'progress.cancel': 'Отменить',
  'progress.cancelling': 'Отмена…',

  'report.title': 'Экспорт завершён',
  'report.slides': 'Слайды',
  'report.size': 'Размер',
  'report.duration': 'Время',
  'report.texts': 'Текстбоксы',
  'report.shapes': 'Фигуры',
  'report.images': 'Картинки',
  'report.groups': 'Группы',
  'report.imagesLine': 'Картинки: {n} · {before} → {after} ({pct})',
  'report.method.palette-lossy': 'палитра: {n}',
  'report.method.palette-exact': 'точная палитра: {n}',
  'report.method.jpeg': 'JPEG: {n}',
  'report.method.lossless': 'без потерь: {n}',
  'report.method.original': 'без изменений: {n}',
  'report.imagesDownscaled': 'уменьшено: {n}',
  'report.imagesFailed': 'ошибок: {n}',
  'report.imagesCompressionOff': 'сжатие выключено',
  'report.imagesMainThread': 'Картинки сжимались без фонового потока (здесь он недоступен), поэтому плагин мог подвисать.',
  'report.pdfDedupe': 'Повторы картинок и шрифтов сохранены один раз: объектов — {n}, экономия {size}',
  'report.downloadAgain': 'Скачать ещё раз',
  'report.downloadHint': 'Файл не скачался? Нажмите «Скачать ещё раз».',
  'report.copy': 'Скопировать отчёт',
  'report.copied': 'Отчёт скопирован в буфер обмена',
  'report.copyFailed': 'Не удалось скопировать отчёт',
  'report.fonts': 'Шрифты',
  'report.fontsWarning': 'Шрифты не встроены в файл. Установите их на каждом компьютере, где файл будут открывать, иначе PowerPoint подставит другие.',
  'report.fontFigma': 'Figma',
  'report.fontFace': 'В PowerPoint',
  'report.fontOverridden': 'задано вручную',
  'report.noFonts': 'В экспортированных слайдах нет текста.',
  'report.raster': 'Растеризованные слои',
  'report.rasterNone': 'Ничего не растеризовано.',
  'report.moreItems': 'и ещё {n}',
  'report.skipped': 'Пропущенные слои',
  'report.skippedCount': '{n} слой вне слайда или обрезающего фрейма|{n} слоя вне слайда или обрезающих фреймов|{n} слоёв вне слайда или обрезающих фреймов',
  'report.warnings': 'Предупреждения',
  'report.notes': 'Заметки',
  'report.slideLabel': 'Слайд {i}: {name}',
  'report.textHeader': 'Отчёт об экспорте {product}',

  'code.missing-frame': 'Фрейма больше нет, он пропущен',
  'code.missing-font': 'Шрифта нет в Figma; текст может не совпасть',
  'code.export-failed': 'Не удалось экспортировать, слой пропущен',
  'code.slide-scaled': 'Слайд масштабирован под размер презентации',
  'code.group-flattened': 'Группу не удалось сохранить, она разгруппирована',
  'code.text-truncated': 'Обрезанный текст экспортирован целиком',
  'code.text-leading-trim': 'Обрезка по вертикали (leading trim) не поддерживается PowerPoint',
  'code.exact-text-in-background': 'Текст вошёл в фоновую картинку',
  'code.outside-clip': 'За пределами слайда или обрезающего фрейма',
  'code.image-unreadable': 'Картинку заливки не удалось прочитать; слой растеризован',
  'code.root-effect-dropped': 'Эффект фрейма слайда нельзя передать точно (например, блюр всего слайда)',
  'code.root-effect-ignored': 'Эффект фрейма слайда пропущен (тень или фоновый блюр за пределами слайда)',
  'code.pdf-page-scaled': 'Страница уменьшена до лимита PDF — 200 дюймов по стороне',
  'code.pdf-image-skipped': 'Элементы, которые не являются картинками, не попали в PDF',

  'reason.exact-mode': 'Режим «Точный вид»',
  'reason.image-mode': 'Слайд картинкой',
  'reason.vector': 'Вектор',
  'reason.boolean-operation': 'Булева операция',
  'reason.gradient': 'Градиент',
  'reason.gradient-text': 'Градиент или картинка в тексте',
  'reason.image-fill-mode': 'Режим заливки картинкой',
  'reason.image-filters': 'Фильтры картинки',
  'reason.image-format': 'Формат картинки',
  'reason.multiple-fills': 'Несколько заливок',
  'reason.mixed-radii': 'Разные радиусы углов',
  'reason.blend-mode': 'Режим наложения',
  'reason.mask': 'Маска',
  'reason.blur': 'Размытие',
  'reason.effects': 'Эффекты',
  'reason.stroke': 'Обводка',
  'reason.transform': 'Скос или отражение',
  'reason.clip': 'Обрезано фреймом',
  'reason.group-opacity': 'Прозрачность группы',
  'reason.unsupported-node': 'Неподдерживаемый тип слоя',
  'reason.unsupported-paint': 'Неподдерживаемый тип заливки',
  'reason.setting': 'Настройка экспорта',
  'reason.text-feature': 'Неподдерживаемое свойство текста',

  'toast.no-frames-selected': 'Выделите на холсте фреймы или секцию, чтобы добавить их как слайды.',
  'toast.already-in-deck': 'Выделенные фреймы уже есть в презентации.',
  'toast.slides-added': 'В презентацию добавлен {n} слайд|В презентацию добавлено {n} слайда|В презентацию добавлено {n} слайдов',
  'toast.frame-missing': 'Этого фрейма больше нет.',
  'toast.export-busy': 'Экспорт уже выполняется.',
  'toast.fonts-failed': 'Не удалось прочитать шрифты презентации.',
  'toast.error': 'Что-то пошло не так: {message}',

  'error.export': 'Ошибка экспорта: {message}',
  'error.exportUnknown': 'Ошибка экспорта. Повторите попытку или закройте и снова откройте плагин.',
  'error.cancelled': 'Экспорт отменён',
  'error.busy': 'Экспорт уже выполняется.',
  'error.noPages': 'Не экспортировано ни одной страницы.',
  'error.noSlides': 'Не удалось экспортировать ни одного слайда.',

  'unit.bytes': '{n} Б',
  'unit.kb': '{n} КБ',
  'unit.mb': '{n} МБ',
  'unit.seconds': '{n} с',
  'unit.minutes': '{m} мин {s} с',

  'window.resize': 'Потяните, чтобы изменить размер',
};

export const DICTIONARIES: Readonly<Record<Lang, Dictionary>> = { en, ru };

/** Plural category order per language (index into the `|`-separated forms). */
const PLURAL_FORMS: Readonly<Record<Lang, readonly Intl.LDMLPluralRule[]>> = {
  en: ['one', 'other'],
  ru: ['one', 'few', 'many'],
};

/** `ru`, `ru-RU`, `RU` → ru; anything else → en. */
export function detectLang(language: string | null | undefined): Lang {
  return /^ru\b/i.test((language ?? '').trim()) ? 'ru' : 'en';
}

/** The browser / system language (`navigator.language`), or '' outside a browser. */
export function systemLanguage(): string {
  return typeof navigator !== 'undefined' && typeof navigator.language === 'string' ? navigator.language : '';
}

/**
 * UI language for the Settings choice: `en` / `ru` as chosen; `auto` (or anything unknown) → Russian
 * only when the system language is Russian, English otherwise.
 */
export function resolveLang(setting: UiLanguage | undefined, system: string | null | undefined = systemLanguage()): Lang {
  return setting === 'en' || setting === 'ru' ? setting : detectLang(system);
}

let current: Lang = detectLang(systemLanguage());

export function getLang(): Lang {
  return current;
}

/** Switch the language of every following `t()` call (App re-renders right after). */
export function setLang(lang: Lang): void {
  current = lang;
}

export type Vars = Record<string, string | number>;

function interpolate(template: string, vars?: Vars): string {
  const all: Vars = { product: CONFIG.meta.productName, ...vars };
  return template.replace(/\{(\w+)\}/g, (m, name: string) => (name in all ? String(all[name]) : m));
}

/** Translated string with `{name}` placeholders filled. */
export function t(key: MessageKey, vars?: Vars, lang: Lang = current): string {
  return interpolate(DICTIONARIES[lang][key] ?? en[key] ?? key, vars);
}

/** Index of the plural form for `n` in `lang` (see PLURAL_FORMS). */
export function pluralIndex(n: number, lang: Lang): number {
  const forms = PLURAL_FORMS[lang];
  const category = new Intl.PluralRules(lang === 'ru' ? 'ru-RU' : 'en-US').select(n);
  const i = forms.indexOf(category);
  // Categories a language does not list (ru "other" for fractions, en "few"…) use the last form.
  return i >= 0 ? i : forms.length - 1;
}

/** Plural-aware translation: picks the form for `n` and fills `{n}` + `vars`. */
export function tp(key: MessageKey, n: number, vars?: Vars, lang: Lang = current): string {
  const forms = (DICTIONARIES[lang][key] ?? en[key]).split('|');
  const form = forms[Math.min(pluralIndex(n, lang), forms.length - 1)];
  return interpolate(form, { n: formatNumber(n, lang), ...vars });
}

/**
 * Text of a main-thread toast: the localized `toast.<code>` string (plural when the template has
 * forms and `params.n` is a number), or main's English `message` when there is no code / the code is
 * unknown to this UI.
 */
export function toastText(msg: { message: string; code?: string; params?: Vars }, lang: Lang = current): string {
  if (!msg.code) return msg.message;
  const key = `toast.${msg.code}` as MessageKey;
  if (!(key in en)) return msg.message;
  const params: Vars = msg.params ?? {};
  if (DICTIONARIES[lang][key].includes('|') && typeof params.n === 'number') {
    const { n, ...rest } = params;
    return tp(key, n as number, rest, lang);
  }
  return t(key, params, lang);
}

export function formatNumber(n: number, lang: Lang = current, maxFractionDigits = 0): string {
  return new Intl.NumberFormat(lang === 'ru' ? 'ru-RU' : 'en-US', { maximumFractionDigits: maxFractionDigits }).format(n);
}

/** 0.499 → "49.9%" / "49,9 %". */
export function formatPercent(fraction: number, lang: Lang = current, maxFractionDigits = 1): string {
  return new Intl.NumberFormat(lang === 'ru' ? 'ru-RU' : 'en-US', { style: 'percent', maximumFractionDigits: maxFractionDigits }).format(fraction);
}

/** Human-readable byte size (1 KB = 1024 B). */
export function formatBytes(bytes: number, lang: Lang = current): string {
  if (bytes < 1024) return t('unit.bytes', { n: formatNumber(bytes, lang) }, lang);
  if (bytes < 1024 * 1024) return t('unit.kb', { n: formatNumber(bytes / 1024, lang, bytes < 10 * 1024 ? 1 : 0) }, lang);
  return t('unit.mb', { n: formatNumber(bytes / (1024 * 1024), lang, 1) }, lang);
}

/** Duration in ms → "3.4 s" / "2 min 5 s". */
export function formatDuration(ms: number, lang: Lang = current): string {
  const seconds = Math.max(0, ms) / 1000;
  if (seconds < 60) return t('unit.seconds', { n: formatNumber(seconds, lang, seconds < 10 ? 1 : 0) }, lang);
  const m = Math.floor(seconds / 60);
  return t('unit.minutes', { m, s: Math.round(seconds - m * 60) }, lang);
}

/** Localized label of a rasterization reason. */
export function reasonLabel(reason: RasterReason, lang: Lang = current): string {
  const key = `reason.${reason}` as MessageKey;
  return key in en ? t(key, undefined, lang) : reason;
}

/** Localized short description of a report entry code, or null when the code is unknown. */
export function codeLabel(code: string, lang: Lang = current): string | null {
  const key = `code.${code}` as MessageKey;
  return key in en ? t(key, undefined, lang) : null;
}
