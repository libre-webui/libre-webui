#!/bin/bash

# Update Gemini models plugin
# This script updates the Gemini plugin with the latest available models

echo "🤖 Updating Gemini models..."

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Check if API key is set
if [ -z "$GEMINI_API_KEY" ]; then
    echo -e "${RED}❌ Error: GEMINI_API_KEY environment variable not set${NC}"
    exit 1
fi

# Plugin file path
PLUGIN_FILE="plugins/gemini.json"

# Backup existing plugin file
if [ -f "$PLUGIN_FILE" ]; then
    cp "$PLUGIN_FILE" "$PLUGIN_FILE.backup"
    echo -e "${BLUE}📋 Backed up existing plugin to $PLUGIN_FILE.backup${NC}"
fi

# Fetch models from Gemini API
echo -e "${BLUE}🔄 Fetching available models from Gemini API...${NC}"
MODELS_JSON=$(curl -s -H "x-goog-api-key: $GEMINI_API_KEY" "https://generativelanguage.googleapis.com/v1beta/models")

if [ $? -ne 0 ]; then
    echo -e "${RED}❌ Failed to fetch models from API${NC}"
    exit 1
fi

# Extract model names, filter out embedding models, and format for JSON
MODELS_ARRAY=$(echo "$MODELS_JSON" | jq -r '.models[].name' | grep -v "embedding" | sed 's/models\///' | sort | jq -R -s 'split("\n") | map(select(. != ""))')

if [ -z "$MODELS_ARRAY" ] || [ "$MODELS_ARRAY" = "null" ]; then
    echo -e "${RED}❌ Failed to extract models from API response${NC}"
    exit 1
fi

# Create the plugin file with dynamically fetched models
cat > "$PLUGIN_FILE" << EOF
{
  "id": "gemini",
  "name": "Google Gemini",
  "type": "completion",
  "endpoint": "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent",
  "auth": {
    "header": "x-goog-api-key",
    "prefix": "",
    "key_env": "GEMINI_API_KEY"
  },
  "model_map": $(echo "$MODELS_ARRAY")
}
EOF

# Check if file was created successfully
if [ -f "$PLUGIN_FILE" ]; then
    echo -e "${GREEN}✅ Gemini plugin updated successfully${NC}"
    echo -e "${BLUE}📁 Plugin file: $PLUGIN_FILE${NC}"
    
    # Show file size
    file_size=$(du -h "$PLUGIN_FILE" | cut -f1)
    echo -e "${BLUE}📊 File size: $file_size${NC}"
    
    # Count models
    model_count=$(grep -o '\"gemini-[^\"]*\"' "$PLUGIN_FILE" | wc -l | tr -d ' ')
    echo -e "${BLUE}🔢 Available models: $model_count${NC}"
    
else
    echo -e "${RED}❌ Failed to update plugin file${NC}"
    exit 1
fi

echo -e "${GREEN}🎉 Gemini models update completed!${NC}"
