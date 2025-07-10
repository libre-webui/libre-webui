#!/bin/bash

# Update OpenAI models plugin
# This script updates the OpenAI plugin with the latest available models

echo "🤖 Updating OpenAI models..."

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Check if API key is set
if [ -z "$OPENAI_API_KEY" ]; then
    echo -e "${RED}❌ Error: OPENAI_API_KEY environment variable not set${NC}"
    exit 1
fi

# Plugin file path
PLUGIN_FILE="plugins/openai.json"

# Backup existing plugin file
if [ -f "$PLUGIN_FILE" ]; then
    cp "$PLUGIN_FILE" "$PLUGIN_FILE.backup"
    echo -e "${BLUE}📋 Backed up existing plugin to $PLUGIN_FILE.backup${NC}"
fi

# Fetch models from OpenAI API
echo -e "${BLUE}🔄 Fetching available models from OpenAI API...${NC}"
MODELS_JSON=$(curl -s -H "Authorization: Bearer $OPENAI_API_KEY" "https://api.openai.com/v1/models")

if [ $? -ne 0 ]; then
    echo -e "${RED}❌ Failed to fetch models from API${NC}"
    exit 1
fi

# Extract model names, filter for chat models and sort
API_MODELS=$(echo "$MODELS_JSON" | jq -r '.data[] | select(.id | test("gpt|chatgpt|o1|o3|o4")) | .id' | sort)

# Add manually curated models that might not be in the API yet
MANUAL_MODELS="o3
o3-mini
o3-2025-01-31
o3-mini-2025-01-31
o4
o4-2025-07-01
o4-mini
o4-mini-2025-07-01"

# Combine API and manual models, remove duplicates, and sort
ALL_MODELS=$(echo -e "$API_MODELS\n$MANUAL_MODELS" | sort | uniq | grep -v '^$')
MODELS_ARRAY=$(echo "$ALL_MODELS" | jq -R -s 'split("\n") | map(select(. != ""))')

if [ -z "$MODELS_ARRAY" ] || [ "$MODELS_ARRAY" = "null" ]; then
    echo -e "${RED}❌ Failed to extract models from API response${NC}"
    exit 1
fi

# Create the plugin file with dynamically fetched models
cat > "$PLUGIN_FILE" << EOF
{
  "id": "openai",
  "name": "OpenAI GPT",
  "type": "completion",
  "endpoint": "https://api.openai.com/v1/chat/completions",
  "auth": {
    "header": "Authorization",
    "prefix": "Bearer ",
    "key_env": "OPENAI_API_KEY"
  },
  "model_map": $(echo "$MODELS_ARRAY")
}
EOF

# Check if file was created successfully
if [ -f "$PLUGIN_FILE" ]; then
    echo -e "${GREEN}✅ OpenAI plugin updated successfully${NC}"
    echo -e "${BLUE}📁 Plugin file: $PLUGIN_FILE${NC}"
    
    # Show file size
    file_size=$(du -h "$PLUGIN_FILE" | cut -f1)
    echo -e "${BLUE}📊 File size: $file_size${NC}"
    
    # Count models
    model_count=$(echo "$MODELS_ARRAY" | jq length)
    echo -e "${BLUE}🔢 Available models: $model_count${NC}"
    
else
    echo -e "${RED}❌ Failed to update plugin file${NC}"
    exit 1
fi

echo -e "${GREEN}🎉 OpenAI models update completed!${NC}"
