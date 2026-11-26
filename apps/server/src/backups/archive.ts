import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  readlink,
  rm,
  statfs,
  symlink,
} from "node:fs/promises";
import { dirname, join, posix, resolve } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip } from "node:zlib";
import { z } from "zod";

export const BACKUP_DIRECTORY = ".nimbot-backups";
export const DEFAULT_BACKUP_MAX_BYTES = 10 * 1024 ** 3;
const MAX_MANIFEST_BYTES = 16 * 1024 ** 2;
const MAX_ENTRIES = 100_000;
// Match the Agent Host layout, including the installation's provider management Host.
const excludedRuntimeDirectory =
  /^(?:agents\/[a-z0-9][a-z0-9-]{0,47}|ai-providers\/agents\/management)\/(?:tmp|engine\/cache)$/;
const entrySchema = z
  .object({
    path: z.string().min(1).max(4096),
    type: z.enum(["file", "directory", "symlink"]),
    mode: z.number().int().min(0).max(0o777),
    size: z.number().int().nonnegative().safe(),
    sha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    link: z.string().max(4096).optional(),
  })
  .strict();
const manifestSchema = z
  .object({
    formatVersion: z.literal(1),
    buildId: z.string().min(1).max(256),
    createdAt: z.iso.datetime(),
    files: z.array(entrySchema).max(MAX_ENTRIES),
  })
  .strict();
export type BackupManifest = z.infer<typeof manifestSchema>;
type BackupEntry = BackupManifest["files"][number];

function validPath(path: string): boolean {
  return (
    !path.includes("\0") &&
    !path.includes("\\") &&
    !posix.isAbsolute(path) &&
    path === posix.normalize(path) &&
    !path.split("/").some((part) => part === "." || part === ".." || !part) &&
    path.split("/")[0] !== BACKUP_DIRECTORY
  );
}

export async function requireBackupSpace(
  directory: string,
  bytes: number,
): Promise<void> {
  const space = await statfs(directory);
  if (space.bavail * space.bsize < bytes + 16 * 1024 ** 2)
    throw new Error("Insufficient disk space for backup operation.");
}

async function inventory(
  directory: string,
  maxBytes: number,
): Promise<BackupEntry[]> {
  const files: BackupEntry[] = [];
  let total = 0;
  async function visit(parent: string) {
    for (const name of (await readdir(join(directory, parent))).sort()) {
      if (!parent && name === BACKUP_DIRECTORY) continue;
      const path = parent ? `${parent}/${name}` : name;
      if (!validPath(path)) throw new Error("Unsupported backup file path.");
      const absolute = join(directory, path);
      const info = await lstat(absolute);
      if (files.length >= MAX_ENTRIES)
        throw new Error("Too many backup entries.");
      const base = { path, mode: info.mode & 0o777, size: 0 };
      if (info.isSymbolicLink()) {
        const link = await readlink(absolute);
        if (Buffer.byteLength(link) > 4096 || link.includes("\0"))
          throw new Error("Unsupported symbolic link.");
        files.push({ ...base, type: "symlink", link });
      } else if (info.isDirectory()) {
        files.push({ ...base, type: "directory" });
        // Keep the directory and its mode, while omitting disposable runtime contents.
        if (!excludedRuntimeDirectory.test(path)) await visit(path);
      } else if (info.isFile()) {
        total += info.size;
        if (total > maxBytes)
          throw new Error("Backup exceeds the configured size limit.");
        const hash = createHash("sha256");
        for await (const chunk of createReadStream(absolute))
          hash.update(chunk);
        files.push({
          ...base,
          type: "file",
          size: info.size,
          sha256: hash.digest("hex"),
        });
      } else throw new Error("Backup contains an unsupported special file.");
    }
  }
  await visit("");
  return files;
}

