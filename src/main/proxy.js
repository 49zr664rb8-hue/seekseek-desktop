'use strict';

/**
 * 协议转换层：把官方前端的 Anthropic 兼容请求，转成 OpenAI 兼容请求发给本地/第三方模型。
 * 只实现聊天主流程；搜索、文件、语音这些「全家桶」能力在非 DeepSeek 服务上不可用。
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');
const fs = require('fs');
const path = require('path');
const asr = require('./asr');
const { handleTts } = require('./tts');

let cfg = {
  // 公开版不预设服务商：由用户在设置里填写
  baseUrl: '',
  apiKey: '',
  model: ''
};

function loadConfig(file) {
  try {
    if (fs.existsSync(file)) {
      cfg = { ...cfg, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
    } else {
      fs.writeFileSync(file, JSON.stringify(cfg, null, 2), 'utf8');
    }
  } catch (e) { /* ignore */ }
}

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
}

function readBody(req) {
  return new Promise((resolve) => {
    let buf = '';
    req.setEncoding('utf8');
    req.on('data', (d) => (buf += d));
    req.on('end', () => {
      try { resolve(JSON.parse(buf || '{}')); } catch (e) { resolve({}); }
    });
  });
}

/** 原样读字节，multipart 里的音频不能按 utf8 解 */
function readRaw(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (d) => chunks.push(Buffer.isBuffer(d) ? d : Buffer.from(d)));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

/** 只取文本块；thinking / tool_use / tool_result / 图片一律丢弃 */
/** 把 Anthropic 的 content 数组拆成文本和图片；图片转成 OpenAI 的 image_url */
function splitContent(content) {
  if (typeof content === 'string') return { text: content, images: [] };
  if (!Array.isArray(content)) return { text: '', images: [] };
  let text = '';
  const images = [];
  for (const b of content) {
    if (!b) continue;
    if (b.type === 'text' && typeof b.text === 'string') {
      text += b.text;
    } else if (b.type === 'image' && b.source) {
      let url = '';
      if (b.source.type === 'base64' && b.source.data) {
        url = 'data:' + (b.source.media_type || 'image/png') + ';base64,' + b.source.data;
      } else if (b.source.type === 'url' && b.source.url) {
        url = b.source.url;
      }
      if (url) images.push({ type: 'image_url', image_url: { url: url } });
    }
  }
  return { text: text, images: images };
}

function blocksToText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  let s = '';
  for (const b of content) {
    if (b && b.type === 'text' && typeof b.text === 'string') s += b.text;
  }
  return s;
}

/** Anthropic messages → OpenAI messages（带长度预算，避免小模型上下文爆掉后胡编） */
function toOpenAi(body, budget) {
  const sysParts = [];
  if (typeof body.system === 'string') {
    sysParts.push(body.system);
  } else if (Array.isArray(body.system)) {
    for (const b of body.system) {
      if (b && b.type === 'text' && typeof b.text === 'string') sysParts.push(b.text);
    }
  }

  const msgs = [];
  for (const m of body.messages || []) {
    const split = splitContent(m.content);
    const text = split.text.trim();
    const role = m.role === 'assistant' ? 'assistant' : 'user';
    if (split.images.length) {
      // 带图片的消息不再合并，直接发结构化内容，交给上游的多模态模型
      const parts = [];
      if (text) parts.push({ type: 'text', text: text });
      for (const img of split.images) parts.push(img);
      msgs.push({ role, content: parts });
      continue;
    }
    if (!text) continue;
    const last = msgs[msgs.length - 1];
    if (last && last.role === role && typeof last.content === 'string') last.content += '\n\n' + text;
    else msgs.push({ role, content: text });
  }

  // 从最近往前保留，超出预算的旧消息丢掉；起点必须是 user
  const limit = budget || 12000;
  let total = 0;
  let start = msgs.length;
  while (start > 0) {
    const len = msgs[start - 1].content.length;
    if (total + len > limit && start < msgs.length) break;
    total += len;
    start -= 1;
  }
  while (start < msgs.length && msgs[start].role !== 'user') start += 1;

  const out = [];
  if (sysParts.length) out.push({ role: 'system', content: sysParts.join('\n\n') });
  return out.concat(msgs.slice(start));
}


/* ---------------- 联网搜索（程序自己搜，不依赖模型能力） ---------------- */

const SEARCH_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

