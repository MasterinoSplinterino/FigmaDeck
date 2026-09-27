# Font embedding in PPTX — research and prototype (stage 4, EXPERIMENTAL)

Status: research done, prototype in `src/fonts/embed.ts` with tests in `tests/fonts/`. **Not wired into the UI.**
The one thing that decides whether it is worth wiring in — *does PowerPoint accept the `.fntdata` parts we write?* —
could not be verified here (no PowerPoint in this environment). See [Open questions](#8-open-questions).

## Кратко (по-русски)

* Шрифты в PPTX лежат в `ppt/fonts/fontN.fntdata`, тип `application/x-fontdata`, связь
  `…/relationships/font` из `presentation.xml`, список `<p:embeddedFontLst>` сразу после `<p:notesSz>`,
  атрибут `embedTrueTypeFonts="1"`.
* `.fntdata` — это **EOT** (Embedded OpenType), а не обфусцированный `.odttf`, как в DOCX. PowerPoint пишет
  EOT 2.2 со сжатием **MicroType Express** (MTX). LibreOffice ≥ 25.8 пишет EOT 2.2 **без сжатия** (flags = 0);
  так же делает наш прототип. Примет ли PowerPoint несжатый EOT — **не проверено** (нужен ручной тест).
* Лицензия шрифта — поле `OS/2.fsType`: 0 и 8 — можно встраивать и редактировать; 4 — только просмотр и печать
  (PowerPoint откроет файл только для чтения); 2 — встраивать нельзя; бит 9 — только битмапы. Прототип
  отказывается встраивать 2 и «только битмапы», для 4 выдаёт предупреждение.
* Keynote и Google Slides встроенные шрифты игнорируют. LibreOffice до 25.8 — тоже (проверено на 24.2:
  встроенный шрифт не используется, при установленном — используется).
* Figma не отдаёт плагину файлы шрифтов: пользователь должен сам перетащить TTF/OTF в окно плагина.

## 1. Constraint: where the font files come from

The Figma Plugin API exposes font *names* only (`figma.listAvailableFontsAsync()`, `fontName` on text) and
`figma.loadFontAsync()` for editing; there is no API that returns font binaries. The plugin also has no network
access (`networkAccess.allowedDomains: ["none"]`). So embedding needs the user to **drop the TTF / OTF files into
the plugin UI** (the UI iframe can read dropped files with the File API). The UI would then:

1. parse each file (`parseFontInfo`) — family (name ID 1), subfamily (ID 2), typographic family / subfamily
   (IDs 16 / 17), weight, italic, `fsType`;
2. match it to the deck's fonts: the PowerPoint face comes from `fonts/mapping.ts` (RIBBI), and a font embeds
   well only when its **name ID 1 equals that face** (an embedded font is most likely registered under its own
   family name — unverified, see open question 2) — `planFontEmbedding` warns (`face-mismatch`) otherwise;
3. show refusals / warnings (restricted licence, preview & print, CFF outlines);
4. after `buildPptx`, call `embedFontsIntoPptx(pptx, fonts)`.

## 2. Package structure

```xml
<!-- ppt/presentation.xml -->
<p:presentation … embedTrueTypeFonts="1" saveSubsetFonts="1">
  <p:sldMasterIdLst>…</p:sldMasterIdLst>
  <p:sldIdLst>…</p:sldIdLst>
  <p:sldSz cx="…" cy="…"/>
  <p:notesSz cx="6858000" cy="9144000"/>
  <p:embeddedFontLst>
    <p:embeddedFont>
      <p:font typeface="SB Sans Display" panose="020B0604020202020204" pitchFamily="34" charset="0"/>
      <p:regular r:id="rId8"/>
      <p:bold r:id="rId9"/>
      <p:italic r:id="rId10"/>
      <p:boldItalic r:id="rId11"/>
    </p:embeddedFont>
  </p:embeddedFontLst>
  <p:defaultTextStyle>…</p:defaultTextStyle>
</p:presentation>

<!-- ppt/_rels/presentation.xml.rels -->
<Relationship Id="rId8" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/font"
              Target="fonts/font1.fntdata"/>

<!-- [Content_Types].xml -->
<Default Extension="fntdata" ContentType="application/x-fontdata"/>
```

* **Child order of `<p:presentation>`** (ECMA-376 `CT_Presentation`, a strict sequence): `sldMasterIdLst`,
  `notesMasterIdLst`, `handoutMasterIdLst`, `sldIdLst`, `sldSz`, `notesSz`, `smartTags`, **`embeddedFontLst`**,
  `custShowLst`, `photoAlbum`, `custDataLst`, `kinsoku`, `defaultTextStyle`, `modifyVerifier`, `extLst`
  [OXSDK; LO-export writes it right after `notesSz`]. pptxgenjs itself writes `sldIdLst` *before*
  `notesMasterIdLst` (out of schema order, tolerated by PowerPoint), so the prototype never moves anything: it
  inserts the list after the last present element of the first group (in practice right after `<p:notesSz>`).
* **`<p:embeddedFont>`** = `<p:font>` (DrawingML `CT_TextFont`: `typeface`, optional `panose` = 10 bytes as 20 hex
  digits, `pitchFamily`, `charset` — both *signed* bytes, so e.g. Windows RUSSIAN_CHARSET 204 is written as
  `-52`) followed by optional `regular`, `bold`, `italic`, `boldItalic` in this order, each with `r:id`.
  One entry per typeface — the RIBBI family: e.g. "SB Sans Display Semibold" is its own entry.
* **`embedTrueTypeFonts`** — PowerPoint's "Embed fonts in the file". LibreOffice's importer only loads the list
  when it is true [LO-import]. **`saveSubsetFonts`** — "embed only the characters used" (pptxgenjs already writes
  `saveSubsetFonts="1"`; Apache POI sets both) — it tells PowerPoint how to re-embed on save; the prototype leaves
  it untouched and always stores the whole font.
* **Parts**: `/ppt/fonts/font{N}.fntdata` (PowerPoint / POI naming [POI-rel]; LibreOffice writes
  `Font_1_Family_Regular.fntdata` [LO-export]). **Content type** `application/x-fontdata` [POI-rel, MS-OI29500];
  forgetting the `<Default>` makes PowerPoint offer to repair the file [pandoc-11492].
* **Relationship type** `http://schemas.openxmlformats.org/officeDocument/2006/relationships/font` [POI-rel, LO-export].

## 3. The `.fntdata` format: EOT

**Finding:** a PowerPoint `.fntdata` part is an **Embedded OpenType (EOT)** stream — *not* an obfuscated font like
WordprocessingML's `.odttf` (DOCX XOR-obfuscates the first 32 bytes with a GUID key and uses the content type
`application/vnd.openxmlformats-officedocument.obfuscatedFont`; PresentationML does not). Evidence, all read
from source code:

