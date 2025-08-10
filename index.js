#!/usr/bin/env node
// lang-gen - End-to-end DSL generator
//
// Pipeline:
//  1) Stream strict-subset Lark grammar from a language spec
//  2) Compile to a JS parser via lark-js
//  3) Auto-derive an AST schema from the grammar
//  4) Stream an interpreter module from semantics description + schema
//
// Usage:
//   node index.js --spec "tiny calc with ints + - * / and parens" --semantics "evaluate to a number"
//   cat semantics.txt | node index.js --spec "$(cat spec.txt)" --sample "1+2*3"
//
// Environment:
//   OPENAI_API_KEY (required)
//   OPENAI_MODEL (optional; default: gpt-5)

import OpenAI from 'openai';
import { tmpdir } from 'os';
import { join } from 'path';
import { promises as fs } from 'fs';
import { spawn } from 'child_process';
import { createRequire } from 'module';
import readline from 'readline';
import { generateVSCodeExtension } from './vscode-extension.js';
import crypto from 'crypto';

const client = new OpenAI({});

// Global sample variable to include in all prompts
let GLOBAL_SAMPLE = '';

// Cache configuration (can be overridden by environment variables)
const READ_FROM_CACHE = process.env.LANG_GEN_READ_CACHE === 'true';  // Default true, set LANG_GEN_READ_CACHE=false to disable
const WRITE_TO_CACHE = process.env.LANG_GEN_WRITE_CACHE !== 'false';  // Default true, set LANG_GEN_WRITE_CACHE=false to disable
const CACHE_DIR = process.env.LANG_GEN_CACHE_DIR || join(new URL('.', import.meta.url).pathname, '.cache');

// ---- Cache helper functions ----
async function getCacheKey(type, input) {
  const hash = crypto.createHash('sha256');
  hash.update(type);
  hash.update(JSON.stringify(input));
  return hash.digest('hex');
}

async function getCached(type, input) {
  if (!READ_FROM_CACHE) return null;
  
  try {
    await fs.mkdir(CACHE_DIR, { recursive: true });
    const key = await getCacheKey(type, input);
    const cachePath = join(CACHE_DIR, `${type}-${key}.json`);
    
    const data = await fs.readFile(cachePath, 'utf8');
    console.error(`[CACHE HIT] Using cached ${type} (key: ${key.slice(0, 8)}...)`);
    return JSON.parse(data);
  } catch {
    return null;
  }
}

async function saveCache(type, input, output) {
  if (!WRITE_TO_CACHE) return;
  
  try {
    await fs.mkdir(CACHE_DIR, { recursive: true });
    const key = await getCacheKey(type, input);
    const cachePath = join(CACHE_DIR, `${type}-${key}.json`);
    
    await fs.writeFile(cachePath, JSON.stringify({
      input,
      output,
      timestamp: new Date().toISOString()
    }, null, 2), 'utf8');
    
    console.error(`[CACHE WRITE] Saved ${type} to cache (key: ${key.slice(0, 8)}...)`);
  } catch (err) {
    console.error(`[CACHE ERROR] Failed to cache ${type}:`, err.message);
  }
}

// ---- Strict Lark subset grammar (validator) ----
// Fixed from test2.js - using common imports that work
const LARK_SUBSET_STRICT = String.raw`start: statement+

?statement: rule
          | token_rule
          | import_common
          | ignore_stmt

import_common: "%import" "common" "." NAME_UC          -> import_common
ignore_stmt: "%ignore" expansion

rule: NAME_LC ":" expansions                           -> rule
token_rule: NAME_UC ":" expansions                     -> token_rule

expansions: aliasable_expansion ("|" aliasable_expansion)*   -> alts
aliasable_expansion: expansion ("->" NAME_LC)?               -> alias
expansion: expr+                                             -> seq

?expr: atom quantifier*                                     -> quanted

quantifier: "*"
          | "+"
          | "?"
          | BOUNDED_REPEAT

?atom: NAME_LC                        -> ruleref
     | NAME_UC                        -> tokref
     | STRING                         -> literal
     | REGEXP                         -> pattern
     | "(" expansions ")"             -> group
     | "[" expansions "]"             -> opt_group
     | "{" expansions "}"             -> rep_group
     | "."                            -> any_terminal

NAME_LC: /[a-z_][a-z0-9_]*/
NAME_UC: /[A-Z_][A-Z0-9_]*/

STRING: /"([^"\\]|\\.)*"|'([^'\\]|\\.)*'/
REGEXP: /\/(?:\\\/|\\.|[^\/\n])+\/[imslux]*/
BOUNDED_REPEAT: /~(?:[0-9]+)?\.\.(?:[0-9]+)?/

%import common.WS
%import common.CPP_COMMENT
%import common.C_COMMENT
%ignore WS
%ignore CPP_COMMENT
%ignore C_COMMENT
`;

