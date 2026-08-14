// ============================================================
//  Cloudflare Pages Function — 自动同步 API
//  GET  /api/data    → 获取数据
//  POST /api/data    → 保存数据 { data }
//  所有设备共享同一份数据，无需同步码
// ============================================================

const KV_KEY = 'nav:shared';

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
            return new Response(r.body, {
              headers: {
                'Content-Type': r.headers.get('Content-Type') || 'image/png',
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