| Source | What it shows |
|---|---|
| Apache POI `FontHeader` [POI-header] | "The header data of an EOT font"; rejects anything whose version is not `0x00010000` / `0x00020001` / `0x00020002` or whose magic is not `0x504C` ("not a EOT font data stream"). `XSLFFontInfo.addFontToSlideShow` takes "the (MTX) font data" [POI-info]. |
| LibreOffice import [LO-import, LO-manager] | `EmbeddedFontListContext` passes every `.fntdata` to `EmbeddedFontsManager::addEmbeddedFont(…, eot = true)`, which decodes it with **libeot** (`EOT2ttf_buffer`, handles MTX + XOR) and checks `EOTcanLegallyEdit`. Without libeot (`--disable-eot`) nothing is imported. |
| LibreOffice export [LO-export, LO-eot] | `font::EOTConverter` wraps the **unmodified** TTF in an EOT header: version `0x00020002`, **flags 0** (no subsetting, no MTX, no XOR), fields from OS/2 / head / name. |
| pptxboss [pptxboss-pr, pptxboss-src] | Writes EOT 2.2 with **MTX compression** (flag `0x4`), "as PowerPoint writes it"; its LZCOMP port "reproduces PowerPoint-written font parts byte-for-byte"; a header test is named `eot_header_matches_the_layout_powerpoint_writes`. Falls back to flags 0 for fonts its compressor cannot handle. |
| libeot [libeot] | Reference reader: versions 1.0 / 2.1 / 2.2, flags `TTEMBED_TTCOMPRESSED 0x4` (MTX), `TTEMBED_XORENCRYPTDATA 0x10000000` (XOR key `0x50`). |

