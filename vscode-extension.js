// VSCode extension generator for DSLs
// Generates syntax highlighting from Lark grammar

import { promises as fs } from 'fs';
import { join } from 'path';
import OpenAI from 'openai';

const client = new OpenAI({});

// Generate TextMate grammar using AI
export async function generateTextMateGrammar(grammarText, languageId, languageName, spec) {
  const model = process.env.OPENAI_MODEL || 'gpt-5';
  console.error('Generating TextMate grammar for syntax highlighting...');
  
  const instructions = `You are a TextMate grammar expert.
Generate a complete TextMate grammar (JSON format) for VSCode syntax highlighting.
Output ONLY the JSON grammar, no explanations or markdown.`;
  
  const input = `Generate a TextMate grammar for this language:

Language spec: ${spec}
Language ID: ${languageId}
Language name: ${languageName}
Scope name: source.${languageId}

Lark grammar:
${grammarText}

Requirements:
- Include patterns for all tokens and keywords from the grammar
- Use standard TextMate scopes (comment.line, keyword.control, constant.numeric, string.quoted, etc.)
- Support nested patterns where appropriate
- Include repository definitions for reusable patterns
- Make sure operators, keywords, strings, numbers, comments are all properly highlighted`;
  
  try {
    const response = await client.responses.create({
      model,
      instructions,
      input,
      stream: false
    });
    
    const grammarJson = response.output_text || response.output || '{}';
    
    // Try to parse it to ensure it's valid JSON
    try {
      const parsed = JSON.parse(grammarJson);
      // Ensure required fields are present
      if (!parsed.name) parsed.name = languageName;
      if (!parsed.scopeName) parsed.scopeName = `source.${languageId}`;
      if (!parsed.patterns) parsed.patterns = [];
      return parsed;
    } catch (parseError) {
      console.error('Warning: Failed to parse generated TextMate grammar, using fallback');
      // Fall back to the simple extraction method
      return larkToTextMateBasic(grammarText, languageId, languageName);
    }
  } catch (error) {
    console.error('Warning: Failed to generate TextMate grammar:', error.message);
    // Fall back to the simple extraction method
    return larkToTextMateBasic(grammarText, languageId, languageName);
  }
}

