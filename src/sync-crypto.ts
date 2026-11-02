// End-to-end encryption. The server sees opaque ids, HLCs, a deleted flag and fixed-bucket ciphertext, nothing else.
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const PAD_BLOCK = 256;
const MAX_PLAIN = 60_000;
// PKCS#8 header of an Ed25519 private key: WebCrypto has no raw seed import.
const ED25519_PKCS8 = Uint8Array.from([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20]);
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export const toB64 = (bytes: Uint8Array): string => {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
};
export const fromB64 = (text: string): Uint8Array<ArrayBuffer> =>
  Uint8Array.from(atob(text.replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0));
const utf8 = (text: string): Uint8Array<ArrayBuffer> => encoder.encode(text) as Uint8Array<ArrayBuffer>;

async function derive(secret: Uint8Array<ArrayBuffer>, label: string, length = 32): Promise<Uint8Array<ArrayBuffer>> {
  const key = await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: utf8(`lehko/v1/${label}`) }, key, length * 8);
  return new Uint8Array(bits);
}

export const randomSecret = (): Uint8Array<ArrayBuffer> => crypto.getRandomValues(new Uint8Array(32));
export const randomId = (): string => toB64(crypto.getRandomValues(new Uint8Array(16)));

function pad(plain: Uint8Array): Uint8Array<ArrayBuffer> {
  if (plain.length > MAX_PLAIN) throw new Error('Запис завеликий');
  const size = Math.ceil((plain.length + 4) / PAD_BLOCK) * PAD_BLOCK;
  const out = new Uint8Array(size);
  new DataView(out.buffer).setUint32(0, plain.length);
  out.set(plain, 4);
  return out;
}
function unpad(data: Uint8Array): Uint8Array {
  const length = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(0);
  if (length + 4 > data.length) throw new Error('Пошкоджений запис');
  return data.subarray(4, 4 + length);
}

async function sealBytes(key: CryptoKey, plain: Uint8Array<ArrayBuffer>, aad: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: utf8(aad) }, key, plain);
  const out = new Uint8Array(12 + cipher.byteLength);
  out.set(iv);
  out.set(new Uint8Array(cipher), 12);
  return toB64(out);
}
async function openBytes(key: CryptoKey, sealed: string, aad: string): Promise<Uint8Array<ArrayBuffer>> {
  const data = fromB64(sealed);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: data.subarray(0, 12), additionalData: utf8(aad) }, key, data.subarray(12));
  return new Uint8Array(plain);
}
const aesKey = (bytes: Uint8Array<ArrayBuffer>): Promise<CryptoKey> => crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);

export interface SealedRecord { id: string; hlc: string; data: string; deleted: boolean; }

export class Vault {
  private constructor(
    private signKey: CryptoKey,
    private publicKey: string,
    private dataKey: CryptoKey,
    private idKey: CryptoKey
  ) {}

  static async open(secret: Uint8Array<ArrayBuffer>): Promise<Vault> {
    if (secret.length !== 32) throw new Error('Некоректний ключ');
    const seed = await derive(secret, 'sign');
    const pkcs8 = new Uint8Array(ED25519_PKCS8.length + seed.length);
    pkcs8.set(ED25519_PKCS8);
    pkcs8.set(seed, ED25519_PKCS8.length);
    const signKey = await crypto.subtle.importKey('pkcs8', pkcs8, 'Ed25519', true, ['sign']);
    const jwk = await crypto.subtle.exportKey('jwk', signKey);
    const signOnly = await crypto.subtle.importKey('pkcs8', pkcs8, 'Ed25519', false, ['sign']);
    const idKey = await crypto.subtle.importKey('raw', await derive(secret, 'id'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return new Vault(signOnly, jwk.x!, await aesKey(await derive(secret, 'data')), idKey);
  }

  // Record ids are keyed hashes, so the server cannot tell a folder from a tab or link them to a device.
  async serverId(logical: string): Promise<string> {
    return toB64(new Uint8Array(await crypto.subtle.sign('HMAC', this.idKey, utf8(logical))).subarray(0, 24));
  }

  async seal(logical: string, hlc: string, value: object | null): Promise<SealedRecord> {
    const id = await this.serverId(logical);
    const deleted = value === null;
    // Tombstones are sealed too: otherwise the server could forge a deletion.
    const plain = pad(utf8(JSON.stringify({ logical, value })));
    return { id, hlc, deleted, data: await sealBytes(this.dataKey, plain, `record|${id}|${hlc}|${deleted}`) };
  }

  // Throws on anything the server altered, including a record moved to another id, HLC or deleted flag.
  async open(record: SealedRecord): Promise<{ logical: string; value: unknown }> {
    const plain = await openBytes(this.dataKey, record.data, `record|${record.id}|${record.hlc}|${record.deleted}`);
    const parsed = JSON.parse(decoder.decode(unpad(plain))) as { logical: string; value: unknown };
    if (await this.serverId(parsed.logical) !== record.id) throw new Error('Чужий запис');
    if ((parsed.value === null) !== record.deleted) throw new Error('Пошкоджений запис');
    return parsed;
  }

  async sign(method: string, path: string, body: string, now: number): Promise<Record<string, string>> {
    const hash = toB64(new Uint8Array(await crypto.subtle.digest('SHA-256', utf8(body))));
    const signature = await crypto.subtle.sign('Ed25519', this.signKey, utf8(`lehko-v1 ${method} ${path} ${now} ${hash}`));
    return { 'X-Lehko-Key': this.publicKey, 'X-Lehko-Time': String(now), 'X-Lehko-Sig': toB64(new Uint8Array(signature)) };
  }
}

// ---- pairing: a 130-bit code from the old device carries the account secret through a one-time mailbox ----
function encodeCode(bytes: Uint8Array): string {
  let bits = 0, value = 0, out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += CROCKFORD[(value >>> (bits - 5)) & 31]; bits -= 5; }
    value &= (1 << bits) - 1;
  }
  if (bits) out += CROCKFORD[(value << (5 - bits)) & 31];
  return out.match(/.{1,5}/g)!.join('-');
}
function decodeCode(code: string): Uint8Array<ArrayBuffer> {
  const clean = code.toUpperCase().replace(/[\s-]/g, '').replaceAll('O', '0').replace(/[IL]/g, '1');
  if (clean.length !== 26) throw new Error('Код має містити 26 символів');
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const digit = CROCKFORD.indexOf(char);
    if (digit < 0) throw new Error('Некоректний код');
    value = (value << 5) | digit; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; value &= (1 << bits) - 1; }
  }
  return Uint8Array.from(out.slice(0, 16));
}

export interface PairChannel { channel: string; key: CryptoKey; }
async function channelOf(codeBytes: Uint8Array<ArrayBuffer>): Promise<PairChannel> {
  return { channel: toB64(await derive(codeBytes, 'pair-channel')), key: await aesKey(await derive(codeBytes, 'pair-key')) };
}
export async function newPairing(): Promise<PairChannel & { code: string }> {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return { code: encodeCode(bytes), ...await channelOf(bytes) };
}
export const pairingFromCode = (code: string): Promise<PairChannel> => channelOf(decodeCode(code));
export const sealPairing = (pair: PairChannel, secret: Uint8Array<ArrayBuffer>): Promise<string> => sealBytes(pair.key, secret, `pair|${pair.channel}`);
export const openPairing = (pair: PairChannel, blob: string): Promise<Uint8Array<ArrayBuffer>> => openBytes(pair.key, blob, `pair|${pair.channel}`);