So PowerPoint writes **EOT 2.2 + MTX** (plus `TTEMBED_SUBSET 0x1` when it subsets). XOR is part of EOT but no
source shows PowerPoint using it. LibreOffice ≥ 25.8 deliberately writes **uncompressed** EOT for every font in its
PPTX export (pptxboss only for fonts its compressor cannot handle) — the public writers that target PowerPoint
without MTX.

### EOT 2.2 layout written by `makeFntdata` (little-endian, offsets in bytes)

| Offset | Field | Value |
|---|---|---|
| 0 | EOTSize (u32) | total length |
| 4 | FontDataSize (u32) | length of the TTF/OTF |
| 8 | Version (u32) | `0x00020002` |
| 12 | Flags (u32) | `0` |
| 16 | FontPANOSE[10] | OS/2 panose |
| 26 | Charset (u8) | `CONFIG.fontEmbed.eotCharset` = 0 (as LibreOffice / pptxboss) |
| 27 | Italic (u8) | OS/2 fsSelection bit 0 / macStyle |
| 28 | Weight (u32) | OS/2 usWeightClass |
| 32 | fsType (u16) | OS/2 fsType, verbatim |
| 34 | MagicNumber (u16) | `0x504C` |
| 36 | UnicodeRange1–4, CodePageRange1–2 (u32 × 6) | OS/2 |
| 60 | CheckSumAdjustment (u32) | head |
| 64 | Reserved1–4 (u32 × 4) | 0 |
| 80 | Padding1, FamilyNameSize, FamilyName | name ID 1, UTF-16LE, size includes a terminating NUL |
| … | Padding, StyleName / VersionName / FullName | name IDs 2 / 5 / 4, same encoding |
| … | Padding5, RootStringSize = 0 | no URL restriction |
| … | RootStringCheckSum (u32) | `0x50475342` (checksum of the empty root string) |
| … | EUDCCodePage (u32) | 1252 |
| … | Padding6, SignatureSize = 0, EUDCFlags = 0, EUDCFontSize = 0 | |
| … | FontData | the font file, unchanged |

This is byte-for-byte the layout of LibreOffice's `EOTConverter` and pptxboss' `eot()` (flags aside).
Verified here: an independent libeot port ([mtx-decompressor], `parseEotMetadata` + `eotToTtf`) parses the
output of `makeFntdata` for Liberation Sans, DejaVu Sans Bold, Loma (CFF) and OpenSymbol as version 2.2 with no
version warning and returns the original font byte-for-byte (one-off check, not part of the test suite because
the package is not a dependency).

Not implemented: **MTX compression** (Compact Table Format + LZCOMP; pptxboss' Rust implementation is a
reasonable porting reference) and **subsetting**. Consequence: fonts are stored whole, the PPTX grows by the
font size (typically 50 KB – 1 MB per face; CJK fonts can be 5–20 MB; the prototype refuses files over
`CONFIG.fontEmbed.maxFontBytes`).

## 4. Licensing: OS/2 `fsType`

| fsType | Meaning (OpenType spec) | PowerPoint | Prototype |
|---|---|---|---|
| `0x0000` Installable | may be embedded, even installed permanently | embeds, recipient can edit | embeds |
| `0x0002` Restricted License | must not be modified, embedded or exchanged without the owner's permission | does not embed ("Some of your fonts can't be saved with the presentation") [MS-cant-save] | **refuses** (`FontEmbedError` code `restricted`) |
| `0x0004` Preview & Print | may be embedded; the document must be opened read-only | embeds; on a machine without the font the file opens read-only ("…contains one or more read-only embedded (restricted) fonts…") [MS-qa-readonly] | embeds with a `preview-print` warning (`allowPreviewPrint: false` → refuses) |
| `0x0008` Editable | may be embedded; documents may be edited | embeds, editable | embeds |
| bit 8 `0x0100` No subsetting | embed the whole font only | — | fine: we never subset |
| bit 9 `0x0200` Bitmap embedding only | outlines must not be embedded | cannot embed outlines | **refuses** (`bitmap-only`) |

* Bits 0–3 are mutually exclusive since OS/2 version 3; older fonts may combine them and then **the least
  restrictive** permission applies [fsType-summary] — `decodeFsType` does that and flags `ambiguous`
  (warning `fstype-unusual`).
* LibreOffice uses the same rule for editing (`fsType == 0 || fsType & 8`) and, for export, refuses fonts with
  bit `0x2` [LO-manager]; libeot's `EOTcanLegallyEdit` is identical [libeot].
