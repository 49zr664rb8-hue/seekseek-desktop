/* 文件上传补丁：官方前端把附件 POST 到 /anthropic/v1/files，后端拿不到真实文件，
   这里在页面里直接接管：文本文件读成文本，图片读成 base64，
   发消息时把 document / image 块换成模型能直接吃的内容。 */
(function () {
  if (window.__dsFilePatch) return;
  window.__dsFilePatch = true;

  var store = {};

  function isImage(mime, name) {
    if (mime && /^image\//i.test(mime)) return true;
    return /\.(png|jpe?g|gif|webp|bmp)$/i.test(name || '');
  }

  function isTextLike(name, mime) {
    if (mime && /^text\//i.test(mime)) return true;
    if (/json|xml|csv|javascript/i.test(mime || '')) return true;
    return /\.(txt|md|markdown|json|csv|tsv|log|js|ts|jsx|tsx|py|java|c|h|cpp|cs|go|rs|rb|php|swift|kt|html|css|scss|xml|yml|yaml|ini|conf|cfg|sh|bat|sql)$/i.test(name || '');
  }

  function readAsDataURL(file) {
    return new Promise(function (resolve) {
      var fr = new FileReader();
      fr.onload = function () { resolve(String(fr.result || '')); };
      fr.onerror = function () { resolve(''); };
      fr.readAsDataURL(file);
    });
  }

  var origFetch = window.fetch;
  if (!origFetch) return;

  window.fetch = function (input, init) {
    var url = typeof input === 'string' ? input : (input && input.url) || '';
    var body = init && init.body;
    var looksLikeForm = body && typeof body.get === 'function' && typeof body.append === 'function';

    // ---- 上传：文本读文本，图片读 base64，其余只记名字 ----
    if (url.indexOf('/anthropic/v1/files') !== -1 && looksLikeForm) {
      var f = body.get('file');
      if (!f) return origFetch.apply(this, arguments);
      var id = 'file_' + Date.now() + '_' + Math.floor(Math.random() * 10000);
      var reading;
      if (isImage(f.type, f.name)) {
        reading = readAsDataURL(f).then(function (dataUrl) {
          store[id] = { kind: 'image', name: f.name, mime: f.type || 'image/png', dataUrl: dataUrl };
        });
      } else if (isTextLike(f.name, f.type) && typeof f.text === 'function') {
        reading = f.text().then(function (t) {
          store[id] = { kind: 'text', name: f.name, text: t };
        });
      } else {
        reading = Promise.resolve().then(function () {
          store[id] = { kind: 'other', name: f.name };
        });
      }
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

    // ---- 发送消息：把引用文件的块换成模型能直接用的内容 ----
    if (url.indexOf('/anthropic/v1/messages') !== -1 && typeof body === 'string') {
      try {
        var parsed = JSON.parse(body);
        if (parsed && Array.isArray(parsed.messages)) {
          parsed.messages.forEach(function (m) {
            if (!m || !Array.isArray(m.content)) return;
            var out = [];
            m.content.forEach(function (b) {
              var fid = b && b.source && b.source.type === 'file' ? b.source.file_id : null;
              var rec = fid ? store[fid] : null;
              if (!rec) {
                out.push(b);
                return;
              }
              if (rec.kind === 'image' && rec.dataUrl) {
                var comma = rec.dataUrl.indexOf(',');
                out.push({
                  type: 'image',
                  source: {
                    type: 'base64',
                    media_type: rec.mime,
                    data: comma >= 0 ? rec.dataUrl.slice(comma + 1) : ''
                  }
                });
                return;
              }
              if (rec.kind === 'text') {
                out.push({ type: 'text', text: '【文件 ' + rec.name + ' 的内容】\n' + rec.text });
                return;
              }
              out.push({ type: 'text', text: '【用户上传了文件 ' + rec.name + '，当前无法解析该格式（仅支持文本和图片）】' });
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