function fetchHtml(url, timeout = 12000) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'http:' ? http : https;
    const req = lib.request(
      {
        hostname: u.hostname,
        port: u.port || (u.protocol === 'http:' ? 80 : 443),
        path: u.pathname + u.search,
        method: 'GET',
        headers: {
          'User-Agent': SEARCH_UA,
          'Accept-Language': 'zh-CN,zh;q=0.9',
          Accept: 'text/html,application/xhtml+xml'
        }
      },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          fetchHtml(new URL(res.headers.location, url).toString(), timeout).then(resolve, reject);
          return;
        }
        if (res.statusCode !== 200) { res.resume(); reject(new Error('HTTP ' + res.statusCode)); return; }
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (d) => (buf += d));
        res.on('end', () => resolve(buf));
      }
    );
    req.setTimeout(timeout, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}

const strip = (s) =>
  String(s).replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();

function parseBing(html) {
  const out = [];
  for (const block of html.split('class="b_algo"').slice(1)) {
    const seg = block.slice(0, 4000);
    const m = seg.match(/<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!m) continue;
    const url = m[1];
    const title = strip(m[2]);
    let snippet = '';
    // 优先取 b_caption 里的正文摘要；直接抓第一个 <p> 容易抓到导航栏文字
    const cap = seg.match(/<div class="b_caption"[^>]*>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/);
    if (cap) {
      snippet = strip(cap[1]);
    } else {
      const p = seg.match(/<p[^>]*>([\s\S]*?)<\/p>/);
      if (p) snippet = strip(p[1]);
    }
    if (!title || !/^https?:/i.test(url)) continue;
    out.push({ title, url, snippet: snippet.slice(0, 300) });
    if (out.length >= 5) break;
  }
  return out;
}

/* 把口语问句洗成搜索词：去掉「那/请问/帮我」这类开头和「是什么/吗」这类结尾 */
function cleanQuery(text) {
  let q = String(text || '').replace(/\s+/g, ' ').trim();
  q = q.replace(/^[\s，,。]*(那|那么|这个|那个|请问|请|帮我|帮忙|麻烦|我想|想知道|知道|问一下|一下|就是|所以)+/g, '');
  q = q.replace(/[（(][^）)]*[）)]/g, ' ');
  q = q.replace(/[？?！!。，,、~～\s]+$/g, '');
  q = q.replace(/\s+/g, ' ').trim();
  return q.slice(0, 60);
}

/* 相关性：英文词 + 中文二元组，命中太少的结果丢掉（挡掉必应的词典页/广告） */
function isRelevant(query, item) {
  const hay = (item.title + ' ' + item.snippet).toLowerCase();
  const q = String(query || '').toLowerCase();

  const latin = q.match(/[a-z0-9]{2,}/g) || [];
  const cn = q.replace(/[^\u4e00-\u9fa5]/g, '');
  const bigrams = [];
  for (let i = 0; i + 1 < cn.length; i += 1) bigrams.push(cn.slice(i, i + 2));

  if (!latin.length && !bigrams.length) return true;

  let latinHit = 0;
  for (const t of latin) if (hay.includes(t)) latinHit += 1;
  let cnHit = 0;
  for (const t of bigrams) if (hay.includes(t)) cnHit += 1;

  // 有英文实体（Claude/GPT 这类）时命中一个就够；纯中文要求命中两个中文词组
  if (latin.length) return latinHit >= 1 || cnHit >= 2;
  return cnHit >= Math.max(1, Math.min(2, bigrams.length));
}

