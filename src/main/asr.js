'use strict';

/*
 * 语音识别：把前端录的 WAV 交给 Windows 自带的 System.Speech 转成文字。
 * 离线、免 Key，但依赖系统装了中文识别包
 * （注册表 HKLM\SOFTWARE\Microsoft\Speech\Recognizers\Tokens 里要有 MS-2052-80-DESK）。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

function log(msg) {
  try {
    fs.appendFileSync(path.join(os.tmpdir(), 'ds-asr.log'), new Date().toISOString() + ' ' + msg + '\n');
  } catch (e) {
    /* ignore */
  }
}

/** 从 multipart 里取出 name="file" 的那一段音频 */
function multipartFile(buf, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');
  if (!m) return null;
  const boundary = (m[1] || m[2]).trim();
  const delim = Buffer.from('--' + boundary);
  let pos = buf.indexOf(delim);
  while (pos >= 0) {
    const start = pos + delim.length;
    const next = buf.indexOf(delim, start);
    if (next < 0) break;
    const part = buf.slice(start, next);
    const sep = part.indexOf('\r\n\r\n');
    if (sep > 0) {
      const head = part.slice(0, sep).toString('utf8');
      if (/name="file"/i.test(head)) {
        let body = part.slice(sep + 4);
        if (body.length >= 2 && body[body.length - 2] === 13 && body[body.length - 1] === 10) {
          body = body.slice(0, body.length - 2);
        }
        return body;
      }
    }
    pos = next;
  }
  return null;
}

/** 用 System.Speech 识别整段 WAV，返回文字（失败返回空串） */
function transcribeWav(file) {
  return new Promise((resolve) => {
    const psFile = path.join(os.tmpdir(), 'ds-asr-' + Date.now() + '.ps1');
    const script = [
      'Add-Type -AssemblyName System.Speech',
      '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
      "  $path = '" + String(file).replace(/\//g, '\\').replace(/'/g, '') + "'",
      '  $ci = New-Object System.Globalization.CultureInfo("zh-CN")',
      '  $rec = New-Object System.Speech.Recognition.SpeechRecognitionEngine($ci)',
      '  $rec.LoadGrammar((New-Object System.Speech.Recognition.DictationGrammar))',
      '  $rec.SetInputToWaveFile($path)',
      '  $sb = New-Object System.Text.StringBuilder',
      '  while ($true) {',
      '    try { $r = $rec.Recognize() } catch { break }',
      '    if ($null -eq $r) { break }',
      '    [void]$sb.Append($r.Text)',
      '  }',
      '  $rec.Dispose()',
      '  [Console]::Out.Write($sb.ToString())',
    ].join('\r\n');

    try {
      fs.writeFileSync(psFile, script, 'utf8');
    } catch (e) {
      log('write-ps1 ' + e.message);
      resolve('');
      return;
    }

    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', psFile],
      { windowsHide: true }
    );

    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch (e) {
        /* ignore */
      }
    }, 25000);

    child.stdout.on('data', (d) => (out += d.toString('utf8')));
    child.stderr.on('data', (d) => (err += d.toString('utf8')));
    child.on('close', () => {
      clearTimeout(timer);
      try {
        fs.unlinkSync(psFile);
      } catch (e) {
        /* ignore */
      }
      if (err.trim()) log('ps-err ' + err.trim().slice(0, 300));
      resolve(out.trim());
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      log('spawn-err ' + e.message);
      resolve('');
    });
  });
}

/** 处理 POST /v1/tools/asr */
async function handleAsr(req, res, readRaw) {
  let text = '';
  try {
    const raw = await readRaw(req);
    const wav = multipartFile(raw, req.headers['content-type']);
    if (!wav || wav.length < 100) {
      log('no audio');
    } else {
      const tmp = path.join(os.tmpdir(), 'ds-asr-' + Date.now() + '.wav');
      fs.writeFileSync(tmp, wav);
      text = await transcribeWav(tmp);
      try {
        fs.unlinkSync(tmp);
      } catch (e) {
        /* ignore */
      }
      log('wav ' + wav.length + 'B -> "' + text.slice(0, 40) + '"');
    }
  } catch (e) {
    log('error ' + e.message);
  }
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ text: text }));
}

module.exports = { handleAsr, multipartFile, transcribeWav };
