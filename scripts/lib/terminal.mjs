// Terminal-safe rendering for repository-controlled text. Zero dependencies. Node 16+.
//
// Ledger titles, paths, commands, diagnostics, and command output must not be
// able to rewrite terminal history, set a window title, or visually reorder
// text. Every C0/C1 control, soft hyphen, zero-width or bidirectional
// formatting character, and line separator renders as a visible escape.

export const UNSAFE_TERMINAL_RE = /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/;
const UNSAFE_TERMINAL_GLOBAL = new RegExp(UNSAFE_TERMINAL_RE.source, "g");
export const TRUNCATION_MARKER = "...[truncated]";

function visibleEscape(character) {
  const code = character.codePointAt(0);
  const backslash = String.fromCharCode(92);
  return code <= 0xff
    ? backslash + "x" + code.toString(16).padStart(2, "0")
    : backslash + "u" + code.toString(16).padStart(4, "0");
}

// Escape unsafe characters and cap the UTF-8 size of the rendered value. The
// cap applies after escaping, so hostile input cannot amplify output.
export function escapeTerminal(value, maxBytes = Infinity) {
  const text = String(value);
  if (maxBytes === Infinity) return text.replace(UNSAFE_TERMINAL_GLOBAL, visibleEscape);
  const pieces = [];
  const sizes = [];
  let bytes = 0;
  let truncated = false;
  for (const character of text) {
    const piece = UNSAFE_TERMINAL_RE.test(character) ? visibleEscape(character) : character;
    const size = Buffer.byteLength(piece, "utf8");
    if (bytes + size > maxBytes) { truncated = true; break; }
    pieces.push(piece);
    sizes.push(size);
    bytes += size;
  }
  if (!truncated) return pieces.join("");
  const markerBytes = Buffer.byteLength(TRUNCATION_MARKER, "utf8");
  while (pieces.length && bytes + markerBytes > maxBytes) {
    pieces.pop();
    bytes -= sizes.pop();
  }
  return pieces.join("") + TRUNCATION_MARKER;
}

// JSON.stringify already escapes C0 controls but emits bidirectional and
// zero-width characters raw. Escape those too; structural newlines from
// pretty-printing stay, so the result remains valid JSON.
export function terminalSafeJson(value, space) {
  const backslash = String.fromCharCode(92);
  return JSON.stringify(value, null, space).replace(UNSAFE_TERMINAL_GLOBAL,
    (character) => (character === "\n" ? character
      : backslash + "u" + character.codePointAt(0).toString(16).padStart(4, "0")));
}

// Collapse unsafe characters and whitespace for single-line host messages.
export function singleLine(value, max = 500) {
  return String(value).replace(UNSAFE_TERMINAL_GLOBAL, " ").replace(/\s+/g, " ").trim().slice(0, max);
}
