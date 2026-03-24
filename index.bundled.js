// index.js
var ASANA_API = "https://app.asana.com/api/1.0";
var HUBSPOT_API = "https://api.hubapi.com";
var index_default = {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const allowed = origin === env.ALLOWED_ORIGIN
      || origin === "http://localhost:5173"
      || origin === "http://localhost:5174"
      || origin === "http://localhost:5175"
      || origin === "http://localhost:5176"
      || origin.endsWith(".omnia-tenants.pages.dev")
      || origin === "https://omnia-tenants.pages.dev"
      || origin === "https://tenants.liveomnia.com"
      || origin.endsWith(".omnia-app.pages.dev")
      || origin === "https://omnia-app.pages.dev"
      || origin === "https://omniaapp.liveomnia.com"
      || origin === "https://omnia-app.liveomnia.com"
      || origin.endsWith(".omnia-arrears.pages.dev")
      || origin === "https://omnia-arrears.pages.dev"
      || origin === "https://arrears.liveomnia.com"
      || origin.endsWith(".omnia-dashboard.pages.dev")
      || origin === "https://omnia-dashboard.pages.dev"
      || origin === "https://weeklystats.liveomnia.com"
      || origin === "https://dashboard.liveomnia.com"
      || origin.endsWith(".fsh-lettings.pages.dev")
      || origin === "https://fsh-lettings.pages.dev"
      || origin === "https://fsh-lettings.liveomnia.com"
      || origin === "http://localhost:5190";
    const corsHeaders = {
      "Access-Control-Allow-Origin": allowed ? origin : "",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Accept, Mcp-Session-Id, X-Api-Key",
      "Access-Control-Expose-Headers": "Mcp-Session-Id",
      "Access-Control-Max-Age": "86400"
    };
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }
    if (!allowed) {
      return new Response("Forbidden", { status: 403 });
    }
    const url = new URL(request.url);

    // ── Asana proxy ──
    if (url.pathname.startsWith("/asana/")) {
      if (request.method !== "GET") {
        return new Response("Method not allowed", { status: 405, headers: corsHeaders });
      }
      const asanaPat = env.ASANA_PAT_SECRET || env.ASANA_PAT;
      if (!asanaPat) {
        return new Response("Asana PAT not configured", { status: 500, headers: corsHeaders });
      }
      const asanaPath = url.pathname.replace(/^\/asana/, "");
      const asanaUrl = new URL(ASANA_API + asanaPath);
      for (const [k, v] of url.searchParams) {
        asanaUrl.searchParams.set(k, v);
      }
      const resp2 = await fetch(asanaUrl.toString(), {
        method: "GET",
        headers: {
          "Authorization": `Bearer ${asanaPat}`,
          "Accept": "application/json"
        }
      });
      const responseHeaders2 = new Headers(resp2.headers);
      for (const [key, value] of Object.entries(corsHeaders)) {
        responseHeaders2.set(key, value);
      }
      return new Response(resp2.body, {
        status: resp2.status,
        headers: responseHeaders2
      });
    }

    // ── HubSpot proxy: /hubspot/* → HubSpot CRM API ──
    if (url.pathname.startsWith("/hubspot/")) {
      const hubspotToken = env.HUBSPOT_TOKEN;
      if (!hubspotToken) {
        return new Response(JSON.stringify({ error: "HubSpot token not configured" }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      const hubspotPath = url.pathname.replace(/^\/hubspot/, "");

      // POST /hubspot/contacts/search → HubSpot search
      if (hubspotPath === "/contacts/search" && request.method === "POST") {
        const body = await request.text();
        const resp2 = await fetch(`${HUBSPOT_API}/crm/v3/objects/contacts/search`, {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${hubspotToken}`,
            "Content-Type": "application/json"
          },
          body
        });
        const responseHeaders2 = new Headers(resp2.headers);
        for (const [key, value] of Object.entries(corsHeaders)) {
          responseHeaders2.set(key, value);
        }
        responseHeaders2.set("Content-Type", "application/json");
        return new Response(resp2.body, {
          status: resp2.status,
          headers: responseHeaders2
        });
      }

      // GET /hubspot/contacts, /hubspot/contacts/:id
      if (request.method !== "GET") {
        return new Response("Method not allowed", { status: 405, headers: corsHeaders });
      }

      const hubspotUrl = new URL(HUBSPOT_API + "/crm/v3/objects" + hubspotPath);
      for (const [k, v] of url.searchParams) {
        hubspotUrl.searchParams.set(k, v);
      }

      const resp2 = await fetch(hubspotUrl.toString(), {
        method: "GET",
        headers: {
          "Authorization": `Bearer ${hubspotToken}`,
          "Accept": "application/json"
        }
      });
      const responseHeaders2 = new Headers(resp2.headers);
      for (const [key, value] of Object.entries(corsHeaders)) {
        responseHeaders2.set(key, value);
      }
      responseHeaders2.set("Content-Type", "application/json");
      return new Response(resp2.body, {
        status: resp2.status,
        headers: responseHeaders2
      });
    }

    // ── Claude summarize ──
    if (url.pathname === "/summarize" && request.method === "POST") {
      const jsonHeaders = { ...corsHeaders, "Content-Type": "application/json" };
      if (!env.ANTHROPIC_API_KEY) {
        return new Response(
          JSON.stringify({ error: "Anthropic API key not configured" }),
          { status: 500, headers: jsonHeaders }
        );
      }
      if (env.CF_ACCESS_AUD) {
        const cfJwt = request.headers.get("Cf-Access-Jwt-Assertion") || "";
        if (!cfJwt) {
          return new Response(
            JSON.stringify({ error: "Unauthorized \u2014 Cloudflare Access token required" }),
            { status: 401, headers: jsonHeaders }
          );
        }
      }
      let body;
      try {
        body = await request.json();
      } catch {
        return new Response(
          JSON.stringify({ error: "Invalid JSON body" }),
          { status: 400, headers: jsonHeaders }
        );
      }
      const { notes, property } = body;
      if (!notes || !Array.isArray(notes) || !notes.length) {
        return new Response(
          JSON.stringify({ summary: "No notes to summarise.", truncated: false }),
          { status: 200, headers: jsonHeaders }
        );
      }
      const MAX_NOTES = 10;
      const MAX_NOTE_CHARS = 800;
      const MAX_TOTAL_CHARS = 8e3;
      let truncated = false;
      let capped = notes.slice(0, MAX_NOTES);
      if (capped.length < notes.length) truncated = true;
      capped = capped.map((n) => ({
        date: String(n.date || "").slice(0, 30),
        type: String(n.type || "Note").slice(0, 50),
        note: String(n.note || "").replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "").slice(0, MAX_NOTE_CHARS)
      }));
      let notesText = capped.map(
        (n) => `[${n.date}] (${n.type}) ${n.note}`
      ).join("\n\n");
      if (notesText.length > MAX_TOTAL_CHARS) {
        notesText = notesText.slice(0, MAX_TOTAL_CHARS) + "\n\n[...truncated]";
        truncated = true;
      }
      const safeProperty = String(property || "Unknown").slice(0, 200);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15e3);
      let resp2;
      try {
        resp2 = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          signal: controller.signal,
          headers: {
            "Content-Type": "application/json",
            "x-api-key": env.ANTHROPIC_API_KEY,
            "anthropic-version": "2023-06-01"
          },
          body: JSON.stringify({
            model: "claude-haiku-4-5-20251001",
            max_tokens: 512,
            messages: [{
              role: "user",
              content: `You are an executive briefing assistant for a housing management company (Omnia Housing). Summarise these tenant notes for property "${safeProperty}" into a structured briefing. Use exactly this format:
**Current issue:** one sentence on the core arrears/payment situation
**Key dates:** important dates (e.g. move-in, last payment, notice served)
**Actions taken:** what the housing team has done so far
**Risk level:** Low / Medium / High with one-line justification
**Next step:** recommended next action
${truncated ? "**Note:** Some notes were truncated for length." : ""}
Be factual, concise, and avoid speculation. If information is missing or unclear, say so.
Notes:
${notesText}`
            }]
          })
        });
      } catch (err) {
        clearTimeout(timeout);
        if (err.name === "AbortError") {
          return new Response(
            JSON.stringify({ error: "Summary request timed out" }),
            { status: 504, headers: jsonHeaders }
          );
        }
        return new Response(
          JSON.stringify({ error: "Failed to reach Claude API" }),
          { status: 502, headers: jsonHeaders }
        );
      }
      clearTimeout(timeout);
      if (!resp2.ok) {
        const status = resp2.status;
        if (status === 429) {
          return new Response(
            JSON.stringify({ error: "Rate limited \u2014 try again shortly" }),
            { status: 429, headers: jsonHeaders }
          );
        }
        return new Response(
          JSON.stringify({ error: "Summary generation failed" }),
          { status: 502, headers: jsonHeaders }
        );
      }
      let result;
      try {
        result = await resp2.json();
      } catch {
        return new Response(
          JSON.stringify({ error: "Invalid response from Claude API" }),
          { status: 502, headers: jsonHeaders }
        );
      }
      const summary = result.content?.[0]?.text || "Unable to generate summary.";
      return new Response(JSON.stringify({
        summary,
        truncated,
        model: "claude-haiku-4-5-20251001",
        generatedAt: (new Date()).toISOString()
      }), { status: 200, headers: jsonHeaders });
    }

    // ── MCP proxy ──
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405, headers: corsHeaders });
    }
    if (env.API_KEY) {
      const authHeader = request.headers.get("X-Api-Key") || "";
      if (authHeader !== env.API_KEY) {
        return new Response("Unauthorized", { status: 401, headers: corsHeaders });
      }
    }
    const sqlTarget = env.SQL_MCP_TARGET || `${env.SQL_MCP_BASE}?key=${env.SQL_MCP_KEY}`;
    const docsTarget = env.DOCS_MCP_TARGET || `${env.DOCS_MCP_BASE}?key=${env.DOCS_MCP_KEY}`;
    const target = url.pathname === "/docs" ? docsTarget : sqlTarget;
    if (!target) {
      return new Response("MCP target not configured", { status: 500, headers: corsHeaders });
    }
    const headers = new Headers();
    headers.set("Content-Type", request.headers.get("Content-Type") || "application/json");
    headers.set("Accept", request.headers.get("Accept") || "application/json, text/event-stream");
    const sessionId = request.headers.get("Mcp-Session-Id");
    if (sessionId) {
      headers.set("Mcp-Session-Id", sessionId);
    }
    if (env.CF_ACCESS_CLIENT_ID && env.CF_ACCESS_CLIENT_SECRET) {
      headers.set("CF-Access-Client-Id", env.CF_ACCESS_CLIENT_ID);
      headers.set("CF-Access-Client-Secret", env.CF_ACCESS_CLIENT_SECRET);
    }
    const resp = await fetch(target, {
      method: "POST",
      headers,
      body: request.body
    });
    const responseHeaders = new Headers(resp.headers);
    for (const [key, value] of Object.entries(corsHeaders)) {
      responseHeaders.set(key, value);
    }
    return new Response(resp.body, {
      status: resp.status,
      headers: responseHeaders
    });
  }
};
export {
  index_default as default
};
