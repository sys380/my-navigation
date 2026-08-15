// ============================================================
//  Cloudflare Pages Function — 自动同步 API
//  GET  /api/data    → 获取数据
//  POST /api/data    → 保存数据 { data }
//  所有设备共享同一份数据，无需同步码
// ============================================================
import { inflateSync, deflateSync } from 'node:zlib';

const KV_KEY = 'nav:shared';

// —— PNG 手动处理(不依赖第三方库, 只需 nodejs_compat 的 zlib) ——
const CRC_TABLE = (() => { const t = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c; } return t; })();
function crc32(buf) { let c = 0xFFFFFFFF; for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
function mkChunk(type, data) { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const t = Buffer.from(type, 'ascii'); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data]))); return Buffer.concat([len, t, data, crc]); }

// 去掉 favicon 的白色背景：从边缘向内的白色连通域设为透明（保留 logo 内部的白）
function stripWhiteBackground(buffer) {
  if (!buffer || buffer.length < 8) return buffer;
  if (!(buffer[0] === 0x89 && buffer[1] === 0x50)) return buffer;
  try {
    // 解析 PNG 块
    let off = 8, w = 0, h = 0, bitDepth = 0, colorType = 0, interlace = 0, idat = [], plte = null, trns = null;
    while (off < buffer.length) {
      const len = buffer.readUInt32BE(off);
      const type = buffer.slice(off + 4, off + 8).toString('ascii');
      const data = buffer.slice(off + 8, off + 8 + len);
      if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); bitDepth = data[8]; colorType = data[9]; interlace = data[12]; }
      else if (type === 'PLTE') plte = data;
      else if (type === 'tRNS') trns = data;
      else if (type === 'IDAT') idat.push(data);
      off += 12 + len;
    }
    if (interlace !== 0 || bitDepth !== 8) return buffer; // 只处理非交错 8 位
    let bpp = 1;
    if (colorType === 6) bpp = 4; else if (colorType === 2) bpp = 3; else if (colorType === 0) bpp = 1; else if (colorType === 4) bpp = 2; else if (colorType === 3) bpp = 1;
    else return buffer;
    // 解压并去掉每行 filter
    const rowSize = w * bpp, raw = inflateSync(Buffer.concat(idat));
    const px = new Uint8Array(w * h * bpp); let prev = Buffer.alloc(rowSize), pos = 0;
    const paeth = (a, b, c) => { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); return pa <= pb && pa <= pc ? a : (pb <= pc ? b : c); };
    for (let y = 0; y < h; y++) {
      const f = raw[pos++]; const line = raw.slice(pos, pos + rowSize); pos += rowSize; const out = Buffer.alloc(rowSize);
      for (let x = 0; x < rowSize; x++) {
        const a = x >= bpp ? line[x - bpp] : 0, b = prev[x], c = x >= bpp ? prev[x - bpp] : 0; let v = line[x];
        if (f === 1) v = (v + a) & 0xFF; else if (f === 2) v = (v + b) & 0xFF; else if (f === 3) v = (v + ((a + b) >> 1)) & 0xFF; else if (f === 4) v = (v + paeth(a, b, c)) & 0xFF;
        out[x] = v;
      }
      px.set(out, y * rowSize); prev = out;
    }
    // 转成 RGBA
    const rgba = new Uint8Array(w * h * 4); const T = 240;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const si = y * rowSize + x * bpp, di = (y * w + x) * 4;
      if (colorType === 6) { rgba[di] = px[si]; rgba[di + 1] = px[si + 1]; rgba[di + 2] = px[si + 2]; rgba[di + 3] = px[si + 3]; }
      else if (colorType === 2) { rgba[di] = px[si]; rgba[di + 1] = px[si + 1]; rgba[di + 2] = px[si + 2]; rgba[di + 3] = 255; }
      else if (colorType === 0) { rgba[di] = px[si]; rgba[di + 1] = px[si]; rgba[di + 2] = px[si]; rgba[di + 3] = 255; }
      else if (colorType === 4) { rgba[di] = px[si]; rgba[di + 1] = px[si]; rgba[di + 2] = px[si]; rgba[di + 3] = px[si + 1]; }
      else if (colorType === 3) { const idx = px[si]; rgba[di] = plte ? plte[idx * 3] : 0; rgba[di + 1] = plte ? plte[idx * 3 + 1] : 0; rgba[di + 2] = plte ? plte[idx * 3 + 2] : 0; rgba[di + 3] = trns && idx < trns.length ? trns[idx] : 255; }
    }
    // 从边缘泛洪：近白像素变透明
    const visited = new Uint8Array(w * h), queue = [];
    const push = (x, y) => { if (x < 0 || y < 0 || x >= w || y >= h) return; const i = y * w + x; if (visited[i]) return; visited[i] = 1; queue.push(i); };
    for (let x = 0; x < w; x++) { push(x, 0); push(x, h - 1); } for (let y = 0; y < h; y++) { push(0, y); push(w - 1, y); }
    while (queue.length) {
      const i = queue.pop(), p = i * 4;
      if (rgba[p] >= T && rgba[p + 1] >= T && rgba[p + 2] >= T && rgba[p + 3] > 0) {
        rgba[p + 3] = 0; const x = i % w, y = (i / w) | 0;
        push(x + 1, y); push(x - 1, y); push(x, y + 1); push(x, y - 1);
      }
    }
    // 重编码为 RGBA PNG(filter 0)
    const rowOut = w * 4, outData = Buffer.alloc((rowOut + 1) * h);
    for (let y = 0; y < h; y++) { outData[y * (rowOut + 1)] = 0; for (let i = 0; i < rowOut; i++) outData[y * (rowOut + 1) + 1 + i] = rgba[y * rowOut + i]; }
    const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
    return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), mkChunk('IHDR', ihdr), mkChunk('IDAT', deflateSync(outData)), mkChunk('IEND', Buffer.alloc(0))]);
  } catch (e) {
    return buffer; // 解析失败则原样返回
  }
}

