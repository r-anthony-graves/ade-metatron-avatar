'use strict';
/* The address grammar the /def /refs /hover commands parse with. Pure
   function, tested directly -- the command branches only forward what this
   returns, so this file is where the grammar's edges live. */
const test = require('node:test');
const assert = require('node:assert/strict');
const parse = require('../lsp-address.js');

test('file:line:col parses 1-based, col defaults to 1', () => {
  assert.deepEqual(parse('adeos/api/app.py:120:15'),
                   { file: 'adeos/api/app.py', line: 120, col: 15 });
  assert.deepEqual(parse('chat.js:42'),
                   { file: 'chat.js', line: 42, col: 1 });
});

test('bare word is a symbol; a second file token scopes it', () => {
  assert.deepEqual(parse('resolve_llm'), { symbol: 'resolve_llm' });
  assert.deepEqual(parse('openChat chat.js'),
                   { symbol: 'openChat', file: 'chat.js' });
});

test('a file without a line is an error, and so is emptiness', () => {
  assert.ok(parse('adeos/api/app.py').error);
  assert.ok(parse('').error);
  assert.ok(parse('   ').error);
});

test('backslash paths still parse (this is Windows)', () => {
  assert.deepEqual(parse('adeos\\tools\\lsp.py:9'),
                   { file: 'adeos\\tools\\lsp.py', line: 9, col: 1 });
});

test('a dotted symbol is not mistaken for a file', () => {
  assert.deepEqual(parse('LspHost.definition'),
                   { symbol: 'LspHost.definition' });
});
