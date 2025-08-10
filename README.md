# lang-gen

End-to-end DSL generator with grammar-constrained output from OpenAI.

## Features

- Generates strict-subset Lark grammars from natural language descriptions
- Compiles grammars to JavaScript parsers using lark-js
- Auto-derives AST schema from grammar structure
- Generates interpreters based on semantic descriptions
- **VSCode extension generation** with syntax highlighting
- No hardcoded language semantics - everything is generated at runtime

## Installation

```bash
# Install dependencies (this will also set up Python environment)
npm install

# The postinstall script automatically:
# 1. Creates a Python virtual environment
# 2. Installs lark-js in the venv
# 3. Verifies the installation

# If you need to manually run setup:
./setup.sh
```

### Requirements

- Node.js 18+
- Python 3 (for lark-js compiler)
- OpenAI API key

## Usage

```bash
# Basic usage
node index.js --spec "tiny calc with ints + - * / and parens" --semantics "evaluate to a number"

# With sample code to test
node index.js --spec "boolean logic with AND OR NOT" --semantics "evaluate to true/false" --sample "true AND (false OR true)"

# Read semantics from stdin
echo "compile to JavaScript code" | node index.js --spec "simple expression language"

# Specify output directory
node index.js --spec "config file format" --output ./my-dsl

# Generate VSCode extension with syntax highlighting
node index.js \
  --spec "simple config language with key=value pairs" \
  --semantics "parse into config object" \
  --vscode \
  --lang-id config \
  --lang-name "Config Language" \
  --file-ext cfg
```

### VSCode Extension Options

- `--vscode` - Enable VSCode extension generation
- `--lang-id <id>` - Language identifier (defaults to sanitized spec)
- `--lang-name <name>` - Display name (defaults to first 3 words of spec)
- `--file-ext <ext>` - File extension (defaults to first 3 chars of lang-id)

## Environment Variables

### Required
- `OPENAI_API_KEY` - Your OpenAI API key

### Optional
- `OPENAI_MODEL` - Model to use (default: gpt-5)
- `LANG_GEN_READ_CACHE` - Read from cache (default: true, set to 'false' to disable)
- `LANG_GEN_WRITE_CACHE` - Write to cache (default: true, set to 'false' to disable)
- `LANG_GEN_CACHE_DIR` - Cache directory (default: `.cache` in package directory)

### Cache Control Examples

```bash
# Disable reading from cache (always call API)
LANG_GEN_READ_CACHE=false node index.js --spec "..."

# Disable writing to cache (don't save results)
LANG_GEN_WRITE_CACHE=false node index.js --spec "..."

# Completely bypass cache
LANG_GEN_READ_CACHE=false LANG_GEN_WRITE_CACHE=false node index.js --spec "..."

# Use custom cache directory
LANG_GEN_CACHE_DIR=/tmp/lang-gen-cache node index.js --spec "..."
```

## Output Files

The generator creates the following in the output directory:

### Core Files
1. `grammar.lark` - The generated Lark grammar
2. `parser.cjs` - Compiled JavaScript parser
3. `interpreter.mjs` - Generated interpreter module

### VSCode Extension (when --vscode is used)
4. `vscode-extension/` - Complete VSCode extension
   - `package.json` - Extension manifest
   - `syntaxes/*.tmLanguage.json` - TextMate grammar for syntax highlighting
   - `language-configuration.json` - Bracket matching, comments, etc.
   - `README.md` - Extension documentation

To install the VSCode extension:
```bash
# Copy to VSCode extensions folder
cp -r output/vscode-extension ~/.vscode/extensions/my-language

# Or package and install
cd output/vscode-extension
npx vsce package
code --install-extension *.vsix
```

## Example

```bash
export OPENAI_API_KEY=your-key-here

node index.js \
  --spec "JSON-like data format with strings, numbers, booleans, arrays, and objects" \
  --semantics "parse into JavaScript objects" \
  --sample '{"name": "test", "count": 42, "active": true}' \
  --output ./json-parser
```

## How It Works

1. **Grammar Generation**: Uses OpenAI's grammar-constrained output to generate a valid Lark grammar
2. **Parser Compilation**: Compiles the grammar to a JavaScript parser using lark-js
3. **Schema Extraction**: Analyzes the grammar to extract AST node types
4. **Interpreter Generation**: Creates an interpreter based on your semantic description

The key innovation is that nothing about the language semantics is hardcoded - the entire
interpreter is generated from your description at runtime.# dsl-gen
# dsl-gen
