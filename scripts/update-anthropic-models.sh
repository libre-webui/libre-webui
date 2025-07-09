#!/bin/bash

# Update Anthropic models plugin
# This script updates the Anthropic plugin with the latest available models

echo "🤖 Updating Anthropic models..."

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Check if API key is set
if [ -z "$ANTHROPIC_API_KEY" ]; then
    echo -e "${RED}❌ Error: ANTHROPIC_API_KEY environment variable not set${NC}"
    exit 1
fi

# Plugin file path
PLUGIN_FILE="plugins/anthropic.json"

# Backup existing plugin file
if [ -f "$PLUGIN_FILE" ]; then
    cp "$PLUGIN_FILE" "$PLUGIN_FILE.backup"
    echo -e "${BLUE}📋 Backed up existing plugin to $PLUGIN_FILE.backup${NC}"
fi

# Anthropic now has a models API endpoint, let's use it for dynamic updates
echo -e "${BLUE}🔄 Fetching available models from Anthropic API...${NC}"

# Fetch models from Anthropic API
MODELS_JSON=$(curl -s -H "x-api-key: $ANTHROPIC_API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  "https://api.anthropic.com/v1/models")

if [ $? -ne 0 ]; then
    echo -e "${RED}❌ Failed to fetch models from API${NC}"
    exit 1
fi

# Extract model names and sort
API_MODELS=$(echo "$MODELS_JSON" | jq -r '.data[]? | .id' | sort)

# Add manually curated models that might not be in the API yet
MANUAL_MODELS="claude-4-sonnet-20250514
claude-4-opus-20250514
claude-3-7-sonnet-20250219"

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
  "id": "anthropic",
  "name": "Anthropic Claude",
  "type": "completion",
  "endpoint": "https://api.anthropic.com/v1/messages",
  "auth": {
    "header": "x-api-key",
    "prefix": "",
    "key_env": "ANTHROPIC_API_KEY"
  },
  "model_map": $MODELS_ARRAY
}
EOF

# Check if file was created successfully
if [ -f "$PLUGIN_FILE" ]; then
    echo -e "${GREEN}✅ Anthropic plugin updated successfully${NC}"
    echo -e "${BLUE}📁 Plugin file: $PLUGIN_FILE${NC}"
    
    # Show file size
    file_size=$(du -h "$PLUGIN_FILE" | cut -f1)
    echo -e "${BLUE}📊 File size: $file_size${NC}"
    
    # Count models
    model_count=$(jq -r '.model_map | length' "$PLUGIN_FILE")
    echo -e "${BLUE}🔢 Available models: $model_count${NC}"
    
    echo -e "${YELLOW}ℹ️  Models fetched from Anthropic API and manually curated list${NC}"
    echo -e "${YELLOW}ℹ️  Includes latest Claude 4 and Claude 3.7 models${NC}"
    
else
    echo -e "${RED}❌ Failed to update plugin file${NC}"
    exit 1
fi

echo -e "${GREEN}🎉 Anthropic models update completed!${NC}"
