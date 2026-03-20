/**
 * Cloudflare Worker — CORS proxy for Omnia MCP + Asana + Claude endpoints.
 * Sits between the PWAs and backend services.
 * Routes:
 *   POST /          → SQL MCP
 *   POST /docs      → Docs MCP
 *   POST /summarize → Claude API (Anthropic) for AI note summaries
 *   GET  /asana/*   → Asana REST API (with PAT auth)
 */

const ASANA_API = 'https://app.asana.com/api/1.0';

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const allowed = origin === env.ALLOWED_ORIGIN
      || origin === 'http://localhost:5173'
      || origin === 'http://localhost:5174'
      || origin === 'http://localhost:5175'
      || origin === 'http://localhost:5176'
      || origin.endsWith('.omnia-tenants.pages.dev')
      || origin === 'https://omnia-tenants.pages.dev'
      || origin === 'https://tenants.liveomnia.com'
      || origin.endsWith('.omnia-app.pages.dev')
      || origin === 'https://omnia-app.pages.dev'
      || origin === 'https://omniaapp.liveomnia.com'
      || origin === 'https://omnia-app.liveomnia.com'
      || origin.endsWith('.omnia-arrears.pages.dev')
      || origin === 'https://omnia-arrears.pages.dev'
      || origin === 'https://arrears.liveomnia.com'
      || origin.endsWith('.omnia-dashboard.pages.dev')
      || origin === 'https://omnia-dashboard.pages.dev'
      || origin === 'https://weeklystats.liveomnia.com';

    const corsHeaders = {
      'Access-Control-Allow-Origin': allowed ? origin : '',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Accept, Mcp-Session-Id, X-Api-Key',
      'Access-Control-Expose-Headers': 'Mcp-Session-Id',
      'Access-Control-Max-Age': '86400',
    };

    // Preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    // Block disallowed origins
    if (!allowed) {
      return new Response('Forbidden', { status: 403 });
    }

    const url = new URL(request.url);

    // ── Asana proxy: GET /asana/* → https://app.asana.com/api/1.0/* ──
    if (url.pathname.startsWith('/asana/')) {
      if (request.method !== 'GET') {
        return new Response('Method not allowed', { status: 405, headers: corsHeaders });
      }
      if (!env.ASANA_PAT) {
        return new Response('Asana PAT not configured', { status: 500, headers: corsHeaders });
      }

      const asanaPath = url.pathname.replace(/^\/asana/, '');
      const asanaUrl = new URL(ASANA_API + asanaPath);
      // Pass through query params
      for (const [k, v] of url.searchParams) {
        asanaUrl.searchParams.set(k, v);
      }

      const resp = await fetch(asanaUrl.toString(), {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${env.ASANA_PAT}`,
          'Accept': 'application/json',
        },
      });

      const responseHeaders = new Headers(resp.headers);
      for (const [key, value] of Object.entries(corsHeaders)) {
        responseHeaders.set(key, value);
      }

      return new Response(resp.body, {
        status: resp.status,
        headers: responseHeaders,
      });
    }

    // ── Claude summarize: POST /summarize → Anthropic Messages API ──
    if (url.pathname === '/summarize' && request.method === 'POST') {
      const jsonHeaders = { ...corsHeaders, 'Content-Type': 'application/json' };

      // 1. Check ANTHROPIC_API_KEY is configured
      if (!env.ANTHROPIC_API_KEY) {
        return new Response(JSON.stringify({ error: 'Anthropic API key not configured' }),
          { status: 500, headers: jsonHeaders });
      }

      // 2. Verify Cloudflare Access JWT if configured (production auth)
      if (env.CF_ACCESS_AUD) {
        const cfJwt = request.headers.get('Cf-Access-Jwt-Assertion') || '';
        if (!cfJwt) {
          return new Response(JSON.stringify({ error: 'Unauthorized — Cloudflare Access token required' }),
            { status: 401, headers: jsonHeaders });
        }
      }

      // 3. Parse and validate input
      let body;
      try {
        body = await request.json();
      } catch {
        return new Response(JSON.stringify({ error: 'Invalid JSON body' }),
          { status: 400, headers: jsonHeaders });
      }

      const { notes, property } = body;
      if (!notes || !Array.isArray(notes) || !notes.length) {
        return new Response(JSON.stringify({ summary: 'No notes to summarise.', truncated: false }),
          { status: 200, headers: jsonHeaders });
      }

      // 4. Input size limits — cap at 10 notes, 800 chars per note, 8000 chars total
      const MAX_NOTES = 10;
      const MAX_NOTE_CHARS = 800;
      const MAX_TOTAL_CHARS = 8000;

      let truncated = false;
      let capped = notes.slice(0, MAX_NOTES);
      if (capped.length < notes.length) truncated = true;

      // Sanitise each note: trim, cap length, strip control chars
      capped = capped.map(n => ({
        date: String(n.date || '').slice(0, 30),
        type: String(n.type || 'Note').slice(0, 50),
        note: String(n.note || '').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '').slice(0, MAX_NOTE_CHARS),
      }));

      let notesText = capped.map(n =>
        `[${n.date}] (${n.type}) ${n.note}`
      ).join('\n\n');

      if (notesText.length > MAX_TOTAL_CHARS) {
        notesText = notesText.slice(0, MAX_TOTAL_CHARS) + '\n\n[...truncated]';
        truncated = true;
      }

      const safeProperty = String(property || 'Unknown').slice(0, 200);

      // 5. Call Anthropic with structured prompt and timeout
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);

      let resp;
      try {
        resp = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          signal: controller.signal,
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': env.ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 512,
            messages: [{
              role: 'user',
              content: `You are an executive briefing assistant for a housing management company (Omnia Housing). Summarise these tenant notes for property "${safeProperty}" into a structured briefing. Use exactly this format:

**Current issue:** one sentence on the core arrears/payment situation
**Key dates:** important dates (e.g. move-in, last payment, notice served)
**Actions taken:** what the housing team has done so far
**Risk level:** Low / Medium / High with one-line justification
**Next step:** recommended next action
${truncated ? '**Note:** Some notes were truncated for length.' : ''}

Be factual, concise, and avoid speculation. If information is missing or unclear, say so.

Notes:
${notesText}`,
            }],
          }),
        });
      } catch (err) {
        clearTimeout(timeout);
        if (err.name === 'AbortError') {
          return new Response(JSON.stringify({ error: 'Summary request timed out' }),
            { status: 504, headers: jsonHeaders });
        }
        return new Response(JSON.stringify({ error: 'Failed to reach Claude API' }),
          { status: 502, headers: jsonHeaders });
      }
      clearTimeout(timeout);

      // 6. Handle Anthropic error responses
      if (!resp.ok) {
        const status = resp.status;
        if (status === 429) {
          return new Response(JSON.stringify({ error: 'Rate limited — try again shortly' }),
            { status: 429, headers: jsonHeaders });
        }
        // Don't leak raw Anthropic error details to client
        return new Response(JSON.stringify({ error: 'Summary generation failed' }),
          { status: 502, headers: jsonHeaders });
      }

      let result;
      try {
        result = await resp.json();
      } catch {
        return new Response(JSON.stringify({ error: 'Invalid response from Claude API' }),
          { status: 502, headers: jsonHeaders });
      }

      const summary = result.content?.[0]?.text || 'Unable to generate summary.';

      return new Response(JSON.stringify({
        summary,
        truncated,
        model: 'claude-haiku-4-5-20251001',
        generatedAt: new Date().toISOString(),
      }), { status: 200, headers: jsonHeaders });
    }

    // ── MCP proxy: POST / or /docs ──
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405, headers: corsHeaders });
    }

    if (env.API_KEY) {
      const authHeader = request.headers.get('X-Api-Key') || '';
      if (authHeader !== env.API_KEY) {
        return new Response('Unauthorized', { status: 401, headers: corsHeaders });
      }
    }

    const target = url.pathname === '/docs' ? env.DOCS_MCP_TARGET : env.SQL_MCP_TARGET;

    if (!target) {
      return new Response('MCP target not configured', { status: 500, headers: corsHeaders });
    }

    // Forward to MCP server
    const headers = new Headers();
    headers.set('Content-Type', request.headers.get('Content-Type') || 'application/json');
    headers.set('Accept', request.headers.get('Accept') || 'application/json, text/event-stream');

    const sessionId = request.headers.get('Mcp-Session-Id');
    if (sessionId) {
      headers.set('Mcp-Session-Id', sessionId);
    }

    const resp = await fetch(target, {
      method: 'POST',
      headers,
      body: request.body,
    });

    // Pass response back with CORS headers
    const responseHeaders = new Headers(resp.headers);
    for (const [key, value] of Object.entries(corsHeaders)) {
      responseHeaders.set(key, value);
    }

    return new Response(resp.body, {
      status: resp.status,
      headers: responseHeaders,
    });
  },
};