* Formats: PowerPoint embeds TrueType and OpenType fonts; "unsupported types of fonts include Adobe PostScript
  Type 1 or Apple Advanced Typography (AAT)" [MS-cant-save]. OpenType with **CFF** outlines (`OTTO`) is
  unclear — reportedly Office's own save-as-PDF never embeds them [moonleo], and whether PowerPoint
  loads a CFF font from `.fntdata` is unverified. The prototype accepts CFF with a `cff-outlines` warning
  (`allowCff: false` → refuses). Collections (TTC), WOFF / WOFF2 and EOT inputs are refused with a hint.

## 5. What other applications do

| Application | Embedded fonts in PPTX |
|---|---|
| PowerPoint for Windows | reads and writes (the reference implementation). |
| PowerPoint for Mac | reads and writes in subscription versions since ~2019 (16.x) [rdpslides]. Older Mac versions ignore them. |
| PowerPoint for the web | not verified here. |
| Keynote | ignores embedded fonts; missing fonts are substituted with a notification [aspose-keynote, apple-discussions]. |
| Google Slides | ignores embedded fonts on import (fonts not available in Google Fonts are substituted) [google-thread]. |
| LibreOffice Impress | **≥ 25.8**: imports (needs libeot, on by default in Linux / macOS / Windows builds [LO-configure]) and exports [LO-25.8]. **< 25.8**: ignores `<p:embeddedFontLst>` (the importer code does not exist on the 25.2 branch [LO-import]; confirmed by the experiment below). |

So embedding only helps recipients who use desktop PowerPoint (and LibreOffice ≥ 25.8). For Keynote /
Google Slides the fonts still have to be installed (or the text rasterized).

## 6. Prototype (`src/fonts/embed.ts`)

Environment-neutral (no DOM, no Node APIs; JSZip only), string-level XML edits (namespace prefixes preserved).

| Function | Purpose |
|---|---|
| `detectFontFormat(bytes)` | `truetype` / `cff` / `ttc` / `woff` / `woff2` / `eot` / `type1` / `unknown` |
| `parseFontInfo(bytes)` | names (IDs 1, 2, 4, 5, 6, 16, 17; Windows en-US preferred, Mac Roman decoded), weight / width class, bold / italic (fsSelection or macStyle), PANOSE, Unicode / code-page ranges, `checkSumAdjustment`, fixed pitch, `embedding` (decoded fsType). Checksums are not verified. |
| `decodeFsType(fsType)` | permission + `noSubsetting`, `bitmapOnly`, `embeddable`, `editable`, `ambiguous`, `reservedBits` |
| `makeFntdata(bytes, info?)` | EOT 2.2, flags 0, as above |
| `readEotHeader`, `extractFontFromFntdata` | read EOT 1.0 / 2.1 / 2.2 back; XOR handled; MTX refused (`compressed`) |
| `planFontEmbedding(fonts, options)` | validation + grouping by face (case-insensitive) and slot; throws `FontEmbedError` (`restricted`, `bitmap-only`, `preview-print`, `cff-not-allowed`, `unsupported-format`, `malformed`, `too-large`, `empty-face`, `duplicate-slot`), returns warnings (`preview-print`, `cff-outlines`, `face-mismatch`, `style-mismatch`, `fstype-unusual`) |
| `embedFontsIntoPptx(pptx, fonts, options)` | `fonts: {face, bold, italic, bytes}[]` → new PPTX bytes. Finds the presentation part via `_rels/.rels`; unique part names and `rId`s; one part per distinct file; `<Default>` (or `<Override>`s when `fntdata` already maps to another type); appends to an existing list, refuses a face that is already embedded (`already-embedded`); declares `xmlns:r` if missing. |

Tunables: `CONFIG.fontEmbed` (`eotCharset`, `allowPreviewPrint`, `allowCff`, `maxFontBytes`, `zipCompressionLevel`).

Tests (`tests/fonts/`): synthetic sfnt builder + real system fonts (Liberation Sans RIBBI set, an OTF, a TTC when
present); fsType table; a restricted copy of a real font (only the two fsType bytes patched — checksums left
stale on purpose, the parser must not depend on them); EOT byte layout at fixed offsets and round trip; package
structure after embedding (well-formed XML, relationships, content types, `<p:presentation>` child order
unchanged except for the inserted list, slot order, dedup, merge with an existing list, `validatePackage` of a
real `buildPptx` output); unusual XML (default namespace, `>` in attribute values, nested `p:extLst`,
self-closing list).