// ---- CLI argument parsing ----
function parseArgs() {
  const args = process.argv.slice(2);
  const result = { 
    spec: '', 
    semantics: '', 
    sample: '', 
    output: './output',
    vscode: false,
    languageId: '',
    languageName: '',
    fileExtension: ''
  };
  
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--spec' && i + 1 < args.length) {
      result.spec = args[++i];
    } else if (arg === '--semantics' && i + 1 < args.length) {
      result.semantics = args[++i];
    } else if (arg === '--sample' && i + 1 < args.length) {
      result.sample = args[++i];
    } else if (arg === '--output' && i + 1 < args.length) {
      result.output = args[++i];
    } else if (arg === '--vscode') {
      result.vscode = true;
    } else if (arg === '--lang-id' && i + 1 < args.length) {
      result.languageId = args[++i];
    } else if (arg === '--lang-name' && i + 1 < args.length) {
      result.languageName = args[++i];
    } else if (arg === '--file-ext' && i + 1 < args.length) {
      result.fileExtension = args[++i];
    } else if (arg === '--help' || arg === '-h') {
      console.log(`
Usage: lang-gen [options]

Options:
  --spec <description>      Language specification
  --semantics <description> Semantics description (or pipe via stdin)
  --sample <code>          Sample code to test
  --output <dir>           Output directory (default: ./output)
  
VSCode Extension Options:
  --vscode                 Generate VSCode extension
  --lang-id <id>          Language identifier (e.g., 'mylang')
  --lang-name <name>      Language display name (e.g., 'My Language')
  --file-ext <ext>        File extension (e.g., 'ml')
  
  --help                   Show this help

Environment:
  OPENAI_API_KEY          Required for API access
  OPENAI_MODEL            Model to use (default: gpt-5)

Examples:
  # Basic DSL generation
  lang-gen --spec "calculator with + - * /" --semantics "evaluate to number"
  
  # With VSCode extension
  lang-gen --spec "config language" --vscode --lang-id config --lang-name "Config" --file-ext cfg
`);
      process.exit(0);
    }
  }
  
  return result;
}

async function readStdin() {
  if (process.stdin.isTTY) return '';
  
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8').trim();
}

