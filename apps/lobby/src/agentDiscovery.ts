/**
 * Agent-readiness discovery surface for the public lobby (scored by isitagentready.com).
 *
 * Everything here describes endpoints that already exist; nothing advertises a capability the
 * lobby does not implement (no OAuth issuer, no MCP server). Documents are built per request from
 * the public origin so `freightfloor.com` and `*.run.app` each describe themselves.
 *
 *   /.well-known/api-catalog              RFC 9727 linkset of the read-only public API
 *   /openapi.json                         OpenAPI 3.1 for that API
 *   /.well-known/agent-skills/index.json  Agent Skills Discovery v0.2.0 index (+ SKILL.md)
 *   /.well-known/ai-catalog.json          ARD / ai-catalog manifest
 *   /.well-known/poppy.json               Personal Agent Protocol, website-only declaration
 *   /auth.md                              How (not) to authenticate: public reads, no agent registration
 *   GET / with Accept: text/markdown      markdown rendition of the homepage (llms.txt + agent links)
 *   GET / (HTML)                          RFC 8288 Link headers pointing at the above
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

export interface AgentDiscoveryOptions {
  publicOrigin: (req: FastifyRequest) => string;
  /** Built client directory; `llms.txt` there is the markdown homepage body. */
  staticRoot: string;
}

const SOURCE_URL = 'https://github.com/davenportjw/freightfloor';
const PROTOCOL_DOC_URL = `${SOURCE_URL}/blob/main/docs/protocol.md`;
const SKILL_NAME = 'freightfloor';

/** Content-Signal preferences, also emitted in robots.txt (https://contentsignals.org/). */
export const CONTENT_SIGNAL = 'search=yes, ai-input=yes, ai-train=no';

/** RFC 8288 Link header for the HTML homepage. */
export function homepageLinkHeader(): string {
  return [
    '</.well-known/api-catalog>; rel="api-catalog"',
    '</openapi.json>; rel="service-desc"; type="application/openapi+json"',
    `<${PROTOCOL_DOC_URL}>; rel="service-doc"; type="text/html"`,
    '</llms.txt>; rel="describedby"; type="text/markdown"',
    '</.well-known/ai-catalog.json>; rel="ai-catalog"; type="application/json"',
    '</.well-known/agent-skills/index.json>; rel="agent-skills"; type="application/json"',
  ].join(', ');
}

/**
 * True when the client asks for markdown at least as strongly as HTML (`Accept: text/markdown`,
 * `text/markdown, text/html;q=0.8`, ...). Browsers never send text/markdown, so they keep HTML.
 */
