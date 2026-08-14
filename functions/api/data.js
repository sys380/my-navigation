// ============================================================
//  Cloudflare Pages Function — 自动同步 API
//  GET  /api/data    → 获取数据
//  POST /api/data    → 保存数据 { data }
//  所有设备共享同一份数据，无需同步码
// ============================================================
import { PNG } from 'pngjs';

const KV_KEY = 'nav:shared';

// 去掉 favicon 的白色背景：从边缘向内的白色连通域设为透明（保留 logo 内部的白）
function stripWhiteBackground(buffer) {
  if (!buffer || buffer.length < 8) return buffer;
  const isPng = buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47;
  if (!isPng) return buffer;
  try {
    const png = PNG.sync.read(buffer);
    const { width: w, height: h, data } = png;
    const T = 240;
    const isWhite = (i) => data[i] >= T && data[i + 1] >= T && data[i + 2] >= T && data[i + 3] > 0;
    const visited = new Uint8Array(w * h);
    const queue = [];
    const push = (x, y) => {
      if (x < 0 || y < 0 || x >= w || y >= h) return;
      const idx = y * w + x;
      if (visited[idx]) return;
      visited[idx] = 1;
      queue.push(idx);
    };
    for (let x = 0; x < w; x++) { push(x, 0); push(x, h - 1); }
    for (let y = 0; y < h; y++) { push(0, y); push(w - 1, y); }
    while (queue.length) {
      const idx = queue.pop();
      const i = idx * 4;
      if (isWhite(i)) {
        data[i + 3] = 0; // 变透明
        const x = idx % w, y = (idx / w) | 0;
        push(x + 1, y); push(x - 1, y); push(x, y + 1); push(x, y - 1);
      }
    }
    return PNG.sync.write(png);
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
