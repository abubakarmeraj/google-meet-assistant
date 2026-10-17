import fs from 'fs';
import path from 'path';

interface SecureStorage {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}

/** Dedicated single-key storage; never reads or rewrites the app's credential set. */
export class SearchKeyStore {
  private readonly file: string;
  constructor(rootDir: string, private readonly storage: SecureStorage) {
    this.file = path.join(rootDir, 'search-key.enc');
  }
  read(): string {
    if (!fs.existsSync(this.file)) return '';
    try { return this.storage.decryptString(fs.readFileSync(this.file)); }
    catch { return ''; }
  }
  write(value: string): void {
    if (typeof value !== 'string' || value.length > 512 || /[\r\n\0]/.test(value)) throw new Error('Enter a valid Tavily API key.');
    const key = value.trim();
    if (!key) { if (fs.existsSync(this.file)) fs.unlinkSync(this.file); return; }
    if (!this.storage.isEncryptionAvailable()) throw new Error('Secure key storage is unavailable. Restart the app and try again.');
    const encrypted = this.storage.encryptString(key);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file + '.tmp', encrypted, { mode: 0o600 });
    fs.renameSync(this.file + '.tmp', this.file);
  }
}
