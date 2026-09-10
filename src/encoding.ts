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

// Plain base64, not url-safe: GitHub's contents API encoding.
export function base64Encode(text: string): string {
  return btoa(binaryFromBytes(new TextEncoder().encode(text)));
}

// GitHub wraps base64 across lines; atob rejects the whitespace.
export function base64Decode(b64: string): string {
  return new TextDecoder().decode(Uint8Array.from(atob(b64.replace(/\s+/g, "")), (c) => c.charCodeAt(0)));
}
