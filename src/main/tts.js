'use strict';

/**
 * 朗读（TTS）：优先用 WinRT 语音合成（能拿到 OneCore 音色，如 Microsoft Huihui），
 * 拿不到时退回 SAPI5（System.Speech）。最终统一输出
 * 24kHz / 16bit / 单声道 裸 PCM —— 与官方 /v1/tools/tts 的返回格式一致。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

/** 解析 WAV：取出采样率、位深、声道与 data 段 */
function parseWav(buf) {
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF') return null;
  let off = 12;
  let sampleRate = 0;
  let channels = 1;
  let bits = 16;
  let data = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === 'fmt ') {
      channels = buf.readUInt16LE(off + 10);
      sampleRate = buf.readUInt32LE(off + 12);
      bits = buf.readUInt16LE(off + 22);
    } else if (id === 'data') {
      data = buf.subarray(off + 8, Math.min(off + 8 + size, buf.length));
      break;
    }
    off += 8 + size + (size % 2);
  }
  if (!data || !sampleRate) return null;
  return { sampleRate, channels, bits, data };
}

/** 线性插值重采样（语音够用） */
function resample(pcm, from, to) {
  if (from === to) return pcm;
  const inN = pcm.length >> 1;
  if (!inN) return pcm;
  const outN = Math.max(1, Math.round((inN * to) / from));
  const out = Buffer.alloc(outN * 2);
  const step = from / to;
  for (let i = 0; i < outN; i += 1) {
    const pos = i * step;
    const i0 = Math.min(Math.floor(pos), inN - 1);
    const i1 = Math.min(i0 + 1, inN - 1);
    const frac = pos - i0;
    const a = pcm.readInt16LE(i0 * 2);
    const b = pcm.readInt16LE(i1 * 2);
    let v = Math.round(a + (b - a) * frac);
    if (v > 32767) v = 32767;
    if (v < -32768) v = -32768;
    out.writeInt16LE(v, i * 2);
  }
  return out;
}

/** 统一成 24kHz / 16bit / 单声道 */
function toTargetPcm(wavBuf) {
  const info = parseWav(wavBuf);
  if (!info) return null;
  if (info.bits !== 16) return null;
  let pcm = info.data;
  // 立体声取左声道
  if (info.channels === 2) {
    const n = pcm.length >> 2;
    const mono = Buffer.alloc(n * 2);
    for (let i = 0; i < n; i += 1) pcm.copy(mono, i * 2, i * 4, i * 4 + 2);
    pcm = mono;
  }
  return resample(pcm, info.sampleRate, 24000);
}