export function prefersMarkdown(accept: string | string[] | undefined): boolean {
  const raw = Array.isArray(accept) ? accept.join(',') : accept;
  if (!raw) return false;
  let md = -1;
  let html = -1;
  for (const part of raw.split(',')) {
    const [type, ...params] = part.trim().toLowerCase().split(';');
    const qParam = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
    const q = qParam ? Number(qParam.slice(2)) : 1;
    const weight = Number.isFinite(q) ? q : 0;
    if (type === 'text/markdown') md = Math.max(md, weight);
    else if (type === 'text/html') html = Math.max(html, weight);
  }
  return md > 0 && md >= html;
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function skillMarkdown(origin: string): string {
  return `---
name: ${SKILL_NAME}
description: Read live Freight Floor state (warehouse sites, drivers, leaderboards, Daily Shift) through the public read-only JSON API, and explain how the browser game is played.
---

# Freight Floor

Freight Floor (${origin}/) is a free multiplayer forklift game in the browser. Humans drive forklifts
on shared isometric warehouse floors against rival forklifts driven by Gemini AI agents. Four regional
sites (Denver \`site-den-1\`, Salt Lake City \`site-slc-2\`, Phoenix \`site-phx-3\`, Albuquerque
\`site-abq-4\`) run shifts and hand pallets to each other.

## When to use

- A user asks whether Freight Floor is up, how busy it is, or which site to join.
- A user asks for the all-time leaderboard or today's Daily Shift leaderboard.
- A user asks how to play (controls, modes, scoring).

## Public read-only API (no credentials)

All endpoints are \`GET\`, return JSON, and need no authentication. The OpenAPI description is at
${origin}/openapi.json.

| Endpoint | Returns |
| --- | --- |
| \`${origin}/api/network\` | \`sites[]\` (id, state \`live\`/\`online\`/\`break\`/\`offline\`, drivers, spectators, maxDrivers, shipped, tier, phase), top-10 human \`leaderboard[]\`, \`queueSize\`, \`maxTotalDrivers\` |
| \`${origin}/api/daily\` | Today's Daily Shift: \`dayKey\`, \`number\`, \`modifier\`, \`resetsAt\` (epoch ms), \`total\`, ranked \`top[]\` |
| \`${origin}/healthz/\` | \`{ "ok": true, "service": "lobby" }\` |

Poll politely (no more than once every few seconds). Don't call \`/api/join\`, \`/api/queue/*\`, or
\`/ws\`: they start real game sessions, are reserved for human players in a browser, and reject
automated clients.

## How the game is played

- 3-Minute Blitz (default): personal high-score run; the clock starts on your first move.
- Free Range: open-ended driving ranked by points per minute (PPM) and on-time percentage.
- Contract cards: each run deals 3 goal cards; completed cards grant perks.
- Floor mode: spectators watch the shift, see KPIs, and send floor orders to the AI fleet.
- Controls: WASD drive, E pick up/drop, Shift boost, C Co-Pilot, Tab standings, ? help.

More: ${origin}/llms.txt and ${SOURCE_URL}/blob/main/docs/gameplay.md.
`;
}

function authMarkdown(origin: string): string {
  return `# Freight Floor auth.md

Agent audience: AI agents and automated clients reading Freight Floor (${origin}/).

## Registration

There is no agent registration, OAuth issuer, or API key. Freight Floor doesn't provision credentials
for agents, and \`${origin}/.well-known/oauth-protected-resource\` isn't published because no endpoint is
protected by OAuth.

## Supported methods

- **None (public read-only).** \`GET ${origin}/api/network\`, \`GET ${origin}/api/daily\`, and
  \`GET ${origin}/healthz/\` need no credentials. See ${origin}/openapi.json.

## Credential use

Gameplay endpoints (\`POST /api/join\`, \`/api/queue/*\`, \`/ws\`) issue a short-lived, signed seat ticket
to an anonymous human player in the browser. That ticket is bound to one browser session and isn't
an agent credential. Automated clients and crawlers are refused with \`403 crawler_not_allowed\`.
`;
}

function openApiDocument(origin: string) {
  const json = { 'application/json': { schema: { type: 'object' } } };
  return {
    openapi: '3.1.0',
    info: {
      title: 'Freight Floor public lobby API',
      version: '1.0.0',
      description:
        'Read-only, unauthenticated endpoints of the Freight Floor lobby. Gameplay endpoints (/api/join, /api/queue/*, /ws) are reserved for human players in a browser and are not described here.',
      license: { name: 'Apache-2.0', identifier: 'Apache-2.0' },
    },
    externalDocs: { url: PROTOCOL_DOC_URL },
    servers: [{ url: origin }],
    paths: {
      '/api/network': {
        get: {
          operationId: 'getNetwork',
          summary: 'Live warehouse sites, top-10 leaderboard, and seat queue size',
          responses: { '200': { description: 'Network snapshot', content: json } },
        },
      },
      '/api/daily': {
        get: {
          operationId: 'getDailyShift',
          summary: "Today's Daily Shift leaderboard (UTC day)",
          parameters: [
            {
              name: 'publicId',
              in: 'query',
              required: false,
              description: "A player's public id, to include their own rank in `you`.",
              schema: { type: 'string' },
            },
          ],
          responses: {
            '200': { description: 'Daily board', content: json },
            '503': { description: 'Daily leaderboard unavailable', content: json },
          },
        },
      },
      '/healthz/': {
        get: {
          operationId: 'getHealth',
          summary: 'Lobby liveness',
          responses: { '200': { description: 'Healthy', content: json } },
        },
      },
    },
  };
}

export function registerAgentDiscoveryRoutes(app: FastifyInstance, opts: AgentDiscoveryOptions): void {
  const { publicOrigin } = opts;
  const llmsPath = join(opts.staticRoot, 'llms.txt');
  const llmsTxt = existsSync(llmsPath) ? readFileSync(llmsPath, 'utf8') : null;

  const json = (reply: FastifyReply, type: string, body: unknown) =>
    reply
      .type(type)
      .header('Cache-Control', 'public, max-age=3600')
      .header('Access-Control-Allow-Origin', '*')
      .send(JSON.stringify(body, null, 2));

  app.get('/.well-known/api-catalog', async (req, reply) => {
    const origin = publicOrigin(req);
    return json(reply, 'application/linkset+json; charset=utf-8', {
      linkset: [
        {
          anchor: `${origin}/api/`,
          'service-desc': [{ href: `${origin}/openapi.json`, type: 'application/openapi+json' }],
          'service-doc': [{ href: PROTOCOL_DOC_URL, type: 'text/html' }],
          status: [{ href: `${origin}/healthz/`, type: 'application/json' }],
        },
      ],
    });
  });

  app.get('/openapi.json', async (req, reply) =>
    json(reply, 'application/openapi+json; charset=utf-8', openApiDocument(publicOrigin(req))),
  );

  app.get(`/.well-known/agent-skills/${SKILL_NAME}/SKILL.md`, async (req, reply) =>
    reply
      .type('text/markdown; charset=utf-8')
      .header('Cache-Control', 'public, max-age=3600')
      .header('Access-Control-Allow-Origin', '*')
      .send(skillMarkdown(publicOrigin(req))),
  );

  app.get('/.well-known/agent-skills/index.json', async (req, reply) => {
    const origin = publicOrigin(req);
    return json(reply, 'application/json; charset=utf-8', {
      $schema: 'https://schemas.agentskills.io/discovery/0.2.0/schema.json',
      skills: [
        {
          name: SKILL_NAME,
          type: 'skill-md',
          description:
            'Read live Freight Floor state (sites, drivers, leaderboards, Daily Shift) via the public read-only API, and explain how the game is played.',
          url: `${origin}/.well-known/agent-skills/${SKILL_NAME}/SKILL.md`,
          // Hash of the exact bytes the SKILL.md route serves for this origin.
          digest: `sha256:${sha256Hex(skillMarkdown(origin))}`,
        },
      ],
    });
  });

  app.get('/.well-known/ai-catalog.json', async (req, reply) => {
    const origin = publicOrigin(req);
    const host = new URL(origin).hostname;
    return json(reply, 'application/json; charset=utf-8', {
      specVersion: '1.0',
      host: { displayName: 'Freight Floor', identifier: `did:web:${host}` },
      entries: [
        {
          identifier: `urn:air:${host}:api:lobby`,
          displayName: 'Freight Floor public lobby API',
          type: 'application/openapi+json',
          url: `${origin}/openapi.json`,
          representativeQueries: [
            'is Freight Floor online right now',
            'how many drivers are on each Freight Floor warehouse site',
            'show the Freight Floor leaderboard',
            "what is today's Freight Floor Daily Shift leaderboard",
          ],
        },
        {
          identifier: `urn:air:${host}:skill:${SKILL_NAME}`,
          displayName: 'Freight Floor agent skill',
          type: 'text/markdown',
          url: `${origin}/.well-known/agent-skills/${SKILL_NAME}/SKILL.md`,
          representativeQueries: [
            'how do I play Freight Floor',
            'what are the Freight Floor controls',
            'which Freight Floor warehouse should I join',
          ],
        },
        {
          identifier: `urn:air:${host}:doc:llms`,
          displayName: 'Freight Floor llms.txt summary',
          type: 'text/markdown',
          url: `${origin}/llms.txt`,
          representativeQueries: [
            'what is Freight Floor',
            'multiplayer forklift game with Gemini AI drivers',
            'Freight Floor source code and architecture',
          ],
        },
      ],
    });
  });

  app.get('/.well-known/poppy.json', async (req, reply) => {
    const host = new URL(publicOrigin(req)).hostname.replace(/^www\./, '');
    return json(reply, 'application/json; charset=utf-8', {
      protocol_version: '0.1',
      organization: { name: 'Freight Floor', domain: host },
      web: {},
    });
  });

  app.get('/auth.md', async (req, reply) =>
    reply
      .type('text/markdown; charset=utf-8')
      .header('Cache-Control', 'public, max-age=3600')
      .send(authMarkdown(publicOrigin(req))),
  );

  // Homepage: markdown for agents that ask for it, Link headers on every response. Runs before
  // @fastify/static so the HTML path is untouched for browsers.
  const isHomepage = (req: FastifyRequest) => {
    const path = req.url.split('?')[0];
    return (req.method === 'GET' || req.method === 'HEAD') && (path === '/' || path === '/index.html');
  };

  app.addHook('onRequest', async (req, reply) => {
    if (!isHomepage(req) || !llmsTxt || !prefersMarkdown(req.headers.accept)) return;
    const origin = publicOrigin(req);
    const body =
      `${llmsTxt.trimEnd()}\n\n## For agents\n\n` +
      `- [Agent skill](${origin}/.well-known/agent-skills/${SKILL_NAME}/SKILL.md): public read-only API and how to play\n` +
      `- [OpenAPI](${origin}/openapi.json): \`GET /api/network\`, \`GET /api/daily\`, \`GET /healthz/\`\n` +
      `- [API catalog](${origin}/.well-known/api-catalog) (RFC 9727)\n` +
      `- [AI catalog](${origin}/.well-known/ai-catalog.json)\n` +
      `- [auth.md](${origin}/auth.md): no credentials needed for public reads\n`;
    return reply
      .code(200)
      .type('text/markdown; charset=utf-8')
      .header('Vary', 'Accept')
      .header('Link', homepageLinkHeader())
      .header('Cache-Control', 'public, max-age=300')
      .send(body);
  });

  app.addHook('onSend', async (req, reply, payload) => {
    if (isHomepage(req) && !reply.hasHeader('Link')) {
      reply.header('Link', homepageLinkHeader());
      reply.header('Vary', 'Accept');
    }
    return payload;
  });
}
