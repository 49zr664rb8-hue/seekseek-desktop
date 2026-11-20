/* 文件上传补丁：官方前端把附件 POST 到 /anthropic/v1/files，后端拿不到真实文件，
   这里在页面里直接接管：读出文件文本 → 生成一个 id → 发消息时把 document 块换成文本。 */
(function () {
  if (window.__dsFilePatch) return;
  window.__dsFilePatch = true;

  var store = {};

  function isTextLike(name, mime) {
    if (mime && /^text\//i.test(mime)) return true;
    if (/json|xml|csv|javascript/i.test(mime || '')) return true;
    return /\.(txt|md|markdown|json|csv|tsv|log|js|ts|jsx|tsx|py|java|c|h|cpp|cs|go|rs|rb|php|swift|kt|html|css|scss|xml|yml|yaml|ini|conf|cfg|sh|bat|sql)$/i.test(name || '');
  }

  var origFetch = window.fetch;
  if (!origFetch) return;

  window.fetch = function (input, init) {
    var url = typeof input === 'string' ? input : (input && input.url) || '';

    // ---- 上传：直接把文件读成文本存起来，返回一个假的 file 记录 ----
    var body = init && init.body;
    var looksLikeForm = body && typeof body.get === 'function' && typeof body.append === 'function';
    if (url.indexOf('/anthropic/v1/files') !== -1 && looksLikeForm) {
      var f = body.get('file');
      if (!f) return origFetch.apply(this, arguments);
      var id = 'file_' + Date.now() + '_' + Math.floor(Math.random() * 10000);
      var reading = isTextLike(f.name, f.type) && typeof f.text === 'function'
        ? f.text().then(function (t) { store[id] = { name: f.name, text: t }; })
        : Promise.resolve().then(function () { store[id] = { name: f.name, text: '' }; });
      return reading.then(function () {
        return new Response(JSON.stringify({
          id: id,
          type: 'file',
          filename: f.name,
          mime_type: f.type || 'application/octet-stream',
          size: f.size || 0,
          created_at: Math.floor(Date.now() / 1000)
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      });
    }

    // ---- 发送消息：把引用文件的块换成文本内容 ----
    if (url.indexOf('/anthropic/v1/messages') !== -1 && typeof body === 'string') {
      try {
        var parsed = JSON.parse(body);
        if (parsed && Array.isArray(parsed.messages)) {
          parsed.messages.forEach(function (m) {
            if (!m || !Array.isArray(m.content)) return;
            var out = [];
            m.content.forEach(function (b) {
              var fid = b && b.source && b.source.type === 'file' ? b.source.file_id : null;
              if (fid && store[fid]) {
                var rec = store[fid];
                out.push({
                  type: 'text',
                  text: rec.text
                    ? '【文件 ' + rec.name + ' 的内容】\n' + rec.text
                    : '【用户上传了文件 ' + rec.name + '，当前无法解析该格式（仅支持文本类文件）】'
                });
                return;
              }
              out.push(b);
            });
            m.content = out;
          });
          init = Object.assign({}, init, { body: JSON.stringify(parsed) });
        }
      } catch (e) { /* 解析失败就原样发出去 */ }
    }

    return origFetch.call(this, input, init);
  };
})();
