#!/bin/bash

# Clean Install Script for libre-webui
# This script cleans npm cache, removes package-lock files, and reinstalls dependencies

set -e  # Exit on any error

echo "🧹 Starting clean install process..."

# Function to clean and install in a directory
clean_and_install() {
    local dir=$1
    local name=$2
    
    if [ -d "$dir" ]; then
        echo "📁 Processing $name ($dir)..."
        cd "$dir"
        
        # Remove package-lock.json if it exists
        if [ -f "package-lock.json" ]; then
            echo "  🗑️  Removing package-lock.json"
            rm -f package-lock.json
        fi
        
        # Remove node_modules if it exists
        if [ -d "node_modules" ]; then
            echo "  🗑️  Removing node_modules"
            rm -rf node_modules
        fi
        
        # Clean npm cache for this directory
        echo "  🧽 Cleaning npm cache"
        npm cache clean --force
        
        # Install dependencies
        echo "  📦 Installing dependencies"
        npm install
        
        echo "  ✅ $name completed"
        cd - > /dev/null
    else
        echo "  ⚠️  Directory $dir not found, skipping $name"
    fi
}

# Get the script directory (root of the repo)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "🎯 Working in: $SCRIPT_DIR"

# Clean global npm cache first
echo "🌍 Cleaning global npm cache..."
npm cache clean --force

# Process root directory
clean_and_install "." "Root"

# Process backend directory
clean_and_install "./backend" "Backend"

# Process frontend directory
clean_and_install "./frontend" "Frontend"

echo ""
echo "🎉 Clean install process completed successfully!"
echo "🚀 All dependencies have been refreshed and updated."
