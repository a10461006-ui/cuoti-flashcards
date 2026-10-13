// 純 JavaScript 的 DEFLATE 解壓縮（RFC 1951），給不支援 DecompressionStream('deflate-raw') 的瀏覽器用
// （Safari 16.3 以前、較舊的 Chrome）。演算法與 zlib 的 puff.c 相同：逐位元讀取、標準 Huffman 解碼。

const LENGTH_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LENGTH_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073,
  4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

function buildTree(lengths, offset, num) {
  const counts = new Uint16Array(16);
  const symbols = new Uint16Array(num);
  for (let i = 0; i < num; i += 1) counts[lengths[offset + i]] += 1;
  counts[0] = 0;
  const offs = new Uint16Array(16);
  for (let i = 1; i < 16; i += 1) offs[i] = offs[i - 1] + counts[i - 1];
  for (let i = 0; i < num; i += 1) {
    const len = lengths[offset + i];
    if (len) { symbols[offs[len]] = i; offs[len] += 1; }
  }
  return { counts, symbols };
}

const FIXED = (() => {
  const lens = new Uint8Array(288 + 30);
  for (let i = 0; i < 144; i += 1) lens[i] = 8;
  for (let i = 144; i < 256; i += 1) lens[i] = 9;
  for (let i = 256; i < 280; i += 1) lens[i] = 7;
  for (let i = 280; i < 288; i += 1) lens[i] = 8;
  for (let i = 288; i < 318; i += 1) lens[i] = 5;
  return { lit: buildTree(lens, 0, 288), dist: buildTree(lens, 288, 30) };
})();

const broken = () => new Error('檔案的壓縮資料有問題，無法讀取');

/** 解壓縮 raw DEFLATE（zip 檔內的資料）；sizeHint 是解壓後的大小（zip 目錄裡有記錄），用來預先配置記憶體 */
export function inflateRawSync(input, sizeHint = 0) {
  let pos = 0;
  let bitBuf = 0;
  let bitCount = 0;
  let out = new Uint8Array(Math.max(1024, sizeHint || input.length * 4));
  let outLen = 0;

  const ensure = (n) => {
    if (outLen + n <= out.length) return;
    const bigger = new Uint8Array(Math.max(out.length * 2, outLen + n));
    bigger.set(out.subarray(0, outLen));
    out = bigger;
  };
  const bit = () => {
    if (!bitCount) {
      if (pos >= input.length) throw broken();
      bitBuf = input[pos];
      pos += 1;
      bitCount = 8;
    }
    const b = bitBuf & 1;
    bitBuf >>>= 1;
    bitCount -= 1;
    return b;
  };
  const bits = (n) => {
    let v = 0;
    for (let i = 0; i < n; i += 1) v |= bit() << i;
    return v;
  };
  const decode = (tree) => {
    let code = 0;
    let first = 0;
    let index = 0;
    for (let len = 1; len < 16; len += 1) {
      code |= bit();
      const count = tree.counts[len];
      if (code - count < first) return tree.symbols[index + (code - first)];
      index += count;
      first = (first + count) << 1;
      code <<= 1;
    }
    throw broken();
  };

  let last = 0;
  do {
    last = bit();
    const type = bits(2);
    if (type === 0) {
      // 不壓縮的區塊：跳到下一個位元組邊界
      bitBuf = 0;
      bitCount = 0;
      if (pos + 4 > input.length) throw broken();
      const len = input[pos] | (input[pos + 1] << 8);
      pos += 4;
      if (pos + len > input.length) throw broken();
      ensure(len);
      out.set(input.subarray(pos, pos + len), outLen);
      outLen += len;
      pos += len;
    } else if (type === 1 || type === 2) {
      let lit = FIXED.lit;
      let dist = FIXED.dist;
      if (type === 2) {
        const hlit = bits(5) + 257;
        const hdist = bits(5) + 1;
        const hclen = bits(4) + 4;
        const cl = new Uint8Array(19);
        for (let i = 0; i < hclen; i += 1) cl[CL_ORDER[i]] = bits(3);
        const clTree = buildTree(cl, 0, 19);
        const lens = new Uint8Array(hlit + hdist);
        for (let i = 0; i < hlit + hdist;) {
          const sym = decode(clTree);
          if (sym < 16) {
            lens[i] = sym;
            i += 1;
          } else {
            let rep;
            let val = 0;
            if (sym === 16) {
              if (!i) throw broken();
              val = lens[i - 1];
              rep = 3 + bits(2);
            } else if (sym === 17) rep = 3 + bits(3);
            else rep = 11 + bits(7);
            if (i + rep > hlit + hdist) throw broken();
            for (; rep > 0; rep -= 1) { lens[i] = val; i += 1; }
          }
        }
        lit = buildTree(lens, 0, hlit);
        dist = buildTree(lens, hlit, hdist);
      }
      for (;;) {
        const sym = decode(lit);
        if (sym < 256) {
          ensure(1);
          out[outLen] = sym;
          outLen += 1;
        } else if (sym === 256) {
          break;
        } else {
          const li = sym - 257;
          if (li >= 29) throw broken();
          const length = LENGTH_BASE[li] + bits(LENGTH_EXTRA[li]);
          const di = decode(dist);
          if (di >= 30) throw broken();
          const distance = DIST_BASE[di] + bits(DIST_EXTRA[di]);
          if (distance > outLen) throw broken();
          ensure(length);
          for (let k = 0; k < length; k += 1) {
            out[outLen] = out[outLen - distance];
            outLen += 1;
          }
        }
      }
    } else {
      throw broken();
    }
  } while (!last);
  return out.subarray(0, outLen);
}