export async function onRequest(context) {
  const { request, env } = context;

  // ── CORS 预检 ──
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, X-Auth-Key',
        'Access-Control-Max-Age': '86400',
      },
    });
  }

  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
  };

  // ── GET: 图标代理 (/api/data?icon=xxx) ──
  if (request.method === 'GET' && request.url.indexOf('icon=') !== -1) {
    const idx = request.url.indexOf('icon=') + 5;
    let iconDomain = request.url.slice(idx);
    const amp = iconDomain.indexOf('&');
    if (amp !== -1) iconDomain = iconDomain.slice(0, amp);
    iconDomain = decodeURIComponent(iconDomain);
    if (iconDomain) {
      const sources = [
        `https://www.google.com/s2/favicons?domain=${iconDomain}&sz=64`,
        `https://${iconDomain}/favicon.ico`,
        `https://api.iowen.cn/favicon/${iconDomain}.png`,
      ];
      for (const src of sources) {
        try {
          const ctrl = new AbortController();
          const t = setTimeout(() => ctrl.abort(), 4000);
          const r = await fetch(src, { signal: ctrl.signal });
          clearTimeout(t);
          if (r.ok) {
            const buf = Buffer.from(await r.arrayBuffer());
            const processed = stripWhiteBackground(buf);
            const isPng = processed.length > 4 && processed[0] === 0x89 && processed[1] === 0x50;
            return new Response(processed, {
              headers: {
                'Content-Type': isPng ? 'image/png' : (r.headers.get('Content-Type') || 'image/png'),
                'Cache-Control': 'public, max-age=604800',
                'Access-Control-Allow-Origin': '*',
                'X-Icon-Striped': processed !== buf ? '1' : '0',
              },
            });
          }
        } catch (e) {}
      }
    }
    return new Response('Not found', { status: 404, headers: { 'Access-Control-Allow-Origin': '*' } });
  }

  // ── GET: 获取数据 ──
  if (request.method === 'GET') {
    try {
      const raw = await env.NAV_DATA.get(KV_KEY);
      let parsed = null;
      if (raw) {
        parsed = JSON.parse(raw);
        // 兼容旧格式：旧数据是纯数组，没有 updatedAt
        if (Array.isArray(parsed)) parsed = { data: parsed, updatedAt: 0 };
      }
      return new Response(JSON.stringify({
        data: parsed && Array.isArray(parsed.data) ? parsed.data : null,
        updatedAt: parsed && typeof parsed.updatedAt === 'number' ? parsed.updatedAt : 0,
      }), { headers: corsHeaders });
    } catch (e) {
      return new Response(JSON.stringify({ error: '读取失败' }), {
        status: 500, headers: corsHeaders,
      });
    }
  }

  // ── POST: 保存数据 ──
  if (request.method === 'POST') {
    // 认证校验
    const authKey = request.headers.get('X-Auth-Key');
    if (!authKey || authKey !== env.SECRET_KEY) {
      return new Response(JSON.stringify({ error: '未授权' }), {
        status: 401, headers: corsHeaders,
      });
    }

    let body;
    try { body = await request.json(); } catch (e) {
      return new Response(JSON.stringify({ error: '请求格式错误' }), {
        status: 400, headers: corsHeaders,
      });
    }

    const { data, updatedAt } = body;
    if (!data || !Array.isArray(data)) {
      return new Response(JSON.stringify({ error: '数据格式错误' }), {
        status: 400, headers: corsHeaders,
      });
    }

    try {
      // 存 { data, updatedAt }，供客户端按"谁新用谁"合并
      const ts = typeof updatedAt === 'number' ? updatedAt : Date.now();
      await env.NAV_DATA.put(KV_KEY, JSON.stringify({ data, updatedAt: ts }));
      return new Response(JSON.stringify({ success: true, updatedAt: ts }), {
        headers: corsHeaders,
      });
    } catch (e) {
      return new Response(JSON.stringify({ error: '保存失败' }), {
        status: 500, headers: corsHeaders,
      });
    }
  }

  return new Response(JSON.stringify({ error: '不支持的方法' }), {
    status: 405, headers: corsHeaders,
  });
}