function octal(buffer: Buffer, offset: number, length: number, value: number) {
  const text = value.toString(8).padStart(length - 1, "0");
  if (text.length >= length)
    throw new Error("Backup entry exceeds tar format limits.");
  buffer.write(`${text}\0`, offset, length, "ascii");
}
function header(
  name: string,
  type: string,
  size: number,
  mode: number,
  link = "",
): Buffer {
  const block = Buffer.alloc(512);
  block.write(name, 0, 100, "utf8");
  octal(block, 100, 8, mode);
  octal(block, 108, 8, 0);
  octal(block, 116, 8, 0);
  octal(block, 124, 12, size);
  octal(block, 136, 12, 0);
  block.fill(32, 148, 156);
  block.write(type, 156, 1, "ascii");
  block.write(link, 157, 100, "utf8");
  block.write("ustar\0", 257, 6, "ascii");
  block.write("00", 263, 2, "ascii");
  octal(
    block,
    148,
    8,
    block.reduce((sum, byte) => sum + byte, 0),
  );
  return block;
}
function paxLine(key: string, value: string): string {
  const body = ` ${key}=${value}\n`;
  let length = Buffer.byteLength(body) + 1;
  while (String(length).length + Buffer.byteLength(body) !== length)
    length = String(length).length + Buffer.byteLength(body);
  return `${length}${body}`;
}
function padding(size: number): Buffer {
  return Buffer.alloc((512 - (size % 512)) % 512);
}

export async function createArchive(
  stateDir: string,
  outputPath: string,
  buildId: string,
  maxBytes: number,
): Promise<BackupManifest> {
  const manifest: BackupManifest = {
    formatVersion: 1,
    buildId,
    createdAt: new Date().toISOString(),
    files: await inventory(stateDir, maxBytes),
  };
  const metadata = Buffer.from(JSON.stringify(manifest));
  if (metadata.length > MAX_MANIFEST_BYTES)
    throw new Error("Backup manifest is too large.");
  await mkdir(dirname(outputPath), { recursive: true, mode: 0o700 });
  await requireBackupSpace(
    dirname(outputPath),
    manifest.files.reduce(
      (sum, file) => sum + file.size,
      metadata.length + manifest.files.length * 2048,
    ),
  );
  async function* blocks() {
    yield header("manifest.json", "0", metadata.length, 0o600);
    yield metadata;
    yield padding(metadata.length);
    for (const entry of manifest.files) {
      const name = `data/${entry.path}`;
      const pax = Buffer.from(
        paxLine("path", name) +
          (entry.link ? paxLine("linkpath", entry.link) : "") +
          (entry.size >= 0o77777777777
            ? paxLine("size", String(entry.size))
            : ""),
      );
      yield header("PaxHeader", "x", pax.length, 0o600);
      yield pax;
      yield padding(pax.length);
      yield header(
        "entry",
        entry.type === "directory" ? "5" : entry.type === "symlink" ? "2" : "0",
        entry.size >= 0o77777777777 ? 0 : entry.size,
        entry.mode,
      );
      if (entry.type === "file") {
        const hash = createHash("sha256");
        let bytes = 0;
        for await (const chunk of createReadStream(
          join(stateDir, entry.path),
        )) {
          bytes += chunk.length;
          if (bytes > entry.size)
            throw new Error("State changed while creating backup.");
          hash.update(chunk);
          yield chunk;
        }
        if (bytes !== entry.size || hash.digest("hex") !== entry.sha256)
          throw new Error("State changed while creating backup.");
        yield padding(entry.size);
      }
    }
    yield Buffer.alloc(1024);
  }
  const output = await open(outputPath, "wx", 0o600);
  try {
    await pipeline(
      Readable.from(blocks()),
      createGzip(),
      new ByteLimit(maxBytes),
      createWriteStream(outputPath, { fd: output.fd, autoClose: false }),
    );
    await output.sync();
  } catch (error) {
    await output.close();
    await rm(outputPath, { force: true });
    throw error;
  }
  await output.close();
  return manifest;
}

class ByteLimit extends Transform {
  private bytes = 0;
  constructor(private readonly maximum: number) {
    super();
  }
  _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null, data?: Buffer) => void,
  ) {
    this.bytes += chunk.length;
    if (this.bytes > this.maximum)
      callback(new Error("Backup exceeds the configured size limit."));
    else callback(null, chunk);
  }
}

