// scripts/generate_icons.js
// Generates valid PNG icon files for PRIVISION (16x16, 48x48, 128x128) using Node.js built-in modules.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function createPNG(size, primaryColor, accentColor) {
  // RGBA buffer: width * height * 4 bytes
  const width = size;
  const height = size;
  const rawData = Buffer.alloc(height * (1 + width * 4)); // 1 filter byte per scanline

  let offset = 0;
  const cx = width / 2;
  const cy = height / 2;
  const radius = width * 0.44;

  for (let y = 0; y < height; y++) {
    rawData[offset++] = 0; // Filter type 0 (None)
    for (let x = 0; x < width; x++) {
      const dx = x - cx;
      const dy = y - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);

      // Check if inside rounded shield/circle
      if (dist <= radius) {
        // Inner core check (shield eye / privacy pupil)
        const innerDist = Math.sqrt(dx * dx + (dy - height * 0.05) * (dy - height * 0.05));
        if (innerDist < radius * 0.35) {
          // Accent eye/shield core (emerald/amber)
          rawData[offset++] = accentColor[0]; // R
          rawData[offset++] = accentColor[1]; // G
          rawData[offset++] = accentColor[2]; // B
          rawData[offset++] = 255;            // A
        } else {
          // Deep privacy blue body
          const gradientRatio = (y / height);
          rawData[offset++] = Math.round(primaryColor[0] * (1 - 0.2 * gradientRatio));
          rawData[offset++] = Math.round(primaryColor[1] * (1 - 0.2 * gradientRatio));
          rawData[offset++] = Math.round(primaryColor[2] * (1 - 0.2 * gradientRatio));
          rawData[offset++] = 255;
        }
      } else {
        // Transparent background
        rawData[offset++] = 0;
        rawData[offset++] = 0;
        rawData[offset++] = 0;
        rawData[offset++] = 0;
      }
    }
  }

  // Compress IDAT payload with zlib deflate
  const compressedIDAT = zlib.deflateSync(rawData);

  // PNG Header
  const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  // IHDR Chunk
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  const ihdrChunk = createChunk('IHDR', ihdr);

  // IDAT Chunk
  const idatChunk = createChunk('IDAT', compressedIDAT);

  // IEND Chunk
  const iendChunk = createChunk('IEND', Buffer.alloc(0));

  return Buffer.concat([pngSignature, ihdrChunk, idatChunk, iendChunk]);
}

function createChunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lengthBuf = Buffer.alloc(4);
  lengthBuf.writeUInt32BE(data.length, 0);

  const crcData = Buffer.concat([typeBuf, data]);
  const crc = crc32(crcData);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc, 0);

  return Buffer.concat([lengthBuf, typeBuf, data, crcBuf]);
}

// CRC32 implementation for standard PNG chunks
function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) {
        c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      }
      table[i] = c;
    }
    crc32.table = table;
  }

  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const iconsDir = path.join(__dirname, '..', 'icons');
if (!fs.existsSync(iconsDir)) {
  fs.mkdirSync(iconsDir, { recursive: true });
}

// Deep Navy Blue #1B3A6B and Emerald Accent #10B981
const primary = [27, 58, 107];
const accent = [16, 185, 129];

[16, 48, 128].forEach(size => {
  const png = createPNG(size, primary, accent);
  const filePath = path.join(iconsDir, `icon-${size}.png`);
  fs.writeFileSync(filePath, png);
  console.log(`Generated ${filePath} (${png.length} bytes)`);
});
