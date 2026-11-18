'use strict';

/**
 * 列出 Windows 可用的语音合成音色（WinRT / OneCore）。
 * 只做枚举，不合成；合成在 tts.js 里按名字选。
 */

const { spawn } = require('child_process');

const SCRIPT = [
  '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8;',
  'try {',
  '  [Windows.Media.SpeechSynthesis.SpeechSynthesizer, Windows.Media, ContentType=WindowsRuntime] | Out-Null;',
  '  $all = [Windows.Media.SpeechSynthesis.SpeechSynthesizer]::AllVoices;',
  '  foreach ($v in $all) { Write-Output ($v.DisplayName + "|" + $v.Language + "|" + $v.Gender) }',
  '} catch { Write-Output "" }'
].join(' ');

/**
 * @returns {Promise<Array<{name: string, language: string, gender: string}>>}
 */
function listVoices() {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', SCRIPT], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore']
      });
    } catch (e) {
      resolve([]);
      return;
    }
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.on('error', () => resolve([]));
    child.on('exit', () => {
      const list = out
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.includes('|'))
        .map((line) => {
          const [name, language, gender] = line.split('|');
          return { name: name.trim(), language: (language || '').trim(), gender: (gender || '').trim() };
        })
        .filter((v) => v.name);
      resolve(list);
    });
  });
}

module.exports = { listVoices };
