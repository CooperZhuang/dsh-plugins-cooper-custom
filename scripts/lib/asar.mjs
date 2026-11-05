/**
 * Electron asar 读写（Chromium pickle 头）：给补丁脚本一个「解析 → 重建」的最小实现。
 *
 * 磁盘布局：
 *   [u32 4][u32 headerSize]                      <- size pickle，值 = header pickle 总长
 *   [u32 payloadLen][u32 jsonLen][json][pad 到 4] <- header pickle
 *   [file data ...]                               <- 从 8 + headerSize 起，offset 相对这里
 *
 * 每个普通文件条目带 { size, offset, integrity: { algorithm:"SHA256", hash, blockSize, blocks } }；
 * unpacked 条目没有 offset（数据在 app.asar.unpacked 下），symlink 条目只有 { link }。
 */
import { closeSync, openSync, readSync, writeSync } from "node:fs";
import { createHash } from "node:crypto";

const HEADER_PREFIX = 8;

export function readArchive(archivePath) {
  const fd = openSync(archivePath, "r");
  try {
    const head = Buffer.alloc(HEADER_PREFIX);
    readSync(fd, head, 0, HEADER_PREFIX, 0);
    const headerSize = head.readUInt32LE(4);
    const headerBuf = Buffer.alloc(headerSize);
    readSync(fd, headerBuf, 0, headerSize, HEADER_PREFIX);
    const jsonLen = headerBuf.readUInt32LE(4);
    const json = headerBuf.subarray(8, 8 + jsonLen).toString("utf8");
    const header = JSON.parse(json);
    const dataStart = HEADER_PREFIX + headerSize;
    return {
      header,
      headerSize,
      jsonLen,
      dataStart,
      /** 读一个打包文件的内容；目录、unpacked、link 条目返回 null。每次自己开关 fd，用例少。 */
      readFile(entryPath) {
        const node = nodeOf(header, entryPath);
        if (node === null || node.files || node.link || node.unpacked) return null;
        const buf = Buffer.alloc(node.size);
        const handle = openSync(archivePath, "r");
        try {
          readSync(handle, buf, 0, node.size, dataStart + Number(node.offset));
        } finally {
          closeSync(handle);
        }
        return buf;
      },
    };
  } finally {
    closeSync(fd);
  }
}

export function nodeOf(header, entryPath) {
  let node = header;
  for (const part of String(entryPath).split("/").filter(Boolean)) {
    if (!node.files || !node.files[part]) return null;
    node = node.files[part];
  }
  return node;
}

export const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

/** Electron 在 Info.plist 里记的是 header JSON 字符串本身的 SHA256。 */
export const headerJsonHash = (header) => sha256(Buffer.from(JSON.stringify(header), "utf8"));

/** 重算一个文件条目的 integrity 块（单块文件也照原格式写 blocks）。 */
export function refreshIntegrity(header, entryPath, bytes) {
  const node = nodeOf(header, entryPath);
  const blockSize = node.integrity?.blockSize ?? 4 * 1024 * 1024;
  const blocks = [];
  for (let at = 0; at < bytes.length || blocks.length === 0; at += blockSize) {
    blocks.push(sha256(bytes.subarray(at, Math.min(at + blockSize, bytes.length))));
  }
  node.integrity = { algorithm: "SHA256", hash: blocks[0], blockSize, blocks };
  node.size = bytes.length;
}

/**
 * 用 header + edits（Map<路径, Buffer>）重建归档。未改动的文件逐块从原归档搬运，
 * 只重排 offset —— 内容与 integrity 保持原样。
 */
export function rebuildArchive({ sourcePath, destPath, header, edits }) {
  const packed = [];
  const walk = (node, prefix) => {
    for (const [name, child] of Object.entries(node.files ?? {})) {
      const path = prefix === "" ? name : prefix + "/" + name;
      if (child.files) walk(child, path);
      else if (!child.link && !child.unpacked) packed.push([path, child]);
    }
  };
  walk(header, "");
  packed.sort((a, b) => Number(a[1].offset) - Number(b[1].offset));

  // 第一遍：改过的文件重算大小与 integrity，顺便记下旧 offset。
  const oldOffset = new Map();
  for (const [path, child] of packed) {
    const edited = edits?.get(path);
    if (edited !== undefined) {
      child.size = edited.length;
      refreshIntegrity(header, path, edited);
    }
    oldOffset.set(path, Number(child.offset));
  }

  // 第二遍：新 offset 从 0 开始 —— asar 的 offset 相对数据区起点，不是相对文件开头。
  let cursor = 0;
  for (const [, child] of packed) {
    child.offset = String(cursor);
    cursor += child.size;
  }
  const json = Buffer.from(JSON.stringify(header), "utf8");
  const pad = (4 - (json.length % 4)) % 4;
  const payloadLen = 4 + json.length + pad;
  const headerSize = 4 + payloadLen;
  const dataStart = HEADER_PREFIX + headerSize;
  const head = Buffer.alloc(HEADER_PREFIX);
  head.writeUInt32LE(4, 0);
  head.writeUInt32LE(headerSize, 4);
  const headerBuf = Buffer.alloc(headerSize);
  headerBuf.writeUInt32LE(payloadLen, 0);
  headerBuf.writeUInt32LE(json.length, 4);
  json.copy(headerBuf, 8);

  const src = openSync(sourcePath, "r");
  const dest = openSync(destPath, "w");
  let totalSize = dataStart;
  try {
    // 源归档的数据区起点由它自己的 header 决定，别用新归档的。
    const srcHead = Buffer.alloc(HEADER_PREFIX);
    readSync(src, srcHead, 0, HEADER_PREFIX, 0);
    const sourceDataStart = HEADER_PREFIX + srcHead.readUInt32LE(4);
    writeSync(dest, head, 0, head.length);
    writeSync(dest, headerBuf, 0, headerBuf.length);
    for (const [path, child] of packed) {
      const edited = edits?.get(path);
      if (edited !== undefined) {
        writeSync(dest, edited, 0, edited.length);
        totalSize += edited.length;
        continue;
      }
      let left = child.size;
      let at = oldOffset.get(path);
      while (left > 0) {
        const take = Math.min(4 * 1024 * 1024, left);
        const buf = Buffer.alloc(take);
        readSync(src, buf, 0, take, sourceDataStart + at);
        writeSync(dest, buf, 0, take);
        at += take;
        left -= take;
        totalSize += take;
      }
    }
  } finally {
    closeSync(src);
    closeSync(dest);
  }
  return { dataStart: dataStart, totalSize: totalSize, headerSize: headerSize, jsonLen: json.length };
}