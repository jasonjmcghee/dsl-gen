#!/usr/bin/env node
// Standalone CLI runner for calculator language
// Usage: ./run.mjs "code" or ./run.mjs file.calc

import { createRequire } from 'module';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

const require = createRequire(import.meta.url);
const parserModule = require('./parser.cjs');
const { makeRunner } = await import('./interpreter.mjs');

const get_parser = parserModule.get_parser || parserModule.default?.get_parser;
if (!get_parser) {
  console.error('Error: Parser module missing get_parser function');
  process.exit(1);
}

const run = makeRunner(get_parser);

// Get input from command line
let input;
if (process.argv.length < 3) {
  console.error('Usage: ./run.mjs "code" or ./run.mjs file.ext');
  process.exit(1);
}

const arg = process.argv[2];
// Check if it's a file
if (existsSync(arg)) {
  input = readFileSync(arg, 'utf8');
  console.error(`Running file: ${arg}`);
} else {
  // Treat as inline code
  input = arg;
  console.error(`Running code: ${arg}`);
}

try {
  const result = await run(input);
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error('Error:', error.message);
  if (error.stack) {
    console.error(error.stack);
  }
  process.exit(1);
}