class TarReader {
  private iterator: AsyncIterator<Buffer>;
  private pending: Buffer = Buffer.alloc(0);
  constructor(stream: Readable) {
    this.iterator = stream[Symbol.asyncIterator]();
  }
  async read(size: number): Promise<Buffer> {
    const chunks: Buffer[] = [];
    let remaining = size;
    while (remaining) {
      if (!this.pending.length) {
        const item = await this.iterator.next();
        if (item.done) throw new Error("Truncated backup archive.");
        this.pending = item.value;
      }
      const amount = Math.min(remaining, this.pending.length);
      chunks.push(this.pending.subarray(0, amount));
      this.pending = this.pending.subarray(amount);
      remaining -= amount;
    }
    return Buffer.concat(chunks, size);
  }
  async finish(): Promise<void> {
    if (this.pending.some((byte) => byte !== 0))
      throw new Error("Unexpected trailing archive data.");
    for (;;) {
      const item = await this.iterator.next();
      if (item.done) return;
      if (item.value.some((byte) => byte !== 0))
        throw new Error("Unexpected trailing archive data.");
    }
  }
}
function field(block: Buffer, offset: number, length: number): string {
  return block
    .subarray(offset, offset + length)
    .toString("utf8")
    .replace(/\0.*$/s, "");
}
function numberField(block: Buffer, offset: number, length: number): number {
  const value = field(block, offset, length).trim();
  if (!/^[0-7]+$/.test(value)) throw new Error("Invalid tar numeric field.");
  const parsed = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(parsed))
    throw new Error("Invalid tar numeric field.");
  return parsed;
}
function parseHeader(block: Buffer) {
  const checksum = numberField(block, 148, 8);
  const computed = block.reduce(
    (sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte),
    0,
  );
  if (checksum !== computed || field(block, 257, 6) !== "ustar")
    throw new Error("Invalid tar header.");
  return {
    name: field(block, 0, 100),
    type: field(block, 156, 1) || "0",
    size: numberField(block, 124, 12),
    mode: numberField(block, 100, 8),
    link: field(block, 157, 100),
    prefix: field(block, 345, 155),
  };
}
function parsePax(data: Buffer): Record<string, string> {
  const values: Record<string, string> = {};
  let position = 0;
  while (position < data.length) {
    const separator = data.indexOf(32, position);
    if (separator < 0) throw new Error("Invalid PAX header.");
    const lengthText = data.subarray(position, separator).toString("ascii");
    const length = Number(lengthText);
    if (
      !/^\d+$/.test(lengthText) ||
      !Number.isSafeInteger(length) ||
      length <= separator - position + 1 ||
      position + length > data.length ||
      data[position + length - 1] !== 10
    )
      throw new Error("Invalid PAX header.");
    const record = data
      .subarray(separator + 1, position + length - 1)
      .toString("utf8");
    const equals = record.indexOf("=");
    const key = record.slice(0, equals);
    if (
      !["path", "linkpath", "size"].includes(key) ||
      Object.hasOwn(values, key)
    )
      throw new Error("Unsupported PAX field.");
    values[key] = record.slice(equals + 1);
    position += length;
  }
  return values;
}

