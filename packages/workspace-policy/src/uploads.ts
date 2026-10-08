import { createHash } from 'node:crypto';

export interface UploadLimits {
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
}

export const DEFAULT_UPLOAD_LIMITS: UploadLimits = { maxFiles: 5, maxFileBytes: 512 * 1024, maxTotalBytes: 1024 * 1024 };

export type SupportedMediaType = 'text/plain' | 'text/markdown' | 'application/json';

export interface ValidatedUpload {
  displayName: string;
  mediaType: SupportedMediaType;
  text: string;
  bytes: Buffer;
  sizeBytes: number;
  sha256: string;
}

export class UploadRejected extends Error {
  constructor(
    message: string,
    readonly code: 'too_many' | 'too_large' | 'unsupported' | 'invalid_content',
  ) {
    super(message);
    this.name = 'UploadRejected';
  }
}

const EXTENSIONS: Record<string, SupportedMediaType> = {
  '.txt': 'text/plain',
  '.text': 'text/plain',
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.json': 'application/json',
};

/** Magic numbers for archives/executables we refuse even if renamed to .txt. */
const REFUSED_SIGNATURES: Array<[string, number[]]> = [
  ['zip archive', [0x50, 0x4b, 0x03, 0x04]],
  ['gzip archive', [0x1f, 0x8b]],
  ['7z archive', [0x37, 0x7a, 0xbc, 0xaf]],
  ['rar archive', [0x52, 0x61, 0x72, 0x21]],
  ['ELF executable', [0x7f, 0x45, 0x4c, 0x46]],
  ['Mach-O executable', [0xcf, 0xfa, 0xed, 0xfe]],
  ['PDF', [0x25, 0x50, 0x44, 0x46]],
];

/** Display-only name: strip any directory parts and control characters. Never used as a path. */
export function sanitizeDisplayName(name: string): string {
  const base = name.replace(/\\/g, '/').split('/').pop() ?? '';
  // eslint-disable-next-line no-control-regex
  const clean = base.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 120);
  return clean.length > 0 ? clean : 'untitled.txt';
}

function extensionOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i >= 0 ? name.slice(i).toLowerCase() : '';
}

const utf8 = new TextDecoder('utf-8', { fatal: true });

/** Validate one file: allowed extension, real text content, parseable JSON for .json. */
export function validateOne(name: string, bytes: Buffer, limits: UploadLimits = DEFAULT_UPLOAD_LIMITS): ValidatedUpload {
  const displayName = sanitizeDisplayName(name);
  const mediaType = EXTENSIONS[extensionOf(displayName)];
  if (!mediaType) throw new UploadRejected(`Unsupported file type for "${displayName}". Allowed: .txt, .md, .json`, 'unsupported');
  if (bytes.length > limits.maxFileBytes) {
    throw new UploadRejected(`"${displayName}" exceeds ${limits.maxFileBytes} bytes`, 'too_large');
  }
  for (const [label, sig] of REFUSED_SIGNATURES) {
    if (sig.every((b, i) => bytes[i] === b)) throw new UploadRejected(`"${displayName}" looks like a ${label}; refused`, 'invalid_content');
  }
  if (bytes.includes(0)) throw new UploadRejected(`"${displayName}" contains binary data`, 'invalid_content');
  let text: string;
  try {
    text = utf8.decode(bytes);
  } catch {
    throw new UploadRejected(`"${displayName}" is not valid UTF-8 text`, 'invalid_content');
  }
  if (mediaType === 'application/json') {
    try {
      JSON.parse(text);
    } catch {
      throw new UploadRejected(`"${displayName}" is not valid JSON`, 'invalid_content');
    }
  }
  return {
    displayName,
    mediaType,
    text,
    bytes,
    sizeBytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

export function validateUploads(
  files: ReadonlyArray<{ name: string; bytes: Buffer }>,
  limits: UploadLimits = DEFAULT_UPLOAD_LIMITS,
): ValidatedUpload[] {
  if (files.length > limits.maxFiles) throw new UploadRejected(`At most ${limits.maxFiles} files per request`, 'too_many');
  const total = files.reduce((n, f) => n + f.bytes.length, 0);
  if (total > limits.maxTotalBytes) throw new UploadRejected(`Total upload exceeds ${limits.maxTotalBytes} bytes`, 'too_large');
  return files.map((f) => validateOne(f.name, f.bytes, limits));
}

/** Strict base64 decode (rejects whitespace tricks and non-alphabet characters). */
export function decodeBase64Strict(b64: string): Buffer {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64) || b64.length % 4 !== 0) {
    throw new UploadRejected('File content is not valid base64', 'invalid_content');
  }
  return Buffer.from(b64, 'base64');
}
