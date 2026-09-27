/**
 * UI strings (English + Russian). Every visible string of the plugin UI lives here.
 *
 * - `t(key, vars)` interpolates `{name}` placeholders.
 * - Plural keys (`*.count`-style, marked with `|`) hold one form per plural category:
 *   en `one|other`, ru `one|few|many` — use `tp(key, n, vars)`; `{n}` is always available.
 * - The language is chosen once from `navigator.language` (`ru*` → ru, everything else → en).
 *
 * Environment-neutral (no DOM access at module load) so tests can import it in Node.
 */
import type { RasterReason } from '../ir/types';

export type Lang = 'en' | 'ru';

const en = {
  // Generic
  'common.cancel': 'Cancel',
  'common.close': 'Close',
  'common.done': 'Done',
  'common.loading': 'Loading…',

  // Empty state
  'empty.title': 'No active slides',
  'empty.text': 'Looks like there are no slides in the deck. Select frames on the canvas and click the button below to add them to the deck.',
  'empty.hintNoFrames': 'Select one or more frames (or a section) on the canvas first.',
  'empty.hintAllInDeck': 'The selected frames are already in the deck.',

  // Add slides
  'add.button': 'Add slides',
  'add.buttonSidebar': 'Add Slides',
  'add.buttonN': 'Add {n} slide|Add {n} slides',
  'add.buttonSidebarN': 'Add {n} slide|Add {n} slides',

  // Sidebar
  'sidebar.title': 'Slides',
  'sidebar.sort': 'Sort by position on canvas',
  'sidebar.remove': 'Remove from deck',
  'sidebar.missing': 'This frame no longer exists. It will be skipped on export.',
  'sidebar.slideTooltip': '{name} · {w}×{h} · {page}',
  'sidebar.dragHint': 'Drag to reorder · double-click to show on canvas',

  // Top bar
  'top.titlePlaceholder': 'Untitled deck',
  'top.titleEdit': 'Click to rename the deck',
  'top.settings': 'Settings',
  'top.clearAll': 'Clear All',
  'top.export': 'Export',
  'top.exportTitle': 'Export: {format}',
  'top.exportMenu': 'Choose the export format',
  'export.pptx': 'PowerPoint — editable',
  'export.pptxHint': 'Native text and shapes you can edit',
  'export.pptxHintExact': 'Exact look: one background picture, editable text on top',
  'export.pptxImage': 'PowerPoint — images (JPEG)',
  'export.pptxImageHint': 'Looks exactly like Figma; not editable, small file',
  'export.pdf': 'PDF — vector',
  'export.pdfHint': 'Figma’s own PDF export; can be very heavy',
  'export.pdfImage': 'PDF — images (JPEG)',
  'export.pdfImageHint': 'One JPEG per page; light file',
  'export.irJson': 'IR JSON (debug)',
  'export.irJsonHint': 'Intermediate representation for bug reports',
  'export.noSlides': 'Add slides to the deck before exporting.',

  // Clear all
  'clear.title': 'Clear the deck?',
  'clear.text': 'Remove {n} slide from the deck?|Remove all {n} slides from the deck?',
  'clear.note': 'Frames on the canvas are not affected.',
  'clear.confirm': 'Clear all',

  // Preview
  'preview.counter': '{i}/{n}',
  'preview.focusHint': 'Double-click to show the frame on the canvas',
  'preview.missing': 'This frame no longer exists',
  'preview.missingHint': 'It was deleted or is no longer a frame. Remove it from the deck or undo the change in Figma.',
  'preview.loading': 'Rendering preview…',
  'preview.failed': 'Preview unavailable',
  'preview.failedHint': 'Figma could not render this frame.',

  // Settings
  'settings.title': 'Export settings',
  'settings.reset': 'Reset to defaults',
  'settings.section.mode': 'PowerPoint — editable',
  'settings.mode.editable': 'Editable',
  'settings.mode.editableHint': 'Native text, shapes, pictures and groups; the rest is rasterized per layer.',
  'settings.mode.exact': 'Exact look',
  'settings.mode.exactHint': 'Everything except text is one background picture; text stays editable.',
  'settings.modeNote': 'The image exports (PowerPoint / PDF — images) always bake every slide into one JPEG.',
  'settings.section.images': 'Images',
  'settings.scale': 'Raster scale',
  'settings.scaleHint': 'Resolution of rasterized layers, backgrounds and image exports.',
  'settings.compression': 'Image compression',
  'settings.compressionHint': 'Runs locally in the plugin; nothing is uploaded.',
  'settings.compression.off': 'Off',
  'settings.compression.offHint': 'Pictures stay exactly as Figma exports them.',
  'settings.compression.balanced': 'Balanced — like TinyPNG',
  'settings.compression.balancedHint': 'Visually lossless: smart palette for PNGs, JPEG for opaque photos. Typically −70%.',
  'settings.compression.strong': 'Strong',
  'settings.compression.strongHint': 'Smaller files, slight loss: fewer colours, JPEG quality at most {q}.',
  'settings.jpegQuality': 'JPEG quality',
  'settings.jpegQualityHint': 'Opaque photos and backgrounds, and the image exports.',
  'settings.imageFills': 'Image fills',
  'settings.imageFills.original': 'Original + crop',
  'settings.imageFills.rasterize': 'Rasterize',
  'settings.imageFillsHint': 'Original keeps the full image (re-croppable in PowerPoint).',
  'settings.svg': 'SVG for vectors',
  'settings.svgHint': 'Icons stay sharp in PowerPoint 365; a PNG fallback is always included.',
  'settings.section.text': 'Text',
  'settings.textCase': 'UPPER text',
  'settings.textCase.cap': 'Caps attribute',
  'settings.textCase.transform': 'Transform text',
  'settings.textCaseHint': 'Caps attribute keeps the typed text; transform writes it in capitals.',
  'settings.widthSlack': 'Width slack',
  'settings.widthSlackHint': 'Extra width for auto-width text boxes so PowerPoint does not wrap the last word.',
  'settings.clippedText': 'Partially clipped text',
  'settings.clippedText.rasterize': 'Rasterize',
  'settings.clippedText.keep': 'Keep editable',
  'settings.section.layers': 'Shapes & layers',
  'settings.groups': 'Keep groups',
  'settings.groupsHint': 'Figma groups and frames become PowerPoint groups.',
  'settings.gradients': 'Native gradients',
  'settings.gradientsHint': 'Linear gradients stay editable instead of being rasterized.',
  'settings.section.slide': 'Slide size',
  'settings.slideSize.frame': 'Frame size',
  'settings.slideSize.custom': 'Custom',
  'settings.slideSize.frameHint': 'Frame size, auto-scaled to PowerPoint’s 56-inch limit.',
  'settings.slideSize.customHint': 'Every frame is scaled uniformly to fit and centered.',
  'settings.slideSize.pdfNote': 'PowerPoint exports only; PDF pages keep the frame size.',
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
  'settings.slideSize.letterboxX': 'Frames are {frame}, the slide is {slide}: frames are scaled to fit with {bar} {unit} bars on the left and right.',
  'settings.slideSize.letterboxY': 'Frames are {frame}, the slide is {slide}: frames are scaled to fit with {bar} {unit} bars at the top and bottom.',
  'settings.slideSize.mixed': '{n} of {total} frames has a different ratio and will get bars|{n} of {total} frames have a different ratio and will get bars',
  'settings.width': 'Width',
  'settings.height': 'Height',
  'settings.unit': 'Units',
  'settings.unitIn': 'in',
  'settings.unitCm': 'cm',
  'settings.section.meta': 'Document properties',
  'settings.author': 'Author',
  'settings.company': 'Company',
  'settings.metaHint': 'The title is the deck title.',
  'settings.section.fonts': 'Fonts',
  'settings.fonts.count': '{n} font|{n} fonts',
  'settings.fonts.naming': 'Font names in PowerPoint',
  'settings.fonts.naming.ribbi': 'RIBBI (Windows standard)',
  'settings.fonts.naming.ribbiHint': 'Regular, Bold, Italic, Bold Italic = family name + B / I; other weights are families of their own.',
  'settings.fonts.naming.full': 'Full style names',
  'settings.fonts.naming.fullHint': 'One family per weight, like Deck and agency templates: “Family Bold”, no B attribute.',
  'settings.fonts.naming.example': 'Example: {figma} → {face}',
  'settings.fonts.mapping': 'Font mapping',
  'settings.fonts.figma': 'Figma font',
  'settings.fonts.face': 'PowerPoint face',
  'settings.fonts.bold': 'Bold attribute',
  'settings.fonts.italic': 'Italic attribute',
  'settings.fonts.resetRow': 'Reset to the automatic mapping',
  'settings.fonts.missing': 'missing in Figma',
  'settings.fonts.overridden': 'custom',
  'settings.fonts.uses': '{n} use|{n} uses',
  'settings.fonts.empty': 'No text in the deck yet.',
  'settings.fonts.ribbiTitle': 'What is RIBBI?',
  'settings.fonts.ribbiText':
    'Windows groups at most four styles under one family name: Regular, Bold, Italic and Bold Italic (RIBBI). They are written as the family name plus the Bold / Italic attributes. Every other style (Light, Medium, Semibold, Black…) is a family of its own, named "Family Style". Override a row if the fonts on the recipient’s machine are installed differently.',

  // Progress
  'progress.title.pptx': 'Exporting PowerPoint',
  'progress.title.pdf': 'Exporting PDF',
  'progress.title.json': 'Exporting IR JSON',
  'progress.starting': 'Preparing…',
  'progress.extract': 'Extracting slide {i} of {n}',
  'progress.pdfPages': 'Exporting page {i} of {n}',
  'progress.images': 'Compressing images {i} of {n}',
  'progress.imageSize': '{w} × {h} px',
  'progress.mainThread': 'no background worker, the window may pause',
  'progress.build': 'Building slide {i} of {n}',
  'progress.package': 'Building PPTX',
  'progress.merge': 'Merging PDF',
  'progress.render': 'Rendering PDF pages',
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
  'report.images': 'Pictures',
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
  'report.imagesMainThread': 'Images were compressed without a background worker (not available here), so the window could pause.',
  'report.pdfDedupe': 'Repeated images and fonts stored once: {n} objects, {size} saved',
  'report.downloadAgain': 'Download again',
  'report.copy': 'Copy report',
  'report.copied': 'Report copied to the clipboard',
  'report.copyFailed': 'Could not copy the report',
  'report.fonts': 'Fonts',
  'report.fontsWarning': 'Fonts are not embedded. Install them on every machine that opens the file, otherwise PowerPoint substitutes another font.',
  'report.fontFigma': 'Figma',
  'report.fontFace': 'Written as',
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
  'report.textHeader': 'FigmaDeck export report',

  // Report entry codes (localized short descriptions; unknown codes fall back to the English message)
  'code.missing-frame': 'The frame no longer exists and was skipped',
  'code.missing-font': 'Uses a font missing in Figma; the text box may not match',
  'code.export-failed': 'Could not be exported and was skipped',
  'code.slide-scaled': 'Slide was scaled to fit the presentation size',
  'code.group-flattened': 'Group could not be kept and was flattened',
  'code.text-truncated': 'Truncated text is exported in full',
  'code.text-leading-trim': 'Vertical trim is not supported by PowerPoint',
  'code.exact-text-in-background': 'Text is part of the background picture',
  'code.outside-clip': 'Outside the slide or its clipping frame',
  'code.pdf-page-scaled': 'Page scaled down to the PDF limit of 200 inches per side',
  'code.pdf-image-skipped': 'Elements that are not pictures were left out of the image PDF',

  // Raster reasons
  'reason.exact-mode': 'Exact look mode',
  'reason.image-mode': 'Slide as image',
  'reason.vector': 'Vector',
  'reason.boolean-operation': 'Boolean operation',
  'reason.gradient': 'Gradient',
  'reason.gradient-text': 'Gradient / image text',
  'reason.image-fill-mode': 'Image fill mode',
  'reason.image-filters': 'Image filters',
  'reason.image-format': 'Image format',
  'reason.multiple-fills': 'Several fills',
  'reason.mixed-radii': 'Mixed corner radii',
  'reason.blend-mode': 'Blend mode',
  'reason.mask': 'Mask',
  'reason.blur': 'Blur',
  'reason.effects': 'Effects',
  'reason.stroke': 'Stroke',
  'reason.transform': 'Skew / flip',
  'reason.clip': 'Clipped by a frame',
  'reason.group-opacity': 'Group opacity',
  'reason.unsupported-node': 'Unsupported layer type',
  'reason.unsupported-paint': 'Unsupported fill type',
  'reason.setting': 'Export setting',
  'reason.text-feature': 'Unsupported text feature',

  // Errors / toasts
  'error.export': 'Export failed: {message}',
  'error.cancelled': 'Export cancelled',
  'error.busy': 'An export is already running.',
  'error.noPages': 'No pages were exported.',
  'error.noSlides': 'No slides were extracted.',

  // Units
  'unit.bytes': '{n} B',
  'unit.kb': '{n} KB',
  'unit.mb': '{n} MB',
  'unit.seconds': '{n} s',
  'unit.minutes': '{m} min {s} s',

  // Window
  'window.resize': 'Drag to resize the window',
} as const;