/** 去掉 markdown 标记，只读人话 */
function plainText(raw) {
  return String(raw || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/!?\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/[#*_>|~^]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function json(res, status, message) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify({ error: { message } }));
}

/** WinRT 合成脚本：按名字选 Windows 语音，选不到就退回中文音色 */
function winrtScript(outPath, voice) {
  const esc = outPath.replace(/\\/g, '\\\\').replace(/"/g, '`"');
  // PowerShell 单引号字符串里，单引号自身要写两遍
  const wanted = String(voice || '').replace(/'/g, "''");
  return [
    'Add-Type -AssemblyName System.Runtime.WindowsRuntime;',
    '[Windows.Media.SpeechSynthesis.SpeechSynthesizer, Windows.Media, ContentType=WindowsRuntime] | Out-Null;',
    '$m = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq "AsTask" -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -like "IAsyncOperation*" } | Select-Object -First 1;',
    '$reader = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), [System.Text.Encoding]::UTF8);',
    '$text = $reader.ReadToEnd();',
    '$synth = New-Object Windows.Media.SpeechSynthesis.SpeechSynthesizer;',
    '$all = [Windows.Media.SpeechSynthesis.SpeechSynthesizer]::AllVoices;',
    wanted
      ? "$v = $all | Where-Object { $_.DisplayName -eq '" + wanted + "' } | Select-Object -First 1;"
      : '$v = $null;',
    'if (-not $v) { $v = $all | Where-Object { $_.DisplayName -like "*Huihui*" } | Select-Object -First 1 };',
    'if (-not $v) { $v = $all | Where-Object { $_.Language -like "zh*" } | Select-Object -First 1 };',
    'if ($v) { $synth.Voice = $v };',
    '$op = $synth.SynthesizeTextToStreamAsync($text);',
    '$task = $m.MakeGenericMethod([Windows.Media.SpeechSynthesis.SpeechSynthesisStream]).Invoke($null, @($op));',
    '$task.Wait();',
    '$stream = $task.Result;',
    '$net = [System.IO.WindowsRuntimeStreamExtensions]::AsStreamForRead($stream);',
    '$fs = [System.IO.File]::Create("' + esc + '");',
    '$net.CopyTo($fs);',
    '$fs.Close();',
    '$synth.Dispose();'
  ].join(' ');
}

/** 兜底：SAPI5（音色少，但一定能出声） */
function sapiScript(outPath) {
  const esc = outPath.replace(/\\/g, '\\\\').replace(/"/g, '`"');
  return [
    'Add-Type -AssemblyName System.Speech;',
    '$reader = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), [System.Text.Encoding]::UTF8);',
    '$text = $reader.ReadToEnd();',
    '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer;',
    'try { $zh = $s.GetInstalledVoices() | Where-Object { $_.VoiceInfo.Culture.Name -like "zh*" } | Select-Object -First 1; if ($zh) { $s.SelectVoice($zh.VoiceInfo.Name) } } catch {};',
    '$f = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(24000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono);',
    '$s.SetOutputToWaveFile("' + esc + '", $f);',
    '$s.Speak($text);',
    '$s.Dispose();'
  ].join(' ');
}

/** 跑一次合成，回调拿到 WAV 字节 */
function synthesize(script, text, outPath, done) {
  let child;
  try {
    child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true,
      stdio: ['pipe', 'ignore', 'ignore']
    });
  } catch (e) {
    done(null);
    return;
  }
  let finished = false;
  const finish = (buf) => {
    if (finished) return;
    finished = true;
    try { fs.unlinkSync(outPath); } catch (e) { /* ignore */ }
    done(buf && buf.length ? buf : null);
  };
  child.on('error', () => finish(null));
  child.on('exit', () => {
    fs.readFile(outPath, (err, data) => finish(err ? null : data));
  });
  child.stdin.on('error', () => {});
  child.stdin.end(text, 'utf8');
}

function handleTts(res, body) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');

  let text = plainText(body && body.text);
  if (text.length > 1200) text = text.slice(0, 1200);

  if (!text) {
    json(res, 400, '没有可朗读的文本');
    return;
  }

  const stamp = Date.now() + '-' + Math.random().toString(36).slice(2, 6);
  const outA = path.join(os.tmpdir(), 'ds-tts-a-' + stamp + '.wav');
  const outB = path.join(os.tmpdir(), 'ds-tts-b-' + stamp + '.wav');
  const voice = String((body && body.voice_id) || '').trim();

  synthesize(winrtScript(outA, voice), text, outA, (wavA) => {
    const pcmA = wavA ? toTargetPcm(wavA) : null;
    if (pcmA && pcmA.length) {
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': pcmA.length,
        'Cache-Control': 'no-store'
      });
      res.end(pcmA);
      return;
    }
    // WinRT 不可用：退回 SAPI5
    synthesize(sapiScript(outB), text, outB, (wavB) => {
      const pcmB = wavB ? toTargetPcm(wavB) : null;
      if (!pcmB || !pcmB.length) {
        json(res, 500, '语音合成失败');
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': pcmB.length,
        'Cache-Control': 'no-store'
      });
      res.end(pcmB);
    });
  });
}

module.exports = { handleTts };