// Basic fallback: Convert Lark grammar to TextMate grammar for VSCode syntax highlighting
function larkToTextMateBasic(grammarText, languageId, languageName) {
  // Extract tokens and rules from grammar
  const tokens = [];
  const keywords = [];
  const operators = [];
  const rules = [];
  
  // Parse token definitions
  const tokenRe = /^([A-Z_][A-Z0-9_]*)\s*:\s*(.+)$/gm;
  let match;
  
  while ((match = tokenRe.exec(grammarText))) {
    const [, name, definition] = match;
    
    // Clean up the definition
    let pattern = definition.trim();
    
    // Handle regex patterns
    if (pattern.startsWith('/') && pattern.includes('/')) {
      const endIdx = pattern.lastIndexOf('/');
      pattern = pattern.substring(1, endIdx);
      // Convert Lark regex to TextMate regex
      pattern = pattern.replace(/\\\//g, '/');
    }
    // Handle string literals
    else if (pattern.startsWith('"') || pattern.startsWith("'")) {
      const quote = pattern[0];
      pattern = pattern.slice(1, -1);
      // Escape for regex
      pattern = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
    
    tokens.push({ name, pattern });
  }
  
  // Parse rule definitions to find keywords
  const ruleRe = /^([a-z_][a-z0-9_]*)\s*:\s*(.+)$/gm;
  while ((match = ruleRe.exec(grammarText))) {
    const [, name, definition] = match;
    rules.push(name);
    
    // Extract string literals that might be keywords
    const stringRe = /"([^"]+)"|'([^']+)'/g;
    let stringMatch;
    while ((stringMatch = stringRe.exec(definition))) {
      const keyword = stringMatch[1] || stringMatch[2];
      // Check if it looks like a keyword (alphabetic)
      if (/^[a-zA-Z_]\w*$/.test(keyword)) {
        keywords.push(keyword);
      }
      // Check if it's an operator
      else if (/^[+\-*/%=<>!&|^~]+$/.test(keyword)) {
        operators.push(keyword);
      }
    }
  }
  
  // Build TextMate grammar patterns
  const patterns = [];
  
  // Comments (if grammar has comment tokens)
  const commentToken = tokens.find(t => 
    t.name.includes('COMMENT') || 
    t.pattern.includes('//') || 
    t.pattern.includes('/*')
  );
  
  if (commentToken) {
    if (commentToken.pattern.includes('//')) {
      patterns.push({
        name: 'comment.line.double-slash',
        match: '//.*$'
      });
    }
    if (commentToken.pattern.includes('/*')) {
      patterns.push({
        name: 'comment.block',
        begin: '/\\*',
        end: '\\*/'
      });
    }
  }
  
  // Numbers
  const numberToken = tokens.find(t => 
    t.name.includes('NUMBER') || 
    t.name.includes('INT') || 
    t.name.includes('FLOAT') ||
    t.pattern.includes('\\d')
  );
  
  if (numberToken) {
    patterns.push({
      name: 'constant.numeric',
      match: '\\b\\d+(\\.\\d+)?([eE][+-]?\\d+)?\\b'
    });
  }
  
  // Strings
  const stringToken = tokens.find(t => 
    t.name.includes('STRING') || 
    t.pattern.includes('"') || 
    t.pattern.includes("'")
  );
  
  if (stringToken) {
    patterns.push({
      name: 'string.quoted.double',
      begin: '"',
      end: '"',
      patterns: [{
        name: 'constant.character.escape',
        match: '\\\\.'
      }]
    });
    patterns.push({
      name: 'string.quoted.single',
      begin: "'",
      end: "'",
      patterns: [{
        name: 'constant.character.escape',
        match: '\\\\.'
      }]
    });
  }
  
  // Keywords
  if (keywords.length > 0) {
    const uniqueKeywords = [...new Set(keywords)];
    const keywordPattern = uniqueKeywords
      .map(k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('|');
    
    patterns.push({
      name: 'keyword.control',
      match: `\\b(${keywordPattern})\\b`
    });
  }
  
  // Operators
  if (operators.length > 0) {
    const uniqueOperators = [...new Set(operators)];
    const operatorPattern = uniqueOperators
      .map(o => o.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('|');
    
    patterns.push({
      name: 'keyword.operator',
      match: operatorPattern
    });
  }
  
  // Identifiers (generic)
  patterns.push({
    name: 'variable.other',
    match: '\\b[a-zA-Z_]\\w*\\b'
  });
  
  // Build the complete TextMate grammar
  const textMateGrammar = {
    name: languageName,
    scopeName: `source.${languageId}`,
    patterns: patterns,
    repository: {}
  };
  
  return textMateGrammar;
}

// Generate VSCode extension files
export async function generateVSCodeExtension(options) {
  const {
    grammarText,
    languageId,
    languageName,
    fileExtension,
    outputDir,
    description = `${languageName} language support`,
    version = '0.1.0',
    exampleProgram = '',
    interpreterPath = '',
    parserPath = '',
    spec = ''
  } = options;
  
  // Create extension directory structure
  const extDir = outputDir;  // outputDir is already the full path
  const syntaxDir = join(extDir, 'syntaxes');
  const vscodeDir = join(extDir, '.vscode');
  const examplesDir = join(extDir, 'examples');
  
  await fs.mkdir(extDir, { recursive: true });
  await fs.mkdir(syntaxDir, { recursive: true });
  await fs.mkdir(vscodeDir, { recursive: true });
  await fs.mkdir(examplesDir, { recursive: true });
  
  // Generate TextMate grammar
  const textMateGrammar = await generateTextMateGrammar(grammarText, languageId, languageName, spec);
  const grammarFile = join(syntaxDir, `${languageId}.tmLanguage.json`);
  await fs.writeFile(grammarFile, JSON.stringify(textMateGrammar, null, 2), 'utf8');
  
  // Generate package.json for the extension
  const packageJson = {
    name: `${languageId}-syntax`,
    displayName: `${languageName} Syntax`,
    description: description,
    version: version,
    publisher: 'lang-gen',
    engines: {
      vscode: '^1.74.0'
    },
    categories: ['Programming Languages'],
    contributes: {
      languages: [{
        id: languageId,
        aliases: [languageName],
        extensions: [`.${fileExtension}`],
        configuration: './language-configuration.json'
      }],
      grammars: [{
        language: languageId,
        scopeName: `source.${languageId}`,
        path: `./syntaxes/${languageId}.tmLanguage.json`
      }]
    }
  };
  
  await fs.writeFile(
    join(extDir, 'package.json'),
    JSON.stringify(packageJson, null, 2),
    'utf8'
  );
  
  // Generate language configuration
  const languageConfig = {
    comments: {
      lineComment: '//',
      blockComment: ['/*', '*/']
    },
    brackets: [
      ['{', '}'],
      ['[', ']'],
      ['(', ')']
    ],
    autoClosingPairs: [
      { open: '{', close: '}' },
      { open: '[', close: ']' },
      { open: '(', close: ')' },
      { open: '"', close: '"' },
      { open: "'", close: "'" }
    ],
    surroundingPairs: [
      { open: '{', close: '}' },
      { open: '[', close: ']' },
      { open: '(', close: ')' },
      { open: '"', close: '"' },
      { open: "'", close: "'" }
    ]
  };
  
  await fs.writeFile(
    join(extDir, 'language-configuration.json'),
    JSON.stringify(languageConfig, null, 2),
    'utf8'
  );
  
  // Generate README
  const readme = `# ${languageName} Syntax Highlighting

This extension provides syntax highlighting for ${languageName} files (\`.${fileExtension}\`).

## Features

- Syntax highlighting for ${languageName}
- Automatic bracket matching
- Comment toggling support

## Installation

1. Copy this folder to your VSCode extensions directory:
   - Windows: \`%USERPROFILE%\\.vscode\\extensions\`
   - macOS/Linux: \`~/.vscode/extensions\`
2. Restart VSCode
3. Open any \`.${fileExtension}\` file to see syntax highlighting

## Building from source

\`\`\`bash
# Package the extension
npx vsce package

# Install the generated .vsix file
code --install-extension ${languageId}-syntax-*.vsix
\`\`\`

Generated by lang-gen.
`;
  
  await fs.writeFile(join(extDir, 'README.md'), readme, 'utf8');
  
  // Generate .vscodeignore
  const vscodeignore = `
.vscode/**
.gitignore
`;
  
  await fs.writeFile(join(extDir, '.vscodeignore'), vscodeignore.trim(), 'utf8');
  
  // Generate launch.json for debugging
  const launchJson = {
    version: '0.2.0',
    configurations: [
      {
        name: 'Extension',
        type: 'extensionHost',
        request: 'launch',
        args: [
          '--extensionDevelopmentPath=${workspaceFolder}'
        ]
      }
    ]
  };
  
  await fs.writeFile(
    join(vscodeDir, 'launch.json'),
    JSON.stringify(launchJson, null, 2),
    'utf8'
  );
  
  // Save example program if provided
  let exampleFile = null;
  if (exampleProgram) {
    exampleFile = join(examplesDir, `example.${fileExtension}`);
    await fs.writeFile(exampleFile, exampleProgram, 'utf8');
    
    // Also create a test runner if we have interpreter and parser paths
    if (interpreterPath && parserPath) {
      const testRunner = `#!/usr/bin/env node
// Test runner for ${languageName} examples

import { createRequire } from 'module';
import { readFileSync } from 'fs';
import { join } from 'path';

const require = createRequire(import.meta.url);

// Load the parser and interpreter
const parserModule = require('${parserPath}');
const { makeRunner } = await import('${interpreterPath}');

const get_parser = parserModule.get_parser || parserModule.default?.get_parser;
if (!get_parser) {
  throw new Error('Parser module missing get_parser function');
}

const run = makeRunner(get_parser);

// Run the example
const examplePath = join(import.meta.dirname, 'example.${fileExtension}');
const code = readFileSync(examplePath, 'utf8');

console.log('Running example.${fileExtension}:');
console.log('---');
console.log(code);
console.log('---\n');

try {
  const result = await run(code);
  console.log('Result:', JSON.stringify(result, null, 2));
} catch (error) {
  console.error('Error:', error.message);
  process.exit(1);
}
`;
      
      await fs.writeFile(join(examplesDir, 'run.mjs'), testRunner, 'utf8');
      await fs.chmod(join(examplesDir, 'run.mjs'), 0o755);
    }
  }
  
  return {
    extensionDir: extDir,
    exampleFile,
    files: {
      packageJson: join(extDir, 'package.json'),
      grammar: grammarFile,
      languageConfig: join(extDir, 'language-configuration.json'),
      readme: join(extDir, 'README.md'),
      launchJson: join(vscodeDir, 'launch.json')
    }
  };
}