#!/bin/bash

# Setup script for lang-gen
# Creates Python virtual environment and installs lark-js

set -e

echo "Setting up lang-gen environment..."

# Check if Python 3 is installed
if ! command -v python3 &> /dev/null; then
    echo "Error: Python 3 is required but not installed."
    echo "Please install Python 3 and try again."
    exit 1
fi

# Create virtual environment if it doesn't exist
if [ ! -d "venv" ]; then
    echo "Creating Python virtual environment..."
    python3 -m venv venv
else
    echo "Virtual environment already exists."
fi

# Activate virtual environment
source venv/bin/activate

# Upgrade pip
echo "Upgrading pip..."
pip install --upgrade pip --quiet

# Install lark-js
echo "Installing lark-js..."
pip install lark-js --quiet

# Verify installation
if command -v lark-js &> /dev/null; then
    echo "✓ lark-js installed successfully"
    echo "  Location: $(which lark-js)"
else
    echo "Error: lark-js installation failed"
    exit 1
fi

echo ""
echo "Setup complete! The Python environment is ready."
echo "The npm scripts will automatically use the virtual environment."
echo ""
echo "To manually activate the environment, run:"
echo "  source venv/bin/activate"