Manual-test helper: `npx tsx tests/fonts/embed-cli.ts --out probe.pptx --face "…" --regular font.ttf [--bold …]
[--italic …] [--bold-italic …] [--rename FROM=TO] [--in deck.pptx]` (see `docs/MANUAL-CHECKS.md`, stage 4).

## 7. End-to-end experiment with LibreOffice (recorded 2026-09-27)

`tests/fonts/libreoffice-embed.test.ts`: Liberation Sans Regular is renamed to **"FdEmbProbe Sans"** (same-length
edit of the name table, so the family is certainly not installed), a pptxgenjs slide sets its text in that face,
the font is embedded with `embedFontsIntoPptx`, LibreOffice converts to PDF, `pdffonts` lists the fonts used.

| Run (LibreOffice 24.2.7.2, Linux) | Font in the PDF |
|---|---|
| font installed via a private `FONTCONFIG_FILE` (control) | `FdEmbProbeSans` — the renamed font works and is detectable |
| font only embedded in the PPTX | `DejaVuSans` — **embedded font not used** (fallback) |

The package opened without errors (one page). The result is expected: LibreOffice < 25.8 has no PPTX
embedded-font import. **It says nothing about PowerPoint** and does not validate the uncompressed EOT against a
real consumer; the test asserts "used" automatically when run with LibreOffice ≥ 25.8, which would be the first
real consumer check (LibreOffice 25.8 could not be installed in this environment: no network access to its
download mirrors).

## 8. Open questions

1. **Does PowerPoint (Windows / Mac) load an uncompressed EOT (flags 0)?** LibreOffice ≥ 25.8 writes exactly this
   for PPTX interop, which suggests yes, but it is unverified. Manual test: `docs/MANUAL-CHECKS.md`, stage 4.
   If PowerPoint rejects it (repair dialog, or text falls back) → implement MTX compression.
2. Does PowerPoint match the embedded font by `<p:font typeface>` or by the font's own name ID 1 when they differ?
   (The prototype warns on mismatch; test with an override that renames a face.)
3. CFF-flavored OTF: loaded by PowerPoint or silently ignored?
4. `saveSubsetFonts="1"` (pptxgenjs default): PowerPoint subsets on the next save — fine for viewing, but a
   recipient without the font can then only type the characters already used. Consider writing `"0"` when
   embedding is enabled.

## 9. Recommendation

Wire it into the UI only after question 1 is answered on real PowerPoint:

* "Font mapping" panel: a drop zone per row (or one for the whole deck, auto-matched by name ID 1 = face and
  bold / italic flags), showing the licence status (installable / editable / preview & print / restricted);
* an opt-in "Embed fonts (experimental)" switch; report entries for embedded / refused fonts; the report's
  "fonts must be installed" warning stays for Keynote / Google Slides recipients;
* call `embedFontsIntoPptx` after `buildPptx` in `ui/exporter.ts` (needs the font bytes to live in UI state; the
  main thread is not involved).

## Sources

Read directly (source code / schema data):