// ---- Step 1: Generate grammar from spec ----
async function generateGrammar(spec, maxRetries = 3) {
  // Check cache first
  const cached = await getCached('grammar', { spec });
  if (cached) {
    return cached.output;
  }
  
  let attempts = 0;
  let previousErrors = [];
  const model = process.env.OPENAI_MODEL || 'gpt-5';
  
  while (attempts < maxRetries) {
    attempts++;
    
    if (attempts > 1) {
      console.error(`\nRetry attempt ${attempts}/${maxRetries}...`);
    } else {
      console.error(`Generating grammar for: ${spec}`);
    }
    
    let instructions = `
You are a CFG designer.

Task: Output EXACTLY ONE Lark grammar that defines a context-free grammar for the language described in the input.
The output MUST conform to a strict subset of Lark (validator provided via tool):
- Only: rules/tokens, groups (), optionals [], repetitions {}, postfix + ? * and bounded repeats ~min..max.
- Only "%import common.*" and "%ignore".
- NO %declare, NO templates, NO terminal priorities.
- Regex terminals must avoid lookaround and lazy quantifiers; flags like i,m,s,l,u,x are fine.

Formatting requirements:
- Output ONLY the grammar text (no code fences, no prose).
- Provide a single entry rule named "start".
- Use lowercase names for rules, UPPERCASE for tokens.
- Include "%import common.WS" and "%ignore WS" unless whitespace is significant.
- Prefer using aliases "-> name" on meaningful alternatives to guide AST shape.

CRITICAL for operator handling:
- Define operators as separate UPPERCASE tokens (e.g., ADD_OP: "+", MUL_OP: "*")
- DO NOT use inline literals like ("+" | "-") in rules - these get discarded by the parser
- Example: Instead of: sum: product (("+" | "-") product)*
           Use: sum: product (ADD_OP product | SUB_OP product)*
                ADD_OP: "+"
                SUB_OP: "-"
- This ensures operators are preserved in the AST for the interpreter to handle

If the spec is underspecified, choose a reasonable minimal design rather than asking questions.

CRITICAL SYNTAX RULES:
- ALL string literals MUST use double quotes: "string" (NOT 'string')
- Quotes must be properly matched: "^" not "^'
- Use standard operators: "-" for negation (not "_")
- In patterns like (expr "," expr)*, use double quotes for the comma`;

    // Add sample code if provided
    if (GLOBAL_SAMPLE) {
      instructions += `\n\nEXAMPLE PROGRAM TO SUPPORT:\nThe grammar must be able to parse this example:\n${GLOBAL_SAMPLE}\nMake sure your grammar handles all the constructs shown in this example.`;
    }

    // Add previous error feedback if this is a retry
    if (previousErrors.length > 0) {
      instructions += `\n\nPREVIOUS ATTEMPTS FAILED WITH THESE ERRORS:\n`;
      previousErrors.forEach((err, i) => {
        instructions += `Attempt ${i + 1}: ${err}\n`;
      });
      instructions += `\nPlease fix these specific issues in your grammar.`;
    }
    
    try {
      const stream = await client.responses.create({
    model,
    stream: true,
    instructions,
    input: `Language description:\n${spec}${GLOBAL_SAMPLE ? `\n\nExample program that must be parseable:\n${GLOBAL_SAMPLE}` : ''}`,
    tools: [{
      type: "custom",
      name: "lark_grammar",
      description: "Emit exactly one Lark grammar (strict subset) for the described language.",
      format: {
        type: "grammar",
        syntax: "lark",
        definition: LARK_SUBSET_STRICT
      }
    }],
    tool_choice: "required"
      });

      let grammarText = '';
      let hasError = false;
      
      for await (const event of stream) {
        // Check for error events
        if (event?.error) {
          hasError = true;
          throw new Error(event.error.message || 'Grammar generation failed');
        }
        
    if (typeof event === 'string') {
      grammarText += event;
      process.stderr.write(event);
    } else if (event?.type === 'response.custom_tool_call_input.delta' && event?.delta) {
      grammarText += event.delta;
      process.stderr.write(event.delta);
    } else if (event?.custom_tool_call_input?.delta) {
      grammarText += event.custom_tool_call_input.delta;
      process.stderr.write(event.custom_tool_call_input.delta);
    } else if (event?.output_text) {
      grammarText += event.output_text;
      process.stderr.write(event.output_text);
    } else if (event?.delta?.output_text) {
      grammarText += event.delta.output_text;
      process.stderr.write(event.delta.output_text);
    }
        // Ignore done/complete events
        else if (event?.type?.includes('done') || event?.type?.includes('complete')) {
          // Status events, ignore
        }
      }
      
      process.stderr.write('\n');
      grammarText = grammarText.trim();
      
      // Validate the grammar locally
      if (grammarText) {
        // Quick syntax checks
        const syntaxErrors = [];
        
        // Check for single quotes in string literals (common error)
        const singleQuotePattern = /(?<![/])('[^']*')/g;
        const matches = grammarText.match(singleQuotePattern);
        if (matches) {
          syntaxErrors.push(`Found single quotes in grammar: ${matches.slice(0, 3).join(', ')}${matches.length > 3 ? '...' : ''}. Use double quotes instead.`);
        }
        
        // Check for mismatched quotes
        const mismatchedQuotes = /"[^"]*'(?![^"]*")|'[^']*"(?![^']*')/g;
        const mismatches = grammarText.match(mismatchedQuotes);
        if (mismatches) {
          syntaxErrors.push(`Found mismatched quotes: ${mismatches.slice(0, 3).join(', ')}`);
        }
        
        if (syntaxErrors.length > 0) {
          throw new Error(`Grammar syntax errors: ${syntaxErrors.join('; ')}`);
        }
        
        // Cache successful result
        await saveCache('grammar', { spec }, grammarText);
        return grammarText;
      } else {
        throw new Error('Generated grammar is empty');
      }
      
    } catch (error) {
      previousErrors.push(error.message);
      console.error(`\nGrammar generation error: ${error.message}`);
      
      if (attempts >= maxRetries) {
        throw new Error(`Failed to generate valid grammar after ${maxRetries} attempts. Last error: ${error.message}`);
      }
      
      // Wait a bit before retry
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
  
  throw new Error('Failed to generate grammar: max retries exceeded');
}

// ---- Step 2: Compile grammar with lark-js ----
async function compileGrammar(grammarText, outputDir, maxRetries = 3) {
  const grammarFile = join(outputDir, 'grammar.lark');
  const parserFile = join(outputDir, 'parser.cjs');
  
  await fs.mkdir(outputDir, { recursive: true });
  await fs.writeFile(grammarFile, grammarText, 'utf8');
  
  console.error(`\nCompiling grammar with lark-js...`);
  
  // Determine the path to lark-js
  // First try to use the virtual environment
  const venvPath = join(process.cwd(), 'venv', 'bin', 'lark-js');
  const packageVenvPath = join(new URL('.', import.meta.url).pathname, 'venv', 'bin', 'lark-js');
  
  let larkJsCommand = 'lark-js';
  
  // Check if we have a local venv
  try {
    await fs.access(venvPath);
    larkJsCommand = venvPath;
    console.error(`Using lark-js from virtual environment: ${venvPath}`);
  } catch {
    // Try package directory venv
    try {
      await fs.access(packageVenvPath);
      larkJsCommand = packageVenvPath;
      console.error(`Using lark-js from package venv: ${packageVenvPath}`);
    } catch {
      // Fall back to system lark-js
      console.error('Using system lark-js (may need to run setup.sh first)');
    }
  }
  
  let attempts = 0;
  let lastError = null;
  
  while (attempts < maxRetries) {
    attempts++;
    
    if (attempts > 1) {
      console.error(`\nRetrying grammar compilation (attempt ${attempts}/${maxRetries})...`);
    }
    
    try {
      const result = await new Promise((resolve, reject) => {
        let errorOutput = '';
        
        const proc = spawn(larkJsCommand, [grammarFile, '-o', parserFile], {
          stdio: ['inherit', 'inherit', 'pipe']  // Capture stderr
        });
        
        // Capture error output
        proc.stderr.on('data', (data) => {
          errorOutput += data.toString();
          process.stderr.write(data);  // Still output to console
        });
        
        proc.on('exit', async (code) => {
          if (code === 0) {
            console.error('Grammar compiled successfully');
            
            // Fix the generated parser to remove unsupported options
            try {
              let parserContent = await fs.readFile(parserFile, 'utf8');
              
              // Add filter to get_parser function to remove unsupported options
              const getParserRegex = /function get_parser\(options = \{\}\) \{[\s\S]*?return Lark\._load_from_dict\(\{ data: DATA, memo: MEMO, \.\.\.options \}\);[\s\S]*?\}/;
              const newGetParser = `function get_parser(options = {}) {
  if (
    options.transformer &&
    options.transformer.constructor.name === "object"
  ) {
    options.transformer = Transformer.fromObj(options.transformer);
  }

  // Filter out unsupported options from DATA
  const filteredData = JSON.parse(JSON.stringify(DATA));
  if (filteredData.options) {
    delete filteredData.options.strict;
    delete filteredData.options.ordered_sets;
  }

  return Lark._load_from_dict({ data: filteredData, memo: MEMO, ...options });
}`;
              
              parserContent = parserContent.replace(getParserRegex, newGetParser);
              await fs.writeFile(parserFile, parserContent, 'utf8');
              console.error('Parser fixed to remove unsupported options');
            } catch (err) {
              console.error('Warning: Could not fix parser options:', err.message);
            }
            
            resolve({ grammarFile, parserFile });
          } else {
            const error = new Error(`lark-js exited with code ${code}`);
            error.output = errorOutput;
            error.grammarText = grammarText;
            reject(error);
          }
        });
        
        proc.on('error', (err) => {
          if (err.code === 'ENOENT') {
            err.message = 'lark-js not found. Run: npm run postinstall (or ./setup.sh)';
          }
          err.grammarText = grammarText;
          reject(err);
        });
      });
      
      return result;  // Success!
      
    } catch (error) {
      lastError = error;
      
      console.error(`\n❌ Grammar compilation failed (attempt ${attempts}/${maxRetries})`);
      console.error(`Error: ${error.message}`);
      
      if (error.output) {
        console.error('\n--- Compilation Error Details ---');
        console.error(error.output);
      }
      
      if (attempts < maxRetries) {
        console.error('\n--- Original Grammar ---');
        console.error(grammarText);
        console.error('--- End Grammar ---\n');
        
        // Wait a bit before retry
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
  }
  
  // All retries exhausted
  const finalError = new Error(`Grammar compilation failed after ${maxRetries} attempts. Last error: ${lastError.message}`);
  finalError.grammarText = grammarText;
  finalError.lastError = lastError;
  throw finalError;
}

// ---- Step 3: Extract AST schema from grammar ----
function extractASTSchema(grammarText) {
  const ruleRe = /^([a-z_][a-z0-9_]*)\s*:/gm;
  const tokenRe = /^([A-Z_][A-Z0-9_]*)\s*:/gm;
  const aliasRe = /->\s*([a-z_][a-z0-9_]*)/g;
  
  const rules = new Set();
  const tokens = new Set();
  const aliases = new Set();
  
  let match;
  while ((match = ruleRe.exec(grammarText))) rules.add(match[1]);
  while ((match = tokenRe.exec(grammarText))) tokens.add(match[1]);
  while ((match = aliasRe.exec(grammarText))) aliases.add(match[1]);
  
  return {
    rules: Array.from(rules),
    tokens: Array.from(tokens),
    aliases: Array.from(aliases),
    nodeTypes: aliases.size > 0 ? Array.from(aliases) : Array.from(rules)
  };
}

// ---- Step 4: Generate example program ----
async function generateExampleProgram(spec, grammarText, semantics) {
  // Check cache first
  const cacheInput = { spec, grammarText, semantics };
  const cached = await getCached('example', cacheInput);
  if (cached) {
    return cached.output;
  }
  
  const model = process.env.OPENAI_MODEL || 'gpt-5';
  console.error(`\nGenerating example program...`);
  
  const instructions = `You are a code example writer.
Output ONLY example code that conforms to the provided grammar.
The example should demonstrate the key features of the language.${GLOBAL_SAMPLE ? `\n\nUSE THIS AS INSPIRATION:\nHere's an example of the kind of program this language should support:\n${GLOBAL_SAMPLE}` : ''}`;
  
  const input = `Given this language specification and grammar, write a good example program.

Language specification: ${spec}

Grammar:
${grammarText}

Semantics: ${semantics}

The example should be:
- Clear and well-commented (if the language supports comments)
- Demonstrate the main features
- Be relatively short but meaningful
- Include expected output or result as a comment if possible`;
  
  try {
    const stream = await client.responses.create({
      model,
      instructions,
      input,
      stream: true,
      tools: [{
        type: "custom",
        name: "example_program",
        description: "Generate an example program that conforms to the provided grammar",
        format: {
          type: "grammar",
          syntax: "lark",
          definition: grammarText
        }
      }],
      tool_choice: "required"
    });
    
    let exampleCode = '';
    
    // Process the streaming response
    for await (const event of stream) {
      // Check for error events
      if (event?.error) {
        throw new Error(event.error.message || 'Example generation failed');
      }
      
      // Extract text from various event formats
      if (typeof event === 'string') {
        exampleCode += event;
      } else if (event?.type === 'response.custom_tool_call_input.delta' && event?.delta) {
        exampleCode += event.delta;
      } else if (event?.custom_tool_call_input?.delta) {
        exampleCode += event.custom_tool_call_input.delta;
      } else if (event?.output_text) {
        exampleCode += event.output_text;
      } else if (event?.delta?.output_text) {
        exampleCode += event.delta.output_text;
      }
      // Ignore done/complete events
      else if (event?.type?.includes('done') || event?.type?.includes('complete')) {
        // Status events, ignore
      }
    }
    
    exampleCode = exampleCode.trim();
    
    // Cache successful result
    await saveCache('example', cacheInput, exampleCode);
    
    return exampleCode;
  } catch (error) {
    console.error('Warning: Failed to generate example program:', error.message);
    // Return a simple fallback example
    return `// Example program for ${spec}\n// (Auto-generation failed, using fallback)\n\n// Add your code here\n`;
  }
}

// ---- Step 5: Test and fix generated code ----
async function testGeneratedCode(parserFile, interpreterFile, sampleCode, spec, grammarText, schema, semantics, maxRetries = 3) {
  const require = createRequire(import.meta.url);
  
  // Ensure absolute paths
  const absoluteParserFile = parserFile.startsWith('/') ? parserFile : join(process.cwd(), parserFile);
  const absoluteInterpreterFile = interpreterFile.startsWith('/') ? interpreterFile : join(process.cwd(), interpreterFile);
  
  try {
    console.error(`\n--- Testing generated code ---`);
    console.error(`Test input: "${sampleCode}"`);
    
    // Clear module cache to reload fresh versions
    if (require.cache[absoluteParserFile]) {
      delete require.cache[absoluteParserFile];
    }
    
    const parserModule = require(absoluteParserFile);
    const get_parser = parserModule.get_parser || parserModule.default?.get_parser;
    
    if (!get_parser) {
      throw new Error('Parser module missing get_parser function');
    }
    
    // Clear module cache for interpreter too
    const interpreterUrl = new URL(absoluteInterpreterFile, import.meta.url).href;
    
    const { makeRunner } = await import(absoluteInterpreterFile + '?t=' + Date.now());
    const run = makeRunner(get_parser);
    const result = await run(sampleCode);
    
    console.error('✓ Test successful!');
    return { success: true, result };
    
  } catch (error) {
    console.error(`✗ Test failed: ${error.message}`);
    
    // Read the current interpreter file
    const currentInterpreterCode = await fs.readFile(absoluteInterpreterFile, 'utf8');
    
    // Prompt user for action
    console.error('\n--- Interpreter Test Failed ---');
    console.error('The generated interpreter encountered an error during testing.');
    console.error(`\nError: ${error.message}`);
    console.error(`Test input: "${sampleCode}"`);
    console.error('\nWhat would you like to do?');
    console.error('1. Provide instructions to fix the interpreter');
    console.error('2. Try automatic fix');
    console.error('3. Continue anyway (files may need manual fixes)');
    console.error('4. Abort generation');
    console.error('\nEnter your choice (1/2/3/4): ');
    
    const choice = await promptUser();
    
    if (choice === '1') {
      // Get user's fix instructions
      console.error('\nDescribe what needs to be fixed (press Enter when done):');
      const userInstructions = await promptUser();
      
      console.error('\nRegenerating interpreter with your instructions...');
      
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        console.error(`\n--- Fix attempt ${attempt}/${maxRetries} ---`);
        
        try {
          // Regenerate with user instructions
          const fixedCode = await regenerateInterpreterWithUserFix(
            grammarText,
            schema,
            semantics,
            error.message,
            sampleCode,
            currentInterpreterCode,
            userInstructions
          );
          
          // Write the fixed interpreter
          await fs.writeFile(absoluteInterpreterFile, fixedCode, 'utf8');
          console.error('Interpreter regenerated with your fixes');
          
          // Test again
          // Clear module cache
          if (require.cache[absoluteParserFile]) {
            delete require.cache[absoluteParserFile];
          }
          
          const { makeRunner: makeRunnerFixed } = await import(absoluteInterpreterFile + '?t=' + Date.now());
          const runFixed = makeRunnerFixed(get_parser);
          const resultFixed = await runFixed(sampleCode);
          
          console.error('✓ Fix successful!');
          return { success: true, result: resultFixed };
          
        } catch (fixError) {
          console.error(`✗ Fix attempt ${attempt} failed: ${fixError.message}`);
          if (attempt === maxRetries) {
            console.error('\nFix attempts exhausted. Would you like to:');
            console.error('1. Try again with different instructions');
            console.error('2. Continue anyway');
            console.error('3. Abort');
            const retryChoice = await promptUser();
            
            if (retryChoice === '1') {
              // Recursive call to try again
              return testGeneratedCode(parserFile, interpreterFile, sampleCode, spec, grammarText, schema, semantics, maxRetries);
            } else if (retryChoice === '2') {
              return { success: false, error: fixError.message, continued: true };
            } else {
              process.exit(1);
            }
          }
        }
      }
    } else if (choice === '2') {
      // Try automatic fix
      console.error('\nAttempting automatic fix...');
      
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        console.error(`\n--- Fix attempt ${attempt}/${maxRetries} ---`);
        
        try {
          // Regenerate the interpreter with error context
          const fixedCode = await regenerateInterpreterWithFix(
            grammarText, 
            schema, 
            semantics, 
            error.message,
            sampleCode
          );
          
          // Write the fixed interpreter
          await fs.writeFile(absoluteInterpreterFile, fixedCode, 'utf8');
          console.error('Interpreter regenerated with fixes');
          
          // Test again
          // Clear module cache
          if (require.cache[absoluteParserFile]) {
            delete require.cache[absoluteParserFile];
          }
          
          const { makeRunner: makeRunnerFixed } = await import(absoluteInterpreterFile + '?t=' + Date.now());
          const runFixed = makeRunnerFixed(get_parser);
          const resultFixed = await runFixed(sampleCode);
          
          console.error('✓ Fix successful!');
          return { success: true, result: resultFixed };
          
        } catch (fixError) {
          console.error(`✗ Fix attempt ${attempt} failed: ${fixError.message}`);
          if (attempt === maxRetries) {
            console.error('\nAll automatic fix attempts exhausted.');
            return { success: false, error: fixError.message };
          }
        }
      }
    } else if (choice === '3') {
      // Continue anyway
      console.error('\nContinuing with potentially broken interpreter...');
      return { success: false, error: error.message, continued: true };
    } else {
      // Abort
      console.error('\nAborting generation.');
      process.exit(1);
    }
  }
}

// Helper function to prompt user for input
async function promptUser() {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stderr
    });
    
    rl.question('', (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function regenerateInterpreterWithUserFix(grammarText, schema, semantics, errorMessage, sampleCode, currentCode, userInstructions) {
  const model = process.env.OPENAI_MODEL || 'gpt-5';
  
  const instructions = `
You write a self-contained JavaScript module that INTERPRETS programs written in a DSL.
Do NOT restate or explain anything; output ONLY code.

CRITICAL: The previous interpreter failed with this error:
${errorMessage}

When testing with sample input: "${sampleCode}"

USER'S FIX INSTRUCTIONS:
${userInstructions}

CURRENT INTERPRETER CODE THAT FAILED:
<<<CURRENT_CODE
${currentCode}
CURRENT_CODE>>>

The user has specifically requested the above fixes. Make sure to address their concerns while fixing the error.

Common issues to avoid:
- The parser may not accept options like 'strict' or 'ordered_sets' - don't pass them
- Make sure to only pass supported options to get_parser: propagate_positions, transformer, tree_class, debug
- Ensure the evaluate function handles all AST node types properly
- Token nodes have { type, value } structure
- Tree nodes have { type, children } structure
- If the grammar requires semicolons at statement end, consider auto-adding them for convenience
- The evaluate function must return the final result, not undefined

Requirements for your output:
- Define ONLY an \`evaluate(ast)\` function that interprets the AST
- DO NOT include the run function or parser setup - that's handled by the prelude
- DO NOT try to parse or call get_parser - you only work with the AST
- The evaluate function should handle all node types from the grammar
- Use the node.type field to determine which rule/alias is being evaluated
- Token nodes have { type, value } structure
- Tree nodes have { type, children } structure
- No eval(), no network, deterministic, side-effect free (unless SEMANTICS says otherwise).
- Include helpful error messages for unknown node types.

CRITICAL for handling operators:
- Operators appear as token nodes in the children array between operands
- Check token.type (not token.value) for operator tokens like ADD_OP, SUB_OP, MUL_OP, DIV_OP
- Example: For "1 + 2", the sum node will have children: [operand1, ADD_OP token, operand2]
- When processing binary operations, iterate through children finding alternating operands and operators

Keep the code idiomatic, readable, with small helpers for walking the AST.`;

  // Add sample code if provided
  if (GLOBAL_SAMPLE) {
    instructions += `\n\nEXAMPLE PROGRAM TO INTERPRET:\nYour interpreter must be able to correctly handle this example:\n${GLOBAL_SAMPLE}`;
  }

  const astNotes = {
    node_kinds: [
      "Tree nodes use rule or alias names as `type`",
      "Token leaves use `{ type: TOKEN_NAME, value: '...' }`",
      "Sequences appear as `children: [...]` in order"
    ],
    entry: "start",
    rules: schema.rules,
    tokens: schema.tokens,
    preferred_node_types: schema.nodeTypes
  };

  const prompt = `
GRAMMAR:
<<<LARK
${grammarText}
LARK>>>

AST NOTES (structure only):
${JSON.stringify(astNotes, null, 2)}

SEMANTICS (what the language should DO):
<<<SEM
${semantics}
SEM>>>

Write ONLY the evaluate function now. Output ONLY code. 
The function signature must be: function evaluate(ast) { ... }
DO NOT export anything - the prelude handles exports.
DO NOT create a run function - the prelude handles that.
Use AST node \`type\` strings from the notes above (prefer alias names if present).`;

  console.error('Requesting fixed interpreter from AI with user instructions...');
  
  const response = await client.responses.create({
    model,
    instructions,
    input: prompt,
    stream: false
  });

  // Extract the actual output text from the response
  const code = response.output_text || response.output || '';
  
  // Prelude that provides the parser integration
  const prelude = `/* PRELUDE injected by lang-gen */
export function makeRunner(get_parser) {
  const parser = get_parser({ propagate_positions: true });
  
  function treeToJSON(node) {
    if (!node) return node;
    // Token (has type and value, but not data)
    if (node && node.type && 'value' in node && !('data' in node)) {
      return { type: node.type, value: node.value };
    }
    // Tree (has data and children)
    if (node && node.data && Array.isArray(node.children)) {
      const children = node.children.map(treeToJSON).filter(x => x !== undefined);
      return { type: node.data, children };
    }
    return node;
  }
  
  return async function run(input) {
    const cst = parser.parse(input);
    const ast = treeToJSON(cst);
    // User code below will define evaluate()
    const result = await evaluate(ast);
    return result;
  }
}

/* USER CODE BELOW */
`;

  return prelude + '\n' + code;
}

async function regenerateInterpreterWithFix(grammarText, schema, semantics, errorMessage, sampleCode) {
  const model = process.env.OPENAI_MODEL || 'gpt-5';
  
  const instructions = `
You write a self-contained JavaScript module that INTERPRETS programs written in a DSL.
Do NOT restate or explain anything; output ONLY code.

CRITICAL: The previous interpreter failed with this error:
${errorMessage}

When testing with sample input: "${sampleCode}"

Common issues to avoid:
- The parser may not accept options like 'strict' or 'ordered_sets' - don't pass them
- Make sure to only pass supported options to get_parser: propagate_positions, transformer, tree_class, debug
- Ensure the evaluate function handles all AST node types properly
- Token nodes have { type, value } structure
- Tree nodes have { type, children } structure
- If the grammar requires semicolons at statement end, consider auto-adding them for convenience
- The evaluate function must return the final result, not undefined

Requirements for your output:
- Define ONLY an \`evaluate(ast)\` function that interprets the AST
- DO NOT include the run function or parser setup - that's handled by the prelude
- DO NOT try to parse or call get_parser - you only work with the AST
- The evaluate function should handle all node types from the grammar
- Use the node.type field to determine which rule/alias is being evaluated
- Token nodes have { type, value } structure
- Tree nodes have { type, children } structure
- No eval(), no network, deterministic, side-effect free (unless SEMANTICS says otherwise).
- Include helpful error messages for unknown node types.

CRITICAL for handling operators:
- Operators appear as token nodes in the children array between operands
- Check token.type (not token.value) for operator tokens like ADD_OP, SUB_OP, MUL_OP, DIV_OP
- Example: For "1 + 2", the sum node will have children: [operand1, ADD_OP token, operand2]
- When processing binary operations, iterate through children finding alternating operands and operators

Keep the code idiomatic, readable, with small helpers for walking the AST.`;

  // Add sample code if provided
  if (GLOBAL_SAMPLE) {
    instructions += `\n\nEXAMPLE PROGRAM TO INTERPRET:\nYour interpreter must be able to correctly handle this example:\n${GLOBAL_SAMPLE}`;
  }

  const astNotes = {
    node_kinds: [
      "Tree nodes use rule or alias names as `type`",
      "Token leaves use `{ type: TOKEN_NAME, value: '...' }`",
      "Sequences appear as `children: [...]` in order"
    ],
    entry: "start",
    rules: schema.rules,
    tokens: schema.tokens,
    preferred_node_types: schema.nodeTypes
  };

  const prompt = `
GRAMMAR:
<<<LARK
${grammarText}
LARK>>>

AST NOTES (structure only):
${JSON.stringify(astNotes, null, 2)}

SEMANTICS (what the language should DO):
<<<SEM
${semantics}
SEM>>>

Write ONLY the evaluate function now. Output ONLY code. 
The function signature must be: function evaluate(ast) { ... }
DO NOT export anything - the prelude handles exports.
DO NOT create a run function - the prelude handles that.
Use AST node \`type\` strings from the notes above (prefer alias names if present).`;

  console.error('Requesting fixed interpreter from AI...');
  
  const response = await client.responses.create({
    model,
    instructions,
    input: prompt,
    stream: false
  });

  // Extract the actual output text from the response
  const code = response.output_text || response.output || '';
  
  // Prelude that provides the parser integration
  const prelude = `/* PRELUDE injected by lang-gen */
export function makeRunner(get_parser) {
  const parser = get_parser({ propagate_positions: true });
  
  function treeToJSON(node) {
    if (!node) return node;
    // Token (has type and value, but not data)
    if (node && node.type && 'value' in node && !('data' in node)) {
      return { type: node.type, value: node.value };
    }
    // Tree (has data and children)
    if (node && node.data && Array.isArray(node.children)) {
      const children = node.children.map(treeToJSON).filter(x => x !== undefined);
      return { type: node.data, children };
    }
    return node;
  }
  
  return async function run(input) {
    const cst = parser.parse(input);
    const ast = treeToJSON(cst);
    // User code below will define evaluate()
    const result = await evaluate(ast);
    return result;
  }
}

/* USER CODE BELOW */
`;

  return prelude + '\n' + code;
}

// ---- Step 5: Generate interpreter ----
async function generateInterpreter(grammarText, schema, semantics) {
  // Check cache first
  const cacheInput = { grammarText, schema, semantics };
  const cached = await getCached('interpreter', cacheInput);
  if (cached) {
    return cached.output;
  }
  
  const instructions = `
You write a self-contained JavaScript module that INTERPRETS programs written in a DSL.
Do NOT restate or explain anything; output ONLY code.

Input context:
- A Lark grammar (strict subset) that defines the DSL's syntax.
- An auto-derived AST shape description.
- A SEMANTICS description that defines what programs should DO.

Requirements for your output:
- Define ONLY an \`evaluate(ast)\` function that interprets the AST
- DO NOT include the run function or parser setup - that's handled by the prelude
- DO NOT try to parse or call get_parser - you only work with the AST
- The evaluate function should handle all node types from the grammar
- Use the node.type field to determine which rule/alias is being evaluated
- Token nodes have { type, value } structure
- Tree nodes have { type, children } structure
- No eval(), no network, deterministic, side-effect free (unless SEMANTICS says otherwise).
- Include helpful error messages for unknown node types.

CRITICAL for handling operators:
- Operators appear as token nodes in the children array between operands
- Check token.type (not token.value) for operator tokens like ADD_OP, SUB_OP, MUL_OP, DIV_OP
- Example: For "1 + 2", the sum node will have children: [operand1, ADD_OP token, operand2]
- When processing binary operations, iterate through children finding alternating operands and operators

Keep the code idiomatic, readable, with small helpers for walking the AST.`;

  // Add sample code if provided
  if (GLOBAL_SAMPLE) {
    instructions += `\n\nEXAMPLE PROGRAM TO INTERPRET:\nYour interpreter must be able to correctly handle this example:\n${GLOBAL_SAMPLE}`;
  }

  const astNotes = {
    node_kinds: [
      "Tree nodes use rule or alias names as `type`",
      "Token leaves use `{ type: TOKEN_NAME, value: '...' }`",
      "Sequences appear as `children: [...]` in order"
    ],
    entry: "start",
    rules: schema.rules,
    tokens: schema.tokens,
    preferred_node_types: schema.nodeTypes
  };

  const prompt = `
GRAMMAR:
<<<LARK
${grammarText}
LARK>>>

AST NOTES (structure only):
${JSON.stringify(astNotes, null, 2)}

SEMANTICS (what the language should DO):
<<<SEM
${semantics}
SEM>>>

Write ONLY the evaluate function now. Output ONLY code. 
The function signature must be: function evaluate(ast) { ... }
DO NOT export anything - the prelude handles exports.
DO NOT create a run function - the prelude handles that.
Use AST node \`type\` strings from the notes above (prefer alias names if present).`;

  const model = process.env.OPENAI_MODEL || 'gpt-5';
  console.error(`\nGenerating interpreter...`);
  
  const response = await client.responses.create({
    model,
    instructions,
    input: prompt,
    stream: false
  });

  // Extract the actual output text from the response
  const code = response.output_text || response.output || '';
  
  // Prelude that provides the parser integration
  const prelude = `/* PRELUDE injected by lang-gen */
export function makeRunner(get_parser) {
  const parser = get_parser({ propagate_positions: true });
  
  function treeToJSON(node) {
    if (!node) return node;
    // Token (has type and value, but not data)
    if (node && node.type && 'value' in node && !('data' in node)) {
      return { type: node.type, value: node.value };
    }
    // Tree (has data and children)
    if (node && node.data && Array.isArray(node.children)) {
      const children = node.children.map(treeToJSON).filter(x => x !== undefined);
      return { type: node.data, children };
    }
    return node;
  }
  
  return async function run(input) {
    const cst = parser.parse(input);
    const ast = treeToJSON(cst);
    // User code below will define evaluate()
    const result = await evaluate(ast);
    return result;
  }
}

/* USER CODE BELOW */
`;

  const fullCode = prelude + '\n' + code;
  
  // Cache successful result
  await saveCache('interpreter', cacheInput, fullCode);
  
  return fullCode;
}

// ---- Main execution ----
async function main() {
  const args = parseArgs();
  const stdinContent = await readStdin();
  
  // Set defaults
  const spec = args.spec || 'A tiny calculator (integers, + - * /, parentheses, unary minus)';
  const semantics = args.semantics || stdinContent || 'Evaluate expressions to a number';
  const outputDir = args.output;
  
  // Set global sample for all prompts
  GLOBAL_SAMPLE = args.sample || '';
  
  if (!process.env.OPENAI_API_KEY) {
    console.error('Error: OPENAI_API_KEY environment variable is required');
    process.exit(1);
  }
  
  console.error('=== Language Generator ===');
  console.error(`Spec: ${spec}`);
  console.error(`Semantics: ${semantics}`);
  console.error(`Cache: Read=${READ_FROM_CACHE}, Write=${WRITE_TO_CACHE}\n`);
  
  try {
    // Step 1: Generate grammar
    console.error('--- Step 1: Generating Grammar ---');
    const grammarText = await generateGrammar(spec);
    
    // Step 2: Compile grammar
    console.error('\n--- Step 2: Compiling Grammar ---');
    const { grammarFile, parserFile } = await compileGrammar(grammarText, outputDir);
    
    // Step 3: Extract schema
    console.error('\n--- Step 3: Extracting AST Schema ---');
    const schema = extractASTSchema(grammarText);
    console.error(`Found ${schema.rules.length} rules, ${schema.tokens.length} tokens, ${schema.aliases.length} aliases`);
    
    // Generate VSCode extension if requested (before interpreter so we can generate example code early)
    let extResult;
    if (args.vscode) {
      console.error('\n--- Step 4: Generating VSCode Extension ---');
      
      // Auto-generate IDs if not provided
      const languageId = args.languageId || spec.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 10);
      const languageName = args.languageName || spec.split(' ').slice(0, 3).join(' ');
      const fileExtension = args.fileExtension || languageId.slice(0, 3);
      
      // Generate timestamp for unique folder name
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
      const extensionsDir = join(process.cwd(), 'extensions');
      const extensionOutputDir = join(extensionsDir, `vscode-${timestamp}`);
      
      // Generate example program
      console.error('Generating example program...');
      const exampleProgram = await generateExampleProgram(spec, grammarText, semantics);
      
      extResult = await generateVSCodeExtension({
        grammarText,
        languageId,
        languageName,
        fileExtension,
        outputDir: extensionOutputDir,
        description: `${languageName} language support (generated)`,
        exampleProgram,
        interpreterPath: join(outputDir, 'interpreter.mjs'),
        parserPath: join(outputDir, 'parser.cjs'),
        spec
      });
      
      console.error(`VSCode extension generated in ${extResult.extensionDir}`);
      console.error(`  - Press F5 in VSCode to test the extension`);
      console.error(`  - File extension: .${fileExtension}`);
      console.error(`  - Example program: ${extResult.exampleFile}`);
    }
    
    // Step 5: Generate interpreter
    console.error('\n--- Step 5: Generating Interpreter ---');
    const interpreterCode = await generateInterpreter(grammarText, schema, semantics);
    const interpreterFile = join(outputDir, 'interpreter.mjs');
    await fs.writeFile(interpreterFile, interpreterCode, 'utf8');
    console.error('Interpreter generated successfully');
    
    // Step 6: Test generated code with a default sample
    // Always test even if no sample provided to ensure the code works
    const testSample = args.sample || '1+2*3;';  // Default simple test
    console.error('\n--- Step 6: Testing Generated Code ---');
    const testResult = await testGeneratedCode(
      parserFile,
      interpreterFile,
      testSample,
      spec,
      grammarText,
      schema,
      semantics
    );
    
    if (!testResult.success) {
      if (testResult.continued) {
        console.error(`\n⚠️  Warning: Generated code failed testing but continuing as requested.`);
        console.error(`Error was: ${testResult.error}`);
        console.error('The generated files will need manual fixes.');
      } else {
        console.error(`\n⚠️  Warning: Generated code failed testing with error: ${testResult.error}`);
        console.error('The generated files may need manual fixes.');
      }
    } else {
      console.error(`\n✓ Test passed! Result: ${JSON.stringify(testResult.result)}`);
    }
    
    // Generate standalone CLI runner
    console.error('\n--- Generating CLI Runner ---');
    const runnerFile = join(outputDir, 'run.mjs');
    const runnerCode = `#!/usr/bin/env node
// Standalone CLI runner for ${spec}
// Usage: ./run.mjs "code" or ./run.mjs file.${args.fileExtension || 'txt'}

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
  console.error(\`Running file: \${arg}\`);
} else {
  // Treat as inline code
  input = arg;
  console.error(\`Running code: \${arg}\`);
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
`;
    
    await fs.writeFile(runnerFile, runnerCode, 'utf8');
    await fs.chmod(runnerFile, 0o755);
    console.error(`CLI runner generated: ${runnerFile}`);
    
    console.error(`\n✓ Generated files in ${outputDir}:`);
    console.error(`  - grammar.lark`);
    console.error(`  - parser.cjs`);
    console.error(`  - interpreter.mjs`);
    console.error(`  - run.mjs (CLI runner)`);
    if (args.vscode) {
      console.error(`  - ${extResult.extensionDir}/`);
    }
    
    console.error(`\n✓ Run your language:`);
    console.error(`  ${outputDir}/run.mjs "your code here"`);
    console.error(`  ${outputDir}/run.mjs yourfile.${args.fileExtension || 'txt'}`)
    
  } catch (error) {
    console.error('\n[ERROR]', error.message);
    if (error.stack) {
      console.error(error.stack);
    }
    process.exit(1);
  }
}

// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

// Export for programmatic use
export { generateGrammar, compileGrammar, extractASTSchema, generateInterpreter, generateVSCodeExtension, generateExampleProgram, testGeneratedCode };
