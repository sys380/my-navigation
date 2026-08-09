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
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Max-Age': '86400',
      },
    });
  }

  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
  };

  // ── GET: 获取数据 ──
  if (request.method === 'GET') {
    try {
      const raw = await env.NAV_DATA.get(KV_KEY);
      return new Response(JSON.stringify({
        data: raw ? JSON.parse(raw) : null,
      }), { headers: corsHeaders });
    } catch (e) {
      return new Response(JSON.stringify({ error: '读取失败' }), {
        status: 500, headers: corsHeaders,
      });
    }
  }

  // ── POST: 保存数据 ──
  if (request.method === 'POST') {
    let body;
    try { body = await request.json(); } catch (e) {
      return new Response(JSON.stringify({ error: '请求格式错误' }), {
        status: 400, headers: corsHeaders,
      });
    }

    const { data } = body;
    if (!data || !Array.isArray(data)) {
      return new Response(JSON.stringify({ error: '数据格式错误' }), {
        status: 400, headers: corsHeaders,
      });
    }

    try {
      await env.NAV_DATA.put(KV_KEY, JSON.stringify(data));
      return new Response(JSON.stringify({ success: true }), {
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