export type MessageKey = keyof typeof en;
export type Dictionary = Record<MessageKey, string>;

const ru: Dictionary = {
  'common.cancel': 'Отмена',
  'common.close': 'Закрыть',
  'common.done': 'Готово',
  'common.loading': 'Загрузка…',

  'empty.title': 'В презентации нет слайдов',
  'empty.text': 'Похоже, в презентации пока нет слайдов. Выделите фреймы на холсте и нажмите кнопку ниже, чтобы добавить их.',
  'empty.hintNoFrames': 'Сначала выделите на холсте один или несколько фреймов (или секцию).',
  'empty.hintAllInDeck': 'Выделенные фреймы уже есть в презентации.',

  'add.button': 'Добавить слайды',
  'add.buttonSidebar': 'Добавить слайды',
  'add.buttonN': 'Добавить {n} слайд|Добавить {n} слайда|Добавить {n} слайдов',
  'add.buttonSidebarN': 'Ещё {n} слайд|Ещё {n} слайда|Ещё {n} слайдов',

  'sidebar.title': 'Слайды',
  'sidebar.sort': 'Упорядочить по положению на холсте',
  'sidebar.remove': 'Убрать из презентации',
  'sidebar.missing': 'Этого фрейма больше нет. При экспорте он будет пропущен.',
  'sidebar.slideTooltip': '{name} · {w}×{h} · {page}',
  'sidebar.dragHint': 'Перетащите, чтобы изменить порядок · двойной клик — показать на холсте',

  'top.titlePlaceholder': 'Без названия',
  'top.titleEdit': 'Нажмите, чтобы переименовать',
  'top.settings': 'Настройки',
  'top.clearAll': 'Очистить',
  'top.export': 'Экспорт',
  'top.exportTitle': 'Экспорт: {format}',
  'top.exportMenu': 'Выбрать формат экспорта',
  'export.pptx': 'PowerPoint — редактируемый',
  'export.pptxHint': 'Нативные текст и фигуры, всё редактируется',
  'export.pptxHintExact': 'Точный вид: фон одной картинкой, текст редактируется',
  'export.pptxImage': 'PowerPoint — картинки (JPEG)',
  'export.pptxImageHint': 'Выглядит точно как в Figma; не редактируется, файл маленький',
  'export.pdf': 'PDF — векторный',
  'export.pdfHint': 'Собственный PDF-экспорт Figma; бывает очень тяжёлым',
  'export.pdfImage': 'PDF — картинки (JPEG)',
  'export.pdfImageHint': 'По JPEG на страницу; лёгкий файл',
  'export.irJson': 'IR JSON (отладка)',
  'export.irJsonHint': 'Промежуточное представление для баг-репортов',
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

  'settings.title': 'Настройки экспорта',
  'settings.reset': 'Сбросить настройки',
  'settings.section.mode': 'PowerPoint — редактируемый',
  'settings.mode.editable': 'Редактируемый',
  'settings.mode.editableHint': 'Нативные текст, фигуры, картинки и группы; остальное растеризуется послойно.',
  'settings.mode.exact': 'Точный вид',
  'settings.mode.exactHint': 'Всё, кроме текста, — одна фоновая картинка; текст остаётся редактируемым.',
  'settings.modeNote': 'Экспорт картинками (PowerPoint / PDF — картинки) всегда запекает каждый слайд в один JPEG.',
  'settings.section.images': 'Изображения',
  'settings.scale': 'Масштаб растра',
  'settings.scaleHint': 'Разрешение растеризованных слоёв, фонов и экспорта картинками.',
  'settings.compression': 'Сжатие изображений',
  'settings.compressionHint': 'Выполняется локально в плагине, ничего не загружается.',
  'settings.compression.off': 'Выключено',
  'settings.compression.offHint': 'Картинки остаются такими, как их экспортирует Figma.',
  'settings.compression.balanced': 'Сбалансированное — как TinyPNG',
  'settings.compression.balancedHint': 'Без видимых потерь: умная палитра для PNG, JPEG для непрозрачных фото. Обычно −70 %.',
  'settings.compression.strong': 'Сильное',
  'settings.compression.strongHint': 'Файлы меньше, небольшие потери: меньше цветов, качество JPEG не выше {q}.',
  'settings.jpegQuality': 'Качество JPEG',
  'settings.jpegQualityHint': 'Непрозрачные фото и фоны, а также экспорт картинками.',
  'settings.imageFills': 'Заливки картинкой',
  'settings.imageFills.original': 'Оригинал + кроп',
  'settings.imageFills.rasterize': 'Растеризовать',
  'settings.imageFillsHint': 'Оригинал сохраняет картинку целиком (кроп можно поправить в PowerPoint).',
  'settings.svg': 'SVG для векторов',
  'settings.svgHint': 'Иконки остаются чёткими в PowerPoint 365; PNG-копия добавляется всегда.',
  'settings.section.text': 'Текст',
  'settings.textCase': 'ВЕРХНИЙ регистр',
  'settings.textCase.cap': 'Атрибут «Все прописные»',
  'settings.textCase.transform': 'Менять текст',
  'settings.textCaseHint': 'Атрибут сохраняет набранный текст; «менять текст» записывает его прописными.',
  'settings.widthSlack': 'Запас ширины',
  'settings.widthSlackHint': 'Дополнительная ширина текстбоксов с автошириной, чтобы PowerPoint не переносил последнее слово.',
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
  'settings.slideSize.frameHint': 'Размер фрейма с автоматическим уменьшением до лимита PowerPoint 56 дюймов.',
  'settings.slideSize.customHint': 'Каждый фрейм равномерно вписывается в слайд и центрируется.',
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
  'settings.fonts.naming.ribbiHint': 'Regular, Bold, Italic, Bold Italic — имя семейства + атрибуты B / I; остальные начертания — отдельные семейства.',
  'settings.fonts.naming.full': 'Полные имена начертаний',
  'settings.fonts.naming.fullHint': 'Отдельное семейство на каждое начертание, как в Deck и шаблонах агентств: «Семейство Bold», без атрибута B.',
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
  'settings.fonts.ribbiTitle': 'Что такое RIBBI?',
  'settings.fonts.ribbiText':
    'Windows объединяет под одним именем семейства не больше четырёх начертаний: Regular, Bold, Italic и Bold Italic (RIBBI). Они записываются именем семейства с атрибутами «полужирный» / «курсив». Любое другое начертание (Light, Medium, Semibold, Black…) — отдельное семейство с именем «Семейство Начертание». Переопределите строку, если у получателя шрифты установлены иначе.',

  'progress.title.pptx': 'Экспорт в PowerPoint',
  'progress.title.pdf': 'Экспорт в PDF',
  'progress.title.json': 'Экспорт IR JSON',
  'progress.starting': 'Подготовка…',
  'progress.extract': 'Извлечение слайда {i} из {n}',
  'progress.pdfPages': 'Экспорт страницы {i} из {n}',
  'progress.images': 'Сжатие изображений {i} из {n}',
  'progress.imageSize': '{w} × {h} px',
  'progress.mainThread': 'без фонового потока, окно может подвисать',
  'progress.build': 'Сборка слайда {i} из {n}',
  'progress.package': 'Сборка PPTX',
  'progress.merge': 'Склейка PDF',
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
  'report.imagesMainThread': 'Картинки сжимались без фонового потока (здесь он недоступен), поэтому окно могло подвисать.',
  'report.pdfDedupe': 'Повторы картинок и шрифтов сохранены один раз: объектов — {n}, экономия {size}',
  'report.downloadAgain': 'Скачать ещё раз',
  'report.copy': 'Скопировать отчёт',
  'report.copied': 'Отчёт скопирован в буфер обмена',
  'report.copyFailed': 'Не удалось скопировать отчёт',
  'report.fonts': 'Шрифты',
  'report.fontsWarning': 'Шрифты не встроены в файл. Установите их на каждом компьютере, где файл будут открывать, иначе PowerPoint подставит другой шрифт.',
  'report.fontFigma': 'Figma',
  'report.fontFace': 'Записан как',
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
  'report.textHeader': 'Отчёт об экспорте FigmaDeck',

  'code.missing-frame': 'Фрейма больше нет, он пропущен',
  'code.missing-font': 'Шрифта нет в Figma; текстбокс может не совпасть',
  'code.export-failed': 'Не удалось экспортировать, слой пропущен',
  'code.slide-scaled': 'Слайд масштабирован под размер презентации',
  'code.group-flattened': 'Группу не удалось сохранить, она разгруппирована',
  'code.text-truncated': 'Обрезанный текст экспортирован целиком',
  'code.text-leading-trim': 'Обрезка по вертикали (leading trim) не поддерживается PowerPoint',
  'code.exact-text-in-background': 'Текст вошёл в фоновую картинку',
  'code.outside-clip': 'За пределами слайда или обрезающего фрейма',
  'code.pdf-page-scaled': 'Страница уменьшена до лимита PDF — 200 дюймов по стороне',
  'code.pdf-image-skipped': 'Элементы, которые не являются картинками, не попали в PDF',

  'reason.exact-mode': 'Режим «Точный вид»',
  'reason.image-mode': 'Слайд картинкой',
  'reason.vector': 'Вектор',
  'reason.boolean-operation': 'Булева операция',
  'reason.gradient': 'Градиент',
  'reason.gradient-text': 'Градиент / картинка в тексте',
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
  'reason.transform': 'Скос / отражение',
  'reason.clip': 'Обрезано фреймом',
  'reason.group-opacity': 'Прозрачность группы',
  'reason.unsupported-node': 'Неподдерживаемый тип слоя',
  'reason.unsupported-paint': 'Неподдерживаемый тип заливки',
  'reason.setting': 'Настройка экспорта',
  'reason.text-feature': 'Неподдерживаемое свойство текста',

  'error.export': 'Ошибка экспорта: {message}',
  'error.cancelled': 'Экспорт отменён',
  'error.busy': 'Экспорт уже выполняется.',
  'error.noPages': 'Не экспортировано ни одной страницы.',
  'error.noSlides': 'Не извлечено ни одного слайда.',

  'unit.bytes': '{n} Б',
  'unit.kb': '{n} КБ',
  'unit.mb': '{n} МБ',
  'unit.seconds': '{n} с',
  'unit.minutes': '{m} мин {s} с',

  'window.resize': 'Потяните, чтобы изменить размер окна',
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

let current: Lang = detectLang(typeof navigator !== 'undefined' ? navigator.language : 'en');

export function getLang(): Lang {
  return current;
}

/** For tests / screenshots. */
export function setLang(lang: Lang): void {
  current = lang;
}

export type Vars = Record<string, string | number>;

function interpolate(template: string, vars?: Vars): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (m, name: string) => (name in vars ? String(vars[name]) : m));
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
