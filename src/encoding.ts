// Byte encodings, defined once (audit 2, F22 and F23).
//
// Before this module there were three base64url encoders and two hex encoders
// across src/github.ts and src/routes.ts, all written from the same
// four-line recipe. Duplicated crypto-adjacent helpers are not a tidiness problem:
// they drift, and the copy nobody looked at is the one that mishandles the padding
// or the high byte. One definition, one place to fix.

export function bytesToHex(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return [...view].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function binaryFromBytes(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return binary;
}

export function b64urlFromBytes(bytes: Uint8Array): string {
  return btoa(binaryFromBytes(bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64urlEncode(text: string): string {
  return b64urlFromBytes(new TextEncoder().encode(text));
}

export function b64urlDecode(encoded: string): string {
  const b64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
  return new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
}

// Plain base64, not url-safe: this is GitHub's contents API encoding.
export function base64Encode(text: string): string {
  return btoa(binaryFromBytes(new TextEncoder().encode(text)));
}

// The whitespace strip is load-bearing: GitHub returns base64 wrapped across
// lines, and atob rejects it.
export function base64Decode(b64: string): string {
  return new TextDecoder().decode(Uint8Array.from(atob(b64.replace(/\s+/g, "")), (c) => c.charCodeAt(0)));
}