export async function validateArchive(
  archivePath: string,
  stagingDir: string,
  buildId: string,
  maxBytes: number,
): Promise<BackupManifest> {
  // Staging must be a fresh directory, so no pre-existing symlink can redirect writes.
  await mkdir(stagingDir, { mode: 0o700 });
  const input = createReadStream(archivePath);
  const gunzip = createGunzip();
  const limited = new ByteLimit(
    maxBytes + MAX_MANIFEST_BYTES + MAX_ENTRIES * 12288,
  );
  const pumping = pipeline(input, new ByteLimit(maxBytes), gunzip, limited);
  void pumping.catch(() => {});
  const reader = new TarReader(limited);
  try {
    const first = parseHeader(await reader.read(512));
    if (
      first.name !== "manifest.json" ||
      first.prefix ||
      first.type !== "0" ||
      first.size > MAX_MANIFEST_BYTES
    )
      throw new Error("Backup manifest is missing or too large.");
    const manifest = manifestSchema.parse(
      JSON.parse((await reader.read(first.size)).toString("utf8")),
    );
    await reader.read(padding(first.size).length);
    if (manifest.buildId !== buildId)
      throw new Error("Backup requires the same Nimbot build.");
    const entries = new Map<string, BackupEntry>();
    let total = 0;
    for (const entry of manifest.files) {
      if (!validPath(entry.path) || entries.has(entry.path))
        throw new Error("Invalid or duplicate backup path.");
      const parent = posix.dirname(entry.path);
      if (parent !== "." && entries.get(parent)?.type !== "directory")
        throw new Error("Backup parent directory is missing or unsafe.");
      if (entry.type === "file" && (!entry.sha256 || entry.link !== undefined))
        throw new Error("Invalid backup file metadata.");
      if (
        entry.type !== "file" &&
        (entry.size !== 0 || entry.sha256 !== undefined)
      )
        throw new Error("Invalid backup entry metadata.");
      if (entry.type === "symlink") {
        if (!entry.link || entry.link.includes("\0"))
          throw new Error("Invalid backup symbolic link.");
      } else if (entry.link !== undefined)
        throw new Error("Invalid backup entry metadata.");
      total += entry.size;
      if (total > maxBytes)
        throw new Error("Backup exceeds the configured size limit.");
      entries.set(entry.path, entry);
    }
    await requireBackupSpace(stagingDir, total);
    const dataDir = join(stagingDir, "data");
    await mkdir(dataDir, { mode: 0o700 });
    for (const entry of manifest.files) {
      let item = parseHeader(await reader.read(512));
      let pax: Record<string, string> = {};
      if (item.type === "x") {
        if (item.size > 16384) throw new Error("PAX header is too large.");
        pax = parsePax(await reader.read(item.size));
        await reader.read(padding(item.size).length);
        item = parseHeader(await reader.read(512));
      }
      if (pax.size !== undefined) {
        if (!/^\d+$/.test(pax.size) || !Number.isSafeInteger(Number(pax.size)))
          throw new Error("Invalid PAX size.");
        item.size = Number(pax.size);
      }
      const name =
        pax.path ?? (item.prefix ? `${item.prefix}/${item.name}` : item.name);
      const link = pax.linkpath ?? item.link;
      const type =
        entry.type === "file" ? "0" : entry.type === "directory" ? "5" : "2";
      if (
        name !== `data/${entry.path}` ||
        item.type !== type ||
        item.size !== entry.size ||
        item.mode !== entry.mode ||
        link !== (entry.link ?? "")
      )
        throw new Error("Archive does not match its manifest.");
      const target = resolve(dataDir, entry.path);
      if (entry.type === "directory") await mkdir(target, { mode: 0o700 });
      else if (entry.type === "symlink") await symlink(entry.link!, target);
      else {
        const output = await open(target, "wx", 0o600);
        const hash = createHash("sha256");
        try {
          let remaining = entry.size;
          while (remaining) {
            const chunk = await reader.read(Math.min(remaining, 64 * 1024));
            hash.update(chunk);
            await output.writeFile(chunk);
            remaining -= chunk.length;
          }
          await output.chmod(entry.mode);
          await output.sync();
        } finally {
          await output.close();
        }
        if (hash.digest("hex") !== entry.sha256)
          throw new Error("Backup file checksum mismatch.");
        await reader.read(padding(entry.size).length);
      }
    }
    if ((await reader.read(1024)).some((byte) => byte !== 0))
      throw new Error("Unexpected archive entries.");
    await reader.finish();
    await pumping;
    for (const entry of [...manifest.files].reverse()) {
      if (entry.type !== "directory") continue;
      const directory = await open(join(dataDir, entry.path), "r");
      try {
        await directory.chmod(entry.mode);
        await directory.sync();
      } finally {
        await directory.close();
      }
    }
    const dataDirectory = await open(dataDir, "r");
    try {
      await dataDirectory.sync();
    } finally {
      await dataDirectory.close();
    }
    return manifest;
  } catch (error) {
    input.destroy();
    gunzip.destroy();
    limited.destroy();
    await pumping.catch(() => {});
    await rm(stagingDir, { recursive: true, force: true });
    throw error;
  }
}
