import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const hasCompiler = spawnSync('clang++', ['--version']).status === 0;

// The header lives inside the patch, so it is cut out of there and compiled on its own.
function buildDriver() {
  const patch = readFileSync(new URL('../patches/02-omnibox-keyboard-layout.patch', import.meta.url), 'utf8');
  const start = patch.indexOf('+++ b/components/omnibox/browser/keyboard_layout_fix.h');
  const header = patch.slice(start).split('\n').slice(2).map((line) => line.slice(1)).join('\n');
  const dir = mkdtempSync(join(tmpdir(), 'keyboard-layout-'));
  writeFileSync(join(dir, 'keyboard_layout_fix.h'), header);
  writeFileSync(join(dir, 'driver.cc'), `
#include "keyboard_layout_fix.h"
#include <codecvt>
#include <iostream>
#include <locale>
int main() {
  std::wstring_convert<std::codecvt_utf8_utf16<char16_t>, char16_t> utf;
  std::string line;
  while (std::getline(std::cin, line)) {
    const std::u16string text = utf.from_bytes(line);
    const auto fixed = omnibox::FixKeyboardLayout(text);
    const auto site = fixed ? omnibox::SiteInFixedText(*fixed) : std::nullopt;
    std::cout << (fixed ? utf.to_bytes(*fixed) : "-") << '\\t'
              << (fixed && omnibox::LooksLikeWords(*fixed) ? "words" : "noise") << '\\t'
              << site.value_or("-") << '\\t'
              << (omnibox::TypedTextIsWords(text) ? "words" : "noise") << '\\n';
  }
}
`);
  const binary = join(dir, 'driver');
  execFileSync('clang++', ['-std=c++20', '-Wall', '-Wextra', '-Werror', '-Wno-deprecated-declarations',
    '-o', binary, join(dir, 'driver.cc')]);
  return binary;
}

test('keyboard layout conversion', { skip: !hasCompiler && 'clang++ is not installed' }, () => {
  const binary = buildDriver();
  const run = (text) => {
    const out = execFileSync(binary, { input: `${text}\n`, encoding: 'utf8' }).trimEnd();
    const [fixed, reads, site, typed] = out.split('\t');
    return { fixed, reads, site, typed };
  };

  // Whole addresses need no history, and `/` is the full stop key.
  assert.equal(run('пщщпдуюсщь').fixed, 'google.com');
  assert.equal(run('пщщпдуюсщь').site, 'google.com');
  assert.equal(run('пщщпдуюсщь').typed, 'noise');
  assert.equal(run('пщщпдуюсщь.ьфшд').site, 'google.com/mail');
  assert.equal(run('ПЩЩПДУЮСЩЬ').site, 'google.com');

  // The start of a well-known site, but not a word that happens to convert to one.
  assert.equal(run('нщгегиу').site, 'youtube.com');
  assert.equal(run('нщгегиу').typed, 'noise');
  assert.equal(run('кув').site, 'reddit.com');
  assert.equal(run('кув').typed, 'words');
  assert.equal(run('пщ').site, '-');

  // Latin to Ukrainian offers a search, never a site.
  for (const [keys, word] of [['ghbdsn', 'привіт'], ['yjdbyb', 'новини'], ['cnhfdf', 'страва'],
    ['rjynhfrn', 'контракт'], ['nhfycgjhn', 'транспорт'], ['Gjujlf', 'погода']]) {
    const { fixed, reads, site } = run(keys);
    assert.deepEqual({ fixed, reads, site }, { fixed: word, reads: 'words', site: '-' }, keys);
  }

  // English stays out of the list.
  for (const keys of ['hello', 'world', 'music', 'youtube', 'login', 'python', 'price']) {
    assert.equal(run(keys).reads, 'noise', keys);
  }

  // Mixed text and addresses in the right layout are left alone.
  assert.equal(run('https://google.com').fixed, '-');
  assert.equal(run('googleсщь').fixed, '-');
});