/* 让模型把口语问题改写成搜索词（工具调用能力真正用上的地方） */
function rewriteQuery(text) {
  return new Promise((resolve) => {
    const t = String(text || '').trim();
    if (!t) { resolve(''); return; }

    ensureModel().then((model) => {
      const sys =
        '你是搜索词改写器。把用户的问题改写成 2-4 个关键词，用空格分隔，例如「GTA6 预载」。' +
        '去掉「那/请问/帮我/了吗/是什么」这类语气词和疑问结构，只留实体和关键动作；' +
        '不要加引号、不要解释、不要输出标点以外的任何内容。';
      const payload = JSON.stringify({
        model,
        messages: [
          { role: 'system', content: sys },
          { role: 'user', content: t.slice(0, 500) }
        ],
        stream: false,
        temperature: 0,
        max_tokens: 400
      });

      let base = String(cfg.baseUrl || '').trim().replace(/\/+$/, '');
      if (!/^https?:\/\//i.test(base)) base = 'http://' + base;
      const url = base.endsWith('/chat/completions') ? base : base + '/chat/completions';
      const u = new URL(url);
      const lib = u.protocol === 'http:' ? http : https;
      const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) };
      if (cfg.apiKey) headers.Authorization = 'Bearer ' + cfg.apiKey;

      const req = lib.request(
        { hostname: u.hostname, port: u.port || (u.protocol === 'http:' ? 80 : 443), path: u.pathname + u.search, method: 'POST', headers },
        (res) => {
          let buf = '';
          res.setEncoding('utf8');
          res.on('data', (d) => (buf += d));
          res.on('end', () => {
            try {
              const j = JSON.parse(buf);
              let out = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
              out = String(out).replace(/[\r\n]+/g, ' ').replace(/^["'「『]+|["'」』]+$/g, '').trim();
              // 模型偶尔会写「查询词：xxx」
              out = out.replace(/^(查询词|搜索词|关键词)[:：]\s*/, '').trim();
              resolve(out.slice(0, 40));
            } catch (e) { resolve(''); }
          });
        }
      );
      req.setTimeout(8000, () => { req.destroy(); resolve(''); });
      req.on('error', () => resolve(''));
      req.end(payload);
    }).catch(() => resolve(''));
  });
}

/* 抓网页正文：只取纯文本，供模型当证据用（相当于官方的 read_link） */
async function fetchPageText(url, limit = 1500) {
  try {
    const html = await fetchHtml(url, 8000);
    let t = String(html)
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
      .replace(/<[^>]+>/g, '\n');
    t = t
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#?[a-z0-9]+;/gi, ' ');
    return t
      .split('\n')
      .map((x) => x.trim())
      .filter((x) => x.length > 20)
      .join('\n')
      .slice(0, limit);
  } catch (e) {
    return '';
  }
}

async function searchOnce(q) {
  const url = `https://cn.bing.com/search?q=${encodeURIComponent(q)}&count=8&setlang=zh-CN`;
  try {
    return parseBing(await fetchHtml(url));
  } catch (e) {
    try {
      return parseBing(await fetchHtml(`https://www.bing.com/search?q=${encodeURIComponent(q)}&count=8`));
    } catch (e2) {
      return [];
    }
  }
}

/* 实际文字量：emoji、标点、空白都不算 */
function meaningfulChars(text) {
  const m = String(text || '').match(/[\u4e00-\u9fa5a-zA-Z0-9]/g);
  return m ? m.length : 0;
}

/* 两段文字有没有共同的实词（英文词或中文二元组） */
function sharesToken(a, b) {
  const tokensOf = (t) => {
    const out = new Set();
    for (const w of String(t).toLowerCase().match(/[a-z0-9]{2,}/g) || []) out.add(w);
    const cn = String(t).replace(/[^\u4e00-\u9fa5]/g, '');
    for (let i = 0; i + 1 < cn.length; i += 1) out.add(cn.slice(i, i + 2));
    return out;
  };
  const ta = tokensOf(a);
  const tb = tokensOf(b);
  if (!ta.size || !tb.size) return true;
  for (const t of ta) if (tb.has(t)) return true;
  return false;
}

async function webSearch(query) {
  const raw = String(query || '').trim();
  if (!raw) return [];
  // 纯 emoji / 纯标点不值得搜，模型只会编出一个不相干的词
  if (meaningfulChars(raw) < 2) return [];

  // 两个查询词一起搜：模型改写的 + 规则清洗的。
  // 只用一个词容易漏：改写过头只剩旧文，清洗不够全是噪声
  let rewritten = await rewriteQuery(raw);
  // 改写结果和原话完全不沾边（模型跑题）时丢弃，退回规则清洗
  if (rewritten && !sharesToken(rewritten, raw)) rewritten = '';
  const cleaned = cleanQuery(raw) || raw;

  const queries = [];
  if (rewritten && rewritten.length <= 40) queries.push(rewritten);
  if (!queries.includes(cleaned)) queries.push(cleaned);
  if (!queries.includes(raw) && queries.length < 2) queries.push(raw);

  const lists = await Promise.all(queries.slice(0, 2).map((q) => searchOnce(q)));
  const primaryQuery = queries[0];

  const seen = new Set();
  const results = [];
  for (const list of lists) {
    for (const r of list) {
      if (seen.has(r.url)) continue;
      seen.add(r.url);
      results.push(r);
    }
  }

  // 任意一个查询词相关就保留
  const kept = results.filter((r) => queries.some((q) => isRelevant(q, r)));

  // 官方/文档站排前面，营销站和自媒体往后放
  const official = /(^|\.)(gov|edu)\.|docs\.|developer\.|open\.bigmodel|bigmodel\.cn|zhipuai|deepmind|openai\.com|anthropic|github\.com|wikipedia|baike\.baidu/i;
  const ranked = kept
    .map((r, i) => ({ r, i, rank: official.test(r.url) ? 0 : 1 }))
    .sort((a, b) => a.rank - b.rank || a.i - b.i)
    .map((x) => x.r);

  // 前两条抓正文：只有摘要时模型答不了「现在到底发布了哪个」
  await Promise.all(
    ranked.slice(0, 2).map(async (r) => {
      const text = await fetchPageText(r.url, 1200);
      if (text) r.text = text;
    })
  );
  ranked.queryUsed = primaryQuery;
  return ranked;
}

const wantsSearch = (body) => {
  const tools = body.tools || [];
  return tools.some((t) => /search/i.test(String(t && (t.type || t.name || ''))));
};

const lastUserText = (body) => {
  const msgs = (body.messages || []).filter((m) => m.role === 'user');
  const last = msgs[msgs.length - 1];
  if (!last) return '';
  if (typeof last.content === 'string') return last.content;
  if (Array.isArray(last.content)) {
    return last.content.filter((b) => b && b.type === 'text').map((b) => b.text).join(' ');
  }
  return '';
};

function sse(res, obj) {
  res.write('data: ' + JSON.stringify(obj) + '\n\n');
}

async function handleMessages(req, res, body) {
  cors(res);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive'
  });

  const id = (global.crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now());
  const model = (await ensureModel()) || body.model || 'local-model';

  sse(res, {
    type: 'message_start',
    message: {
      id,
      model,
      usage: { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 }
    }
  });
  let blockIndex = 0;
  let thinkingOpen = false;
  let textOpen = false;
  let chars = 0;

  const openText = () => {
    if (textOpen) return;
    if (thinkingOpen) {
      sse(res, { type: 'content_block_stop', index: blockIndex });
      blockIndex += 1;
      thinkingOpen = false;
    }
    sse(res, { type: 'content_block_start', index: blockIndex, content_block: { type: 'text', text: '' } });
    textOpen = true;
  };

  // 正文一旦开始就不再回头开思考块：否则前端会「回答完又思考一遍」，
  // 而且新块会落在已被正文占用的索引上，思考内容会漏到正文里
  const openThinking = () => {
    if (thinkingOpen || textOpen) return;
    sse(res, { type: 'content_block_start', index: blockIndex, content_block: { type: 'thinking', thinking: '' } });
    thinkingOpen = true;
  };

  const emitThinking = (t) => {
    if (!t || textOpen) return;
    openThinking();
    if (!thinkingOpen) return;
    sse(res, { type: 'content_block_delta', index: blockIndex, delta: { type: 'thinking_delta', thinking: t } });
  };

  const emitText = (t) => {
    if (!t) return;
    openText();
    chars += t.length;
    sse(res, { type: 'content_block_delta', index: blockIndex, delta: { type: 'text_delta', text: t } });
  };

  // 有些模型把思考写在正文里（<think>…</think>），这里按 R1 的格式拆开：
  // 有开标签就正常进思考；只有闭合标签时，标签之前的内容是思考、之后才是回答。
  // 开局先攒一小段再判断，避免把标签的前半截当正文发出去。
  let phase = 'head'; // head=还没判定 think=思考中 text=正文
  let inlineBuf = '';
  const HEAD_LIMIT = 60;

  const feedContent = (chunk) => {
    inlineBuf += chunk;
    for (;;) {
      if (phase === 'head') {
        const open = inlineBuf.indexOf(' thinking');
        const close = inlineBuf.indexOf('</think>');
        if (open !== -1 && (close === -1 || open < close)) {
          if (open > 0) emitText(inlineBuf.slice(0, open));
          inlineBuf = inlineBuf.slice(open + 7);
          phase = 'think';
          continue;
        }
        if (close !== -1) {
          const head = inlineBuf.slice(0, close);
          if (head.trim()) emitThinking(head);
          inlineBuf = inlineBuf.slice(close + 8);
          phase = 'text';
          continue;
        }
        if (inlineBuf.length <= HEAD_LIMIT) return;
        phase = 'text';
        continue;
      }

      if (phase === 'think') {
        const close = inlineBuf.indexOf('</think>');
        if (close === -1) {
          const keep = Math.min(inlineBuf.length, 7);
          const head = inlineBuf.slice(0, inlineBuf.length - keep);
          if (head) emitThinking(head);
          inlineBuf = inlineBuf.slice(inlineBuf.length - keep);
          return;
        }
        if (close > 0) emitThinking(inlineBuf.slice(0, close));
        inlineBuf = inlineBuf.slice(close + 8);
        phase = 'text';
        continue;
      }

      // phase === 'text'：正文里再出现标签就丢掉（模型偶尔会重复吐）
      const open = inlineBuf.indexOf(' thinking');
      const close = inlineBuf.indexOf('</think>');
      let at = -1;
      if (open === -1) at = close;
      else if (close === -1) at = open;
      else at = Math.min(open, close);

      if (at === -1) {
        const keep = Math.min(inlineBuf.length, 7);
        const head = inlineBuf.slice(0, inlineBuf.length - keep);
        if (head) emitText(head);
        inlineBuf = inlineBuf.slice(inlineBuf.length - keep);
        return;
      }
      if (at > 0) emitText(inlineBuf.slice(0, at));
      inlineBuf = inlineBuf.slice(at + (inlineBuf.startsWith('</think>', at) ? 8 : 7));
    }
  };

  if (!String(cfg.baseUrl || '').trim()) {
    openText();
    sse(res, {
      type: 'content_block_delta',
      index: blockIndex,
      delta: {
        type: 'text_delta',
        text: '还没配置服务商。打开「设置 → 通用设置」，填写服务商地址（例如 http://127.0.0.1:11434/v1 或 https://api.deepseek.com）、模型和 API Key。'
      }
    });
    sse(res, { type: 'content_block_stop', index: blockIndex });
    sse(res, {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { input_tokens: 0, output_tokens: 0 }
    });
    sse(res, { type: 'message_stop' });
    res.end();
    return;
  }

  let base = String(cfg.baseUrl || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(base)) base = 'http://' + base;
  const url = base.endsWith('/chat/completions') ? base : base + '/chat/completions';

  const openaiMessages = toOpenAi(body, cfg.historyChars);

  // 导入的官网记录里角色标记很多，小模型容易照着模仿，自己在正文里写「/think」「用户:」
  const guard =
    '回答要求：只输出对用户问题的直接回答；不要输出「用户:」「助手:」「Human:」「Assistant:」这类角色标记，' +
    '不要输出 /think、/search 之类的指令，不要输出任何工具调用、<tool_use> 或 JSON 参数，不要替用户发言，也不要续写下一轮对话。';
  if (openaiMessages[0] && openaiMessages[0].role === 'system') {
    openaiMessages[0].content += '\n\n' + guard;
  } else {
    openaiMessages.unshift({ role: 'system', content: guard });
  }

  if (wantsSearch(body)) {
    try {
      const q = lastUserText(body);
      // 记录搜索词与请求尾部，便于定位「搜偏了」
      try {
        const tail = (body.messages || []).slice(-4).map((m) => m.role + ':' + String(blocksToText(m.content)).slice(0, 60));
        fs.appendFileSync(
          require('os').tmpdir() + '/ds-search.log',
          new Date().toISOString() + ' Q=' + JSON.stringify(q) + ' | tail=' + JSON.stringify(tail) + '\n'
        );
      } catch (e) { /* ignore */ }
      const results = await webSearch(q);
      if (results.length) {
        const ctx = results
          .map((r, i) => {
            const body = r.text ? `\n正文摘录：${r.text.slice(0, 900)}` : '';
            return `[${i + 1}] ${r.title}\n${r.snippet}\n来源：${r.url}${body}`;
          })
          .join('\n\n');
        // 用官方前端的 server_tool_use / web_search_tool_result 协议发「已搜索」卡片，
        // 搜索过程就会显示在回答上方，模型也不必在正文里念一遍
        const toolId = 'srvtoolu_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
        sse(res, {
          type: 'content_block_start',
          index: blockIndex,
          content_block: {
            type: 'server_tool_use',
            id: toolId,
            kind: 'search',
            name: 'deepseek_web_search',
            input: { action: 'search', queries: [results.queryUsed || cleanQuery(q) || q] }
          }
        });
        sse(res, { type: 'content_block_stop', index: blockIndex });
        blockIndex += 1;

        sse(res, {
          type: 'content_block_start',
          index: blockIndex,
          content_block: {
            type: 'web_search_tool_result',
            tool_use_id: toolId,
            kind: 'search',
            content: results.map((r) => ({
              type: 'web_search_result',
              url: r.url,
              title: r.title,
              snippet: r.snippet || null,
              site_name: null,
              site_icon: null,
              page_age: null
            }))
          }
        });
        sse(res, { type: 'content_block_stop', index: blockIndex });
        blockIndex += 1;

        // 顺序很重要：先问题、后资料。反过来（或加「【问题】」标签）模型会当成聊天记录去续写
        // 通用规则：任何问题都适用；只有涉及时效时才追加「发布/传闻」那条
        const parts = [
          '以下是刚刚联网搜索到的资料，只作为回答依据',
          '臭大肥鱼必须给出真实的答案，不准回复不知道',
          '资料里确实没提到的，就说明「资料未提及」并给出你掌握的相关信息，不要编造',
          '用到哪条就在句末标注 [1][2]'
        ];
        if (/最新|最近|发布|上线|版本|更新|今年|现在|当前|价格|多少钱/.test(String(q))) {
          parts.push('「即将发布」「首次披露」「预告」「据传」不算已发布');
          parts.push('今天是 ' + new Date().toISOString().slice(0, 10));
        }
        const block = `\n\n（${parts.join('；')}）\n${ctx}`;
        const lastUser = [...openaiMessages].reverse().find((m) => m.role === 'user');
        if (lastUser) lastUser.content = lastUser.content + block;
        else openaiMessages.push({ role: 'user', content: block.trim() });
      }
    } catch (e) { /* 搜索失败不影响对话 */ }
  }

  const payload = JSON.stringify({
    model,
    messages: openaiMessages,
    stream: true,
    temperature: 0.7
  });

  const u = new URL(url);
  const lib = u.protocol === 'http:' ? http : https;
  const headers = {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload)
  };
  if (cfg.apiKey) headers.Authorization = 'Bearer ' + cfg.apiKey;

  const upstream = lib.request(
    { hostname: u.hostname, port: u.port || (u.protocol === 'http:' ? 80 : 443), path: u.pathname + u.search, method: 'POST', headers },
    (up) => {
      if (up.statusCode !== 200) {
        let err = '';
        up.setEncoding('utf8');
        up.on('data', (d) => (err += d));
        up.on('end', () => {
          openText();
          // 图片被文本模型拒掉时，说人话，别把上游原文甩给用户
          let msg = `\n\n⚠️ 上游返回 ${up.statusCode}：${err.slice(0, 300)}`;
          if (/image input is not supported|mmproj|does not support image/i.test(err)) {
            msg = `\n\n⚠️ 当前模型 \`${cfg.model || '默认'}\` 不支持图片输入。\n\n请在设置里把模型换成多模态的（例如 \`qwen2.5vl:7b\`），再重新发送。`;
          }
          sse(res, { type: 'content_block_delta', index: blockIndex, delta: { type: 'text_delta', text: msg } });
          sse(res, { type: 'content_block_stop', index: blockIndex });
          sse(res, { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { input_tokens: 0, output_tokens: 0 } });
          sse(res, { type: 'message_stop' });
          res.end();
        });
        return;
      }

      up.setEncoding('utf8');
      let buf = '';

      up.on('data', (chunk) => {
        buf += chunk;
        const lines = buf.split('\n');
        buf = lines.pop() || '';

        for (const raw of lines) {
          const line = raw.trim();
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (data === '[DONE]') continue;
          try {
            const j = JSON.parse(data);
            const delta = j.choices && j.choices[0] && j.choices[0].delta;
            if (!delta) continue;

            const think = delta.reasoning || delta.reasoning_content || delta.thinking || '';
            if (think) emitThinking(think);

            const piece = delta.content || '';
            if (piece) feedContent(piece);
          } catch (e) { /* ignore */ }
        }
      });

      up.on('end', () => {
        if (inlineBuf) {
          if (phase === 'think') emitThinking(inlineBuf);
          else emitText(inlineBuf);
          inlineBuf = '';
        }
        if (!textOpen && !thinkingOpen) {
          openText();
        }
        sse(res, { type: 'content_block_stop', index: blockIndex });
        sse(res, {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn', stop_sequence: null },
          usage: { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: Math.ceil(chars / 2) }
        });
        sse(res, { type: 'message_stop' });
        res.end();
      });

      up.on('error', () => {
        sse(res, { type: 'message_stop' });
        res.end();
      });
    }
  );

  upstream.setTimeout(120000, () => upstream.destroy(new Error('timeout')));
  upstream.on('error', (e) => {
    openText();
    sse(res, { type: 'content_block_delta', index: blockIndex, delta: { type: 'text_delta', text: `\n\n⚠️ 连不上 ${url}：${e.message}` } });
    sse(res, { type: 'content_block_stop', index: blockIndex });
    sse(res, { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { input_tokens: 0, output_tokens: 0 } });
    sse(res, { type: 'message_stop' });
    res.end();
  });

  upstream.write(payload);
  upstream.end();
}