* [POI-info] Apache POI `XSLFFontInfo.java` — https://github.com/apache/poi/blob/trunk/poi-ooxml/src/main/java/org/apache/poi/xslf/usermodel/XSLFFontInfo.java
* [POI-header] Apache POI `FontHeader.java` — https://github.com/apache/poi/blob/trunk/poi/src/main/java/org/apache/poi/common/usermodel/fonts/FontHeader.java
* [POI-rel] Apache POI `XSLFRelation.java` (`FONT`: `application/x-fontdata`, `…/relationships/font`, `/ppt/fonts/font#.fntdata`) — https://github.com/apache/poi/blob/trunk/poi-ooxml/src/main/java/org/apache/poi/xslf/usermodel/XSLFRelation.java
* [LO-export] LibreOffice `sd/source/filter/eppt/pptx-epptooxml.cxx` (`WriteEmbeddedFontList`) — https://github.com/LibreOffice/core/blob/master/sd/source/filter/eppt/pptx-epptooxml.cxx
* [LO-eot] LibreOffice `vcl/source/font/EOTConverter.cxx` — https://github.com/LibreOffice/core/blob/master/vcl/source/font/EOTConverter.cxx
* [LO-import] LibreOffice `oox/source/ppt/EmbeddedFontListContext.cxx` (present on `libreoffice-25-8`, absent on `libreoffice-25-2` and `libreoffice-24-2`) — https://github.com/LibreOffice/core/blob/master/oox/source/ppt/EmbeddedFontListContext.cxx
* [LO-manager] LibreOffice `vcl/source/gdi/embeddedfontsmanager.cxx` (`addEmbeddedFont`, `sufficientTTFRights`) — https://github.com/LibreOffice/core/blob/master/vcl/source/gdi/embeddedfontsmanager.cxx
* [LO-configure] LibreOffice `configure.ac` (`--enable-eot` default on Linux / macOS / Windows) — https://github.com/LibreOffice/core/blob/master/configure.ac
* [libeot] libeot (`src/EOT.c`, `src/flags.h`, `src/writeFontFile.c`) — https://github.com/umanwizard/libeot
* [pptxboss-src] pptxboss `crates/pptxboss-write/src/fonts.rs` — https://github.com/4thel00z/pptxboss/blob/main/crates/pptxboss-write/src/fonts.rs
* [pptxboss-pr] pptxboss PR #14 "embed font files in the deck" — https://github.com/4thel00z/pptxboss/pull/14
* [mtx-decompressor] TypeScript libeot port (`src/eot.ts`) — https://github.com/ChristopherVR/mtx-decompressor
* [OXSDK] Open XML SDK schema data, `CT_Presentation` / `CT_EmbeddedFontListEntry` — https://github.com/dotnet/Open-XML-SDK/blob/main/data/schemas/schemas_openxmlformats_org_presentationml_2006_main.json
* [pandoc-11492] pandoc: embedded fonts without the `fntdata` content type produce a corrupt PPTX — https://github.com/jgm/pandoc/issues/11492
* PptxGenJS issue #176 "Embedding fonts" (XML example) — https://github.com/gitbrent/PptxGenJS/issues/176

Known from search-result summaries only (the pages themselves were not reachable from this environment):

* [MS-OI29500] Part 1 §15.2.13 Font Part ("PowerPoint stores TrueType and OpenType fonts in parts of the application/x-fontdata content type") — https://learn.microsoft.com/en-us/openspecs/office_standards/ms-oi29500/ea097c57-5794-4624-b08e-017b47051b1d
* [MS-OE376] Part 4 §4.3.1.9 embeddedFontLst — https://learn.microsoft.com/en-us/openspecs/office_standards/ms-oe376/e3870782-1f40-4ef1-a3a8-01ee13661283
* ECMA-376 (`embeddedFontLst`, `embeddedFont`, `presentation`; Font Part §15.2.13) — https://ecma-international.org/publications-and-standards/standards/ecma-376/
* W3C Member Submission "Embedded OpenType (EOT) File Format" — https://www.w3.org/Submission/EOT/ (layout confirmed through [libeot], [LO-eot], [pptxboss-src])
* [fsType-summary] OpenType OS/2 `fsType` (least restrictive bit wins for old fonts) — https://learn.microsoft.com/en-us/typography/opentype/spec/os2#fstype
* [MS-cant-save] "Some of your fonts can't be saved with the presentation" — https://support.microsoft.com/en-us/powerpoint/some-of-your-fonts-can-t-be-saved-with-the-presentation
* [MS-qa-readonly] Microsoft Q&A "Restricted font embedded error" — https://learn.microsoft.com/en-us/answers/questions/5197751/restricted-font-embedded-error
* [moonleo] "Workarounds for embedding PostScript fonts" — https://www.moonleo.com/articles/workarounds-embedding-postscript-fonts/
* [rdpslides] PPT FAQ "Embedding fonts" (Mac PowerPoint 16.x) — https://www.rdpslides.com/pptfaq/FAQ00076_Embedding_fonts.htm
* [aspose-keynote] "Font embedding in Keynote" — https://blog.aspose.app/font-embedding-in-keynote/ ; [apple-discussions] https://discussions.apple.com/thread/2805114
* [google-thread] "Why won't my embedded fonts show up when I upload a PPT…" — https://support.google.com/docs/thread/11140443
* [LO-25.8] LibreOffice 25.8 release notes (PPTX embedded fonts import / export) — https://whatsnew.libreoffice.org/25.8/
