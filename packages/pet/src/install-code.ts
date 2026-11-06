/**
 * Install codes: the short string a player copies off their pet's page and
 * pastes into `joygotchi install`.
 *
 * The code carries the pet's on-chain id and nothing else. It is not a secret
 * and not a capability — a pet is an NFT on a public chain, so pretending the
 * code grants access would be theatre. What it does is turn a number into
 * something a person can copy without mistyping, and let the CLI resolve the
 * pet with no server in the middle: decode the id, ask the contract who owns
 * it, fetch the art. No database, no API keys, nothing to run.
 *
 * Crockford base32, because this gets typed by hand and read off screenshots:
 * no I, L, O or U, so there is no 1/l or 0/O to confuse, and decoding accepts
 * either case.
 */

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const PREFIX = 'jg1';
/** Letters Crockford maps onto digits, for someone who typed what they saw. */
const CONFUSABLE: Record<string, string> = { I: '1', L: '1', O: '0', U: 'V' };

export class InvalidInstallCodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidInstallCodeError';
  }
}

/** CRC-32, enough to catch a typo. The on-chain lookup is the real check. */
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function toBase32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function fromBase32(text: string): Uint8Array {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of text) {
    const normalised = CONFUSABLE[char] ?? char;
    const index = ALPHABET.indexOf(normalised);
    if (index === -1) {
      throw new InvalidInstallCodeError(`"${char}" is not part of an install code`);
    }
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

/** The largest pet id a code can carry: four bytes of id. */
export const MAX_PET_ID = 0xffffffff;

/**
 * Scatter the id across all four bytes before encoding it.
 *
 * Without this, every code starts the same: pet 1, 2 and 3 differ only in the
 * last byte, so `jg1_04000001xrxg` and `jg1_04000002qy0g` sit next to each
 * other on screen looking like the same string. A code you cannot tell apart
 * from your neighbour's is a code people paste wrong.
 *
 * A four-round Feistel network over the 32-bit id. Reversible by construction,
 * keyless, and not a secret — the id is public on chain and nothing here is
 * pretending otherwise. It exists so the characters move.
 */
const ROUND_KEYS = [0x9e37, 0x79b9, 0x7f4a, 0x7c15];

function feistelRound(half: number, key: number): number {
  let mixed = (half ^ key) >>> 0;
  mixed = Math.imul(mixed, 0x045d9f3b) >>> 0;
  mixed = ((mixed >>> 7) | (mixed << 25)) >>> 0;
  return mixed & 0xffff;
}

function scatter(value: number): number {
  let left = (value >>> 16) & 0xffff;
  let right = value & 0xffff;
  for (const key of ROUND_KEYS) {
    const next = (left ^ feistelRound(right, key)) & 0xffff;
    left = right;
    right = next;
  }
  return (((left << 16) >>> 0) | right) >>> 0;
}

function unscatter(value: number): number {
  let left = (value >>> 16) & 0xffff;
  let right = value & 0xffff;
  for (let index = ROUND_KEYS.length - 1; index >= 0; index--) {
    const previous = (right ^ feistelRound(left, ROUND_KEYS[index] ?? 0)) & 0xffff;
    right = left;
    left = previous;
  }
  return (((left << 16) >>> 0) | right) >>> 0;
}

/**
 * Build the install code for a pet id.
 *
 * Layout: one version byte, four id bytes big-endian, two checksum bytes.
 * Seven bytes become twelve base32 characters, so every code is the same
 * length however small the id — pet 1 does not get a code that looks broken.
 */
export function encodeInstallCode(petId: number): string {
  if (!Number.isInteger(petId) || petId < 1 || petId > MAX_PET_ID) {
    throw new InvalidInstallCodeError(`${petId} is not a pet id`);
  }

  const scattered = scatter(petId);
  const payload = new Uint8Array(5);
  payload[0] = 1;
  payload[1] = (scattered >>> 24) & 0xff;
  payload[2] = (scattered >>> 16) & 0xff;
  payload[3] = (scattered >>> 8) & 0xff;
  payload[4] = scattered & 0xff;

  const checksum = crc32(payload);
  const framed = new Uint8Array(7);
  framed.set(payload);
  framed[5] = (checksum >>> 8) & 0xff;
  framed[6] = checksum & 0xff;

  return `${PREFIX}_${toBase32(framed).toLowerCase()}`;
}

/** Read a pet id back out of a code, rejecting anything mistyped. */
export function decodeInstallCode(code: string): number {
  const trimmed = code.trim();
  const body = trimmed.toUpperCase().startsWith(`${PREFIX.toUpperCase()}_`)
    ? trimmed.slice(PREFIX.length + 1)
    : trimmed;

  const cleaned = body.replace(/-/g, '').toUpperCase();
  if (cleaned.length !== 12) {
    throw new InvalidInstallCodeError('An install code is 12 characters after the jg1_ prefix');
  }

  const framed = fromBase32(cleaned);
  if (framed.length < 7) {
    throw new InvalidInstallCodeError('That install code is too short to be one');
  }

  const version = framed[0];
  if (version !== 1) {
    throw new InvalidInstallCodeError(
      `This code is version ${version}; update the CLI to install it`
    );
  }

  const payload = framed.subarray(0, 5);
  const checksum = crc32(payload);
  if (framed[5] !== ((checksum >>> 8) & 0xff) || framed[6] !== (checksum & 0xff)) {
    throw new InvalidInstallCodeError('That install code has a typo in it');
  }

  // `<<` works on signed 32-bit integers, so an id with the top bit set comes
  // back negative without the final shift.
  const scattered =
    ((((payload[1] ?? 0) << 24) |
      ((payload[2] ?? 0) << 16) |
      ((payload[3] ?? 0) << 8) |
      (payload[4] ?? 0)) >>>
      0);

  return unscatter(scattered);
}

/** True when `code` is a well-formed install code. For input validation. */
export function isInstallCode(code: string): boolean {
  try {
    decodeInstallCode(code);
    return true;
  } catch {
    return false;
  }
}