/** 连本地 Ollama 时，自动挑第一个已安装的模型 */
function detectOllamaModel() {
  return new Promise((resolve) => {
    const req = http.request(
      { hostname: '127.0.0.1', port: 11434, path: '/api/tags', method: 'GET', timeout: 3000 },
      (res) => {
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (d) => (buf += d));
        res.on('end', () => {
          try {
            const j = JSON.parse(buf);
            const first = (j.models || [])[0];
            resolve(first ? first.name || first.model : '');
          } catch (e) { resolve(''); }
        });
      }
    );
    req.on('error', () => resolve(''));
    req.on('timeout', () => { req.destroy(); resolve(''); });
    req.end();
  });
}

let modelPromise = null;
function ensureModel() {
  if (cfg.model) return Promise.resolve(cfg.model);
  // 还没配服务商：不探测，避免往空地址发请求
  if (!String(cfg.baseUrl || '').trim()) return Promise.resolve('');
  if (!modelPromise) {
    modelPromise = detectOllamaModel().then((m) => {
      if (m) cfg.model = m;
      return cfg.model;
    });
  }
  return modelPromise;
}

function startProxy(port, configFile) {
  loadConfig(configFile);

  // 设置里改服务商后免重启：按文件时间戳判断是否重读
  let configStamp = '';
  const syncConfig = () => {
    try {
      const st = fs.statSync(configFile);
      const stamp = st.mtimeMs + ':' + st.size;
      if (stamp === configStamp) return;
      configStamp = stamp;
      const prevBase = String(cfg.baseUrl || '');
      loadConfig(configFile);
      // 只有换了服务商地址才重新探测模型；只改模型名时保留用户填的值
      if (String(cfg.baseUrl || '') !== prevBase) {
        cfg.model = '';
        modelPromise = null;
      }
    } catch (e) { /* 配置文件还没生成，忽略 */ }
  };

  const server = http.createServer(async (req, res) => {
    cors(res);
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = (req.url || '').split('?')[0];
    if (url === '/models' || url === '/anthropic/v1/messages') syncConfig();
    fs.appendFileSync(require('os').tmpdir() + '/ds-proxy.log', new Date().toISOString() + ' ' + req.method + ' ' + url + '\n');

    if (url === '/models' && req.method === 'GET') {
      const m = await ensureModel();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ data: [{ id: m || 'local-model', object: 'model' }] }));
      return;
    }

    if (url === '/anthropic/v1/messages' && req.method === 'POST') {
      const body = await readBody(req);
      fs.appendFileSync(require('os').tmpdir() + '/ds-proxy.log', new Date().toISOString() + ' BODY ' + JSON.stringify(body).slice(0, 800) + '\n');
      handleMessages(req, res, body);
      return;
    }

    if (url === '/v1/tools/tts' && req.method === 'POST') {
      handleTts(res, await readBody(req));
      return;
    }

    if (url === '/v1/tools/asr' && req.method === 'POST') {
      asr.handleAsr(req, res, readRaw);
      return;
    }

    if (url === '/v1/tools' || url.startsWith('/anthropic/v1/files')) {
      res.writeHead(501, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: { message: '本地模型不支持该能力' } }));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: { message: 'not found' } }));
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

module.exports = { startProxy };
