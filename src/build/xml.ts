/**
 * XML string helpers shared by build/ and post/. All OOXML we generate is produced as strings;
 * these helpers are the only place where user text (layer names, run text, font faces, URLs)
 * is made safe for XML.
 *
 * Environment-neutral (no DOM, no Node built-ins).
 */

/**
 * Characters that are not allowed in XML 1.0 documents: C0 controls except TAB / LF / CR,
 * U+FFFE / U+FFFF, and unpaired UTF-16 surrogates.
 */
const INVALID_XML_CHARS =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** Remove characters that cannot appear in an XML 1.0 document at all (not even escaped). */
export function stripInvalidXmlChars(text: string): string {
  return text.replace(INVALID_XML_CHARS, '');
}

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&apos;',
};

/** Escape `& < > " '` (safe for both text content and attribute values) and strip invalid characters. */
export function escapeXml(text: string): string {
  return stripInvalidXmlChars(text).replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

/**
 * Minimal sanitation of a hyperlink target for a relationship `Target` (xsd:anyURI):
 * trims, drops control characters and percent-encodes spaces. Non-ASCII characters are kept (IRI).
 * The result still has to be passed through `escapeXml` when written into an attribute.
 */
export function sanitizeUrl(url: string): string {
  return stripInvalidXmlChars(url)
    .trim()
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .replace(/ /g, '%20');
}